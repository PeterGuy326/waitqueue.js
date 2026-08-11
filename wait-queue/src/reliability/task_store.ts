import { randomUUID } from 'node:crypto'
import { Redis } from 'ioredis'
import {
	getClaimLeaseKey,
	getDeadLetterKey,
	getDeadLetterOrderKey,
	getEnqueuedAtKey,
	getRetryCountKey,
	getRetryScheduleKey,
	getRetryTokenKey,
	getReliabilityMigrationKey,
	getReliabilityMigrationWaitingKey,
	getRunningKey,
	getRunningAuditCursorKey,
	getTaskGenerationKey,
	getTaskStateKey,
	getWaitingKey,
} from '../common/cache'
import { DEFAULT_RELIABILITY_CONFIG, ReliabilityConfig } from './config'

const MAX_TRANSITIONS_PER_TICK = 1_000

const ENQUEUE_TASK_SCRIPT = `
local function nowMs(override)
	if override ~= '' then return tonumber(override) end
	local redisTime = redis.call('TIME')
	return tonumber(redisTime[1]) * 1000 + math.floor(tonumber(redisTime[2]) / 1000)
end
if redis.call('HEXISTS', KEYS[2], ARGV[1]) == 1 or redis.call('HEXISTS', KEYS[5], ARGV[1]) == 1 then
	return 0
end
-- LPOS is confined to the bounded legacy migration window. Steady-state
-- enqueue remains O(1) through taskStateHashKv.
if redis.call('GET', KEYS[6]) ~= 'complete'
	and (redis.call('LPOS', KEYS[1], ARGV[1]) or redis.call('LPOS', KEYS[7], ARGV[1])) then
	return 0
end
if redis.call('HSETNX', KEYS[2], ARGV[1], 'waiting') == 0 then
	return 0
end
redis.call('HSET', KEYS[3], ARGV[1], nowMs(ARGV[3]))
redis.call('HSET', KEYS[4], ARGV[1], ARGV[2])
redis.call('LPUSH', KEYS[1], ARGV[1])
return 1
`

const CLAIM_TASKS_SCRIPT = `
local function nowMs(override)
	if override ~= '' then return tonumber(override) end
	local redisTime = redis.call('TIME')
	return tonumber(redisTime[1]) * 1000 + math.floor(tonumber(redisTime[2]) / 1000)
end
local maxRunning = tonumber(ARGV[1])
local tokenPrefix = ARGV[2]
local now = nowMs(ARGV[3])
local leaseMs = tonumber(ARGV[4])
local maxRetries = tonumber(ARGV[5])
local retryBaseDelayMs = tonumber(ARGV[6])
local retryMaxDelayMs = tonumber(ARGV[7])
local transitionLimit = tonumber(ARGV[8])

local function retryDelay(retryCount)
	local delay = retryBaseDelayMs
	local remaining = retryCount - 1
	while remaining > 0 and delay < retryMaxDelayMs do
		delay = math.min(retryMaxDelayMs, delay * 2)
		remaining = remaining - 1
	end
	return delay
end

local function scheduleFailure(taskId, claimToken, reason)
	local retryCount = tonumber(redis.call('HGET', KEYS[5], taskId) or '0')
	if retryCount >= maxRetries then
		redis.call('ZREM', KEYS[4], taskId)
		redis.call('HDEL', KEYS[6], taskId)
		redis.call('HSET', KEYS[7], taskId, cjson.encode({
			entryId = redis.call('HGET', KEYS[11], taskId) or claimToken,
			retryCount = retryCount,
			failedAt = now,
			reason = reason,
			token = claimToken
		}))
		redis.call('ZADD', KEYS[8], now, taskId)
		redis.call('HSET', KEYS[10], taskId, 'dead')
		redis.call('HDEL', KEYS[9], taskId)
		return {'dead', retryCount, 0}
	end

	retryCount = redis.call('HINCRBY', KEYS[5], taskId, 1)
	local dueAt = now + retryDelay(retryCount)
	redis.call('ZADD', KEYS[4], dueAt, taskId)
	redis.call('HSET', KEYS[6], taskId, claimToken)
	redis.call('HSET', KEYS[10], taskId, 'retry')
	return {'retry', retryCount, dueAt}
end

-- Migrate legacy waiting entries in bounded batches while preserving FIFO order.
-- New arrivals stay at the left of the source list; claims consume the oldest
-- already-migrated entries from the right of the temporary list.
local migrationState = redis.call('GET', KEYS[12])
if migrationState ~= 'complete' then
	redis.call('SET', KEYS[12], 'in-progress')
	for migrationIndex = 1, transitionLimit do
		local taskId = redis.call('RPOP', KEYS[1])
		if not taskId then break end
		redis.call('LPUSH', KEYS[13], taskId)
		redis.call('HSETNX', KEYS[10], taskId, 'waiting')
		redis.call('HSETNX', KEYS[9], taskId, now)
		redis.call('HSETNX', KEYS[11], taskId, 'legacy:' .. tokenPrefix .. ':waiting:' .. tostring(migrationIndex))
	end
	if redis.call('LLEN', KEYS[1]) == 0 then
		if redis.call('EXISTS', KEYS[13]) == 1 then
			redis.call('RENAME', KEYS[13], KEYS[1])
		end
		redis.call('SET', KEYS[12], 'complete')
		migrationState = 'complete'
	else
		migrationState = 'in-progress'
	end
end

-- Bounded HSCAN continuously catches pre-lease claims and best-effort late raw
-- claims during deployment. Mixed-version schedulers remain unsupported.
-- Acknowledged claims are never reclaimed solely because the task is long-running.
local auditCursor = redis.call('GET', KEYS[14]) or '0'
local auditResult = redis.call('HSCAN', KEYS[2], auditCursor, 'COUNT', 100)
redis.call('SET', KEYS[14], auditResult[1])
local auditedClaims = auditResult[2]
for auditIndex = 1, #auditedClaims, 2 do
	local taskId = auditedClaims[auditIndex]
	local claimToken = auditedClaims[auditIndex + 1]
	local state = redis.call('HGET', KEYS[10], taskId)
	if redis.call('HEXISTS', KEYS[11], taskId) == 0 then
		redis.call('HSET', KEYS[11], taskId, 'legacy:' .. tokenPrefix .. ':running:' .. tostring(auditIndex))
	end
	if state == 'acknowledged' or string.sub(claimToken, 1, 4) == 'ack:' then
		redis.call('HSET', KEYS[10], taskId, 'acknowledged')
		redis.call('ZREM', KEYS[3], taskId)
	elseif not state or state == 'waiting' or state == 'pending' then
		redis.call('HSET', KEYS[10], taskId, 'pending')
		if not redis.call('ZSCORE', KEYS[3], taskId) then
			redis.call('ZADD', KEYS[3], now + leaseMs, taskId)
		end
	end
end

local recoveredCount = 0
local recoveredToDeadCount = 0
local expiredTaskIds = redis.call('ZRANGEBYSCORE', KEYS[3], '-inf', now, 'LIMIT', 0, transitionLimit)
for _, taskId in ipairs(expiredTaskIds) do
	local claimToken = redis.call('HGET', KEYS[2], taskId)
	if claimToken and redis.call('HGET', KEYS[10], taskId) == 'pending' then
		redis.call('HDEL', KEYS[2], taskId)
		local transition = scheduleFailure(taskId, claimToken, 'lease_expired')
		recoveredCount = recoveredCount + 1
		if transition[1] == 'dead' then
			recoveredToDeadCount = recoveredToDeadCount + 1
		end
	end
	redis.call('ZREM', KEYS[3], taskId)
end

local promotedCount = 0
local dueTaskIds = redis.call('ZRANGEBYSCORE', KEYS[4], '-inf', now, 'LIMIT', 0, transitionLimit)
for _, taskId in ipairs(dueTaskIds) do
	redis.call('ZREM', KEYS[4], taskId)
	if redis.call('HGET', KEYS[10], taskId) == 'retry' and redis.call('HEXISTS', KEYS[2], taskId) == 0 then
		redis.call('LPUSH', KEYS[1], taskId)
		redis.call('HSET', KEYS[10], taskId, 'waiting')
		promotedCount = promotedCount + 1
	else
		redis.call('HDEL', KEYS[6], taskId)
	end
end

local claimed = {recoveredCount, promotedCount, recoveredToDeadCount}
if not maxRunning or maxRunning <= 0 then
	return claimed
end

local available = maxRunning - redis.call('HLEN', KEYS[2])
if available <= 0 then
	return claimed
end

local claimSource = migrationState == 'in-progress' and KEYS[13] or KEYS[1]
local waitingCount = redis.call('LLEN', claimSource)
local inspected = 0
local claimedCount = 0
while claimedCount < available and inspected < waitingCount do
	local taskId = redis.call('RPOP', claimSource)
	if not taskId then
		break
	end
	inspected = inspected + 1
	local state = redis.call('HGET', KEYS[10], taskId)
	if (not state or state == 'waiting') and redis.call('HEXISTS', KEYS[2], taskId) == 0 then
		local claimToken = 'pending:' .. tokenPrefix .. ':' .. tostring(inspected)
		if redis.call('HEXISTS', KEYS[11], taskId) == 0 then
			redis.call('HSET', KEYS[11], taskId, 'legacy:' .. tokenPrefix .. ':' .. tostring(inspected))
		end
		redis.call('HSET', KEYS[2], taskId, claimToken)
		redis.call('ZADD', KEYS[3], now + leaseMs, taskId)
		redis.call('HSET', KEYS[10], taskId, 'pending')
		redis.call('HDEL', KEYS[6], taskId)
		table.insert(claimed, taskId)
		table.insert(claimed, claimToken)
		claimedCount = claimedCount + 1
	end
end

return claimed
`

const ACKNOWLEDGE_TASK_SCRIPT = `
if redis.call('HGET', KEYS[1], ARGV[1]) ~= ARGV[2] then
	return 0
end
local acknowledgedToken = 'ack:' .. string.sub(ARGV[2], 9)
redis.call('HSET', KEYS[1], ARGV[1], acknowledgedToken)
redis.call('ZREM', KEYS[2], ARGV[1])
redis.call('HSET', KEYS[3], ARGV[1], 'acknowledged')
return 1
`

const FAIL_TASK_SCRIPT = `
local function nowMs(override)
	if override ~= '' then return tonumber(override) end
	local redisTime = redis.call('TIME')
	return tonumber(redisTime[1]) * 1000 + math.floor(tonumber(redisTime[2]) / 1000)
end
if redis.call('HGET', KEYS[1], ARGV[1]) ~= ARGV[2] then
	return {'stale', 0, 0}
end

local now = nowMs(ARGV[3])
local maxRetries = tonumber(ARGV[4])
local retryBaseDelayMs = tonumber(ARGV[5])
local retryMaxDelayMs = tonumber(ARGV[6])

local function retryDelay(retryCount)
	local delay = retryBaseDelayMs
	local remaining = retryCount - 1
	while remaining > 0 and delay < retryMaxDelayMs do
		delay = math.min(retryMaxDelayMs, delay * 2)
		remaining = remaining - 1
	end
	return delay
end

redis.call('HDEL', KEYS[1], ARGV[1])
redis.call('ZREM', KEYS[2], ARGV[1])
local retryCount = tonumber(redis.call('HGET', KEYS[4], ARGV[1]) or '0')
if retryCount >= maxRetries then
	redis.call('ZREM', KEYS[3], ARGV[1])
	redis.call('HDEL', KEYS[5], ARGV[1])
	redis.call('HSET', KEYS[6], ARGV[1], cjson.encode({
		entryId = redis.call('HGET', KEYS[10], ARGV[1]) or ARGV[2],
		retryCount = retryCount,
		failedAt = now,
		reason = ARGV[7],
		token = ARGV[2]
	}))
	redis.call('ZADD', KEYS[7], now, ARGV[1])
	redis.call('HSET', KEYS[9], ARGV[1], 'dead')
	redis.call('HDEL', KEYS[8], ARGV[1])
	return {'dead', retryCount, 0}
end

retryCount = redis.call('HINCRBY', KEYS[4], ARGV[1], 1)
local dueAt = now + retryDelay(retryCount)
redis.call('ZADD', KEYS[3], dueAt, ARGV[1])
redis.call('HSET', KEYS[5], ARGV[1], ARGV[2])
redis.call('HSET', KEYS[9], ARGV[1], 'retry')
return {'retry', retryCount, dueAt}
`

const RELEASE_TASKS_SCRIPT = `
local released = {}

local function cleanup(taskId)
	redis.call('HDEL', KEYS[2], taskId)
	redis.call('ZREM', KEYS[3], taskId)
	redis.call('ZREM', KEYS[4], taskId)
	redis.call('HDEL', KEYS[5], taskId)
	redis.call('HDEL', KEYS[6], taskId)
	redis.call('HDEL', KEYS[7], taskId)
	redis.call('ZREM', KEYS[8], taskId)
	redis.call('LREM', KEYS[1], 0, taskId)
	redis.call('LREM', KEYS[13], 0, taskId)
	redis.call('HDEL', KEYS[9], taskId)
	redis.call('HDEL', KEYS[10], taskId)
	redis.call('HDEL', KEYS[11], taskId)
end

for index = 1, #ARGV, 2 do
	local taskId = ARGV[index]
	local claimToken = ARGV[index + 1]
	local matches = redis.call('HGET', KEYS[2], taskId) == claimToken
	if not matches then
		matches = redis.call('HGET', KEYS[6], taskId) == claimToken
	end
	if not matches then
		local deadLetter = redis.call('HGET', KEYS[7], taskId)
		if deadLetter then
			local decodedOk, decoded = pcall(cjson.decode, deadLetter)
			matches = decodedOk and decoded.token == claimToken
		end
	end
	if matches then
		cleanup(taskId)
		table.insert(released, taskId)
	end
end
return released
`

const REPLAY_DEAD_LETTER_SCRIPT = `
local function nowMs(override)
	if override ~= '' then return tonumber(override) end
	local redisTime = redis.call('TIME')
	return tonumber(redisTime[1]) * 1000 + math.floor(tonumber(redisTime[2]) / 1000)
end
local taskId = ARGV[1]
local deadLetter = redis.call('HGET', KEYS[7], taskId)
if not deadLetter then
	return 0
end
local state = redis.call('HGET', KEYS[10], taskId)
if state and state ~= 'dead' then
	return -1
end
if redis.call('HEXISTS', KEYS[2], taskId) == 1 or redis.call('ZSCORE', KEYS[4], taskId) then
	return -1
end
local decodedOk, decoded = pcall(cjson.decode, deadLetter)
if not decodedOk or decoded.entryId ~= ARGV[2] then
	return -2
end

redis.call('HDEL', KEYS[2], taskId)
redis.call('ZREM', KEYS[3], taskId)
redis.call('ZREM', KEYS[4], taskId)
redis.call('HDEL', KEYS[5], taskId)
redis.call('HDEL', KEYS[6], taskId)
redis.call('HDEL', KEYS[7], taskId)
redis.call('ZREM', KEYS[8], taskId)
redis.call('LREM', KEYS[1], 0, taskId)
redis.call('LREM', KEYS[13], 0, taskId)
redis.call('HSET', KEYS[9], taskId, nowMs(ARGV[4]))
redis.call('HSET', KEYS[10], taskId, 'waiting')
redis.call('HSET', KEYS[11], taskId, ARGV[3])
redis.call('LPUSH', KEYS[1], taskId)
return 1
`

export interface TaskClaim {
	taskId: string
	claimToken: string
}

export interface ClaimBatch {
	claims: TaskClaim[]
	recovered: number
	promoted: number
	deadLettered: number
}

export type FailureReason = 'callback_failed' | 'lease_expired'
export type FailureOutcome = 'retry' | 'dead' | 'stale'

export interface FailureTransition {
	outcome: FailureOutcome
	retryCount: number
	dueAt?: number
}

export interface DeadLetterItem {
	entryId: string
	taskId: string
	retryCount: number
	failedAt: string
	reason: FailureReason
}

export interface DeadLetterPage {
	total: number
	offset: number
	limit: number
	items: DeadLetterItem[]
}

export interface QueueTaskKeys {
	waiting: string
	running: string
	leases: string
	retrySchedule: string
	retryCount: string
	retryToken: string
	deadLetters: string
	deadLetterOrder: string
	enqueuedAt: string
	state: string
	generation: string
	migration: string
	migrationWaiting: string
	runningAuditCursor: string
}

function asString(value: unknown): string {
	return Buffer.isBuffer(value) ? value.toString('utf8') : String(value)
}

function asArray(value: unknown): unknown[] {
	return Array.isArray(value) ? value : []
}

function finiteInteger(value: unknown): number {
	const parsed = Number(asString(value))
	return Number.isSafeInteger(parsed) ? parsed : 0
}

export class RedisTaskStore {
	readonly keys: QueueTaskKeys

	constructor(
		private readonly redis: Redis,
		namespace: string,
		queueId: number,
		private readonly reliability: ReliabilityConfig = DEFAULT_RELIABILITY_CONFIG,
		private readonly clock?: () => number,
		private readonly tokenFactory: () => string = randomUUID
	) {
		this.keys = Object.freeze({
			waiting: getWaitingKey(namespace, queueId),
			running: getRunningKey(namespace, queueId),
			leases: getClaimLeaseKey(namespace, queueId),
			retrySchedule: getRetryScheduleKey(namespace, queueId),
			retryCount: getRetryCountKey(namespace, queueId),
			retryToken: getRetryTokenKey(namespace, queueId),
			deadLetters: getDeadLetterKey(namespace, queueId),
			deadLetterOrder: getDeadLetterOrderKey(namespace, queueId),
			enqueuedAt: getEnqueuedAtKey(namespace, queueId),
			state: getTaskStateKey(namespace, queueId),
			generation: getTaskGenerationKey(namespace, queueId),
			migration: getReliabilityMigrationKey(namespace, queueId),
			migrationWaiting: getReliabilityMigrationWaitingKey(namespace, queueId),
			runningAuditCursor: getRunningAuditCursorKey(namespace, queueId),
		})
	}

	private nowArgument(): number | string {
		if (!this.clock) return ''
		const value = Math.floor(this.clock())
		if (!Number.isSafeInteger(value) || value < 0) throw new Error('task store clock returned an invalid timestamp')
		return value
	}

	private allKeys(): string[] {
		return [
			this.keys.waiting,
			this.keys.running,
			this.keys.leases,
			this.keys.retrySchedule,
			this.keys.retryCount,
			this.keys.retryToken,
			this.keys.deadLetters,
			this.keys.deadLetterOrder,
			this.keys.enqueuedAt,
			this.keys.state,
			this.keys.generation,
			this.keys.migration,
			this.keys.migrationWaiting,
			this.keys.runningAuditCursor,
		]
	}

	async enqueue(taskId: string): Promise<boolean> {
		const result = await this.redis.eval(
			ENQUEUE_TASK_SCRIPT,
			7,
			this.keys.waiting,
			this.keys.state,
			this.keys.enqueuedAt,
			this.keys.generation,
			this.keys.running,
			this.keys.migration,
			this.keys.migrationWaiting,
			taskId,
			this.tokenFactory(),
			this.nowArgument()
		)
		return Number(result) === 1
	}

	async claim(maxRunning: number): Promise<ClaimBatch> {
		const result = asArray(
			await this.redis.eval(
				CLAIM_TASKS_SCRIPT,
				this.allKeys().length,
				...this.allKeys(),
				maxRunning,
				this.tokenFactory(),
				this.nowArgument(),
				this.reliability.claimLeaseMs,
				this.reliability.maxRetries,
				this.reliability.retryBaseDelayMs,
				this.reliability.retryMaxDelayMs,
				MAX_TRANSITIONS_PER_TICK
			)
		)
		const claims: TaskClaim[] = []
		for (let index = 3; index + 1 < result.length; index += 2) {
			claims.push({ taskId: asString(result[index]), claimToken: asString(result[index + 1]) })
		}
		return {
			claims,
			recovered: finiteInteger(result[0]),
			promoted: finiteInteger(result[1]),
			deadLettered: finiteInteger(result[2]),
		}
	}

	async acknowledge(claim: TaskClaim): Promise<boolean> {
		const result = await this.redis.eval(
			ACKNOWLEDGE_TASK_SCRIPT,
			3,
			this.keys.running,
			this.keys.leases,
			this.keys.state,
			claim.taskId,
			claim.claimToken
		)
		return Number(result) === 1
	}

	async fail(claim: TaskClaim, reason: FailureReason = 'callback_failed'): Promise<FailureTransition> {
		const result = asArray(
			await this.redis.eval(
				FAIL_TASK_SCRIPT,
				10,
				this.keys.running,
				this.keys.leases,
				this.keys.retrySchedule,
				this.keys.retryCount,
				this.keys.retryToken,
				this.keys.deadLetters,
				this.keys.deadLetterOrder,
				this.keys.enqueuedAt,
				this.keys.state,
				this.keys.generation,
				claim.taskId,
				claim.claimToken,
				this.nowArgument(),
				this.reliability.maxRetries,
				this.reliability.retryBaseDelayMs,
				this.reliability.retryMaxDelayMs,
				reason
			)
		)
		const outcome = asString(result[0]) as FailureOutcome
		const dueAt = finiteInteger(result[2])
		return {
			outcome: outcome === 'retry' || outcome === 'dead' ? outcome : 'stale',
			retryCount: finiteInteger(result[1]),
			...(dueAt > 0 ? { dueAt } : {}),
		}
	}

	async runningSnapshot(): Promise<Record<string, string>> {
		return this.redis.hgetall(this.keys.running)
	}

	async release(taskSnapshot: Record<string, string>, taskIds: string[]): Promise<string[]> {
		const claimPairs = [...new Set(taskIds)].flatMap((taskId) =>
			taskSnapshot[taskId] === undefined ? [] : [taskId, taskSnapshot[taskId]]
		)
		if (!claimPairs.length) return []
		const result = await this.redis.eval(
			RELEASE_TASKS_SCRIPT,
			this.allKeys().length,
			...this.allKeys(),
			...claimPairs
		)
		return asArray(result).map(asString)
	}

	async listDeadLetters(offset: number, limit: number): Promise<DeadLetterPage> {
		const taskIds = await this.redis.zrevrange(
			this.keys.deadLetterOrder,
			offset,
			offset + limit - 1
		)
		const total = await this.redis.zcard(this.keys.deadLetterOrder)
		if (!taskIds.length) return { total, offset, limit, items: [] }
		const metadata = await this.redis.hmget(this.keys.deadLetters, ...taskIds)
		const items: DeadLetterItem[] = []
		for (let index = 0; index < taskIds.length; index += 1) {
			const raw = metadata[index]
			if (!raw) continue
			try {
				const parsed = JSON.parse(raw) as Record<string, unknown>
				const failedAt = Number(parsed.failedAt)
				const retryCount = Number(parsed.retryCount)
				const reason = parsed.reason
				const entryId = parsed.entryId
				if (
					typeof entryId !== 'string' ||
					entryId.length === 0 ||
					!Number.isSafeInteger(failedAt) ||
					failedAt < 0 ||
					!Number.isSafeInteger(retryCount) ||
					retryCount < 0 ||
					(reason !== 'callback_failed' && reason !== 'lease_expired')
				) {
					continue
				}
				items.push({
					entryId,
					taskId: taskIds[index],
					retryCount,
					failedAt: new Date(failedAt).toISOString(),
					reason,
				})
			} catch {
				// Corrupt metadata is omitted instead of exposing raw Redis values.
			}
		}
		return { total, offset, limit, items }
	}

	async replayDeadLetter(
		taskId: string,
		entryId: string
	): Promise<'replayed' | 'missing' | 'conflict' | 'stale'> {
		const result = await this.redis.eval(
			REPLAY_DEAD_LETTER_SCRIPT,
			this.allKeys().length,
			...this.allKeys(),
			taskId,
			entryId,
			this.tokenFactory(),
			this.nowArgument()
		)
		if (Number(result) === 1) return 'replayed'
		if (Number(result) === -1) return 'conflict'
		if (Number(result) === -2) return 'stale'
		return 'missing'
	}
}
