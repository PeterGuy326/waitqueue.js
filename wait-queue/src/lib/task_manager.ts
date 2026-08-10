import { Context } from 'koa'
import { randomUUID } from 'crypto'
import { Redis } from 'ioredis'
import { Service } from './service'
import { TaskRun } from './task_run'
import { redisCli } from '../conf/redis'

const CLAIM_TASKS_SCRIPT = `
local maxRunning = tonumber(ARGV[1])
if not maxRunning or maxRunning <= 0 then
	return {}
end

local available = maxRunning - redis.call('HLEN', KEYS[2])
if available <= 0 then
	return {}
end

local waitingCount = redis.call('LLEN', KEYS[1])
local inspected = 0
local claimedCount = 0
local claimed = {}

while claimedCount < available and inspected < waitingCount do
	local taskId = redis.call('RPOP', KEYS[1])
	if not taskId then
		break
	end

	inspected = inspected + 1
	if redis.call('HEXISTS', KEYS[2], taskId) == 0 then
		local claimToken = ARGV[2] .. ':' .. tostring(inspected)
		redis.call('HSET', KEYS[2], taskId, claimToken)
		table.insert(claimed, taskId)
		table.insert(claimed, claimToken)
		claimedCount = claimedCount + 1
	end
end

return claimed
`

const REQUEUE_TASK_SCRIPT = `
if redis.call('HGET', KEYS[1], ARGV[1]) ~= ARGV[2] then
	return 0
end

redis.call('HDEL', KEYS[1], ARGV[1])
redis.call('LPUSH', KEYS[2], ARGV[1])
return 1
`

const RELEASE_TASKS_SCRIPT = `
local released = {}
for index = 1, #ARGV, 2 do
	local taskId = ARGV[index]
	local claimToken = ARGV[index + 1]
	if redis.call('HGET', KEYS[1], taskId) == claimToken then
		redis.call('HDEL', KEYS[1], taskId)
		table.insert(released, taskId)
	end
end
return released
`

interface TaskClaim {
	taskId: string
	claimToken: string
}

export class TaskManager extends Service {
	private url: string
	private runningKey: string // 正在执行的任务
	private waitingKey: string // 等待执行的任务
	private taskRunningCount: number // 并发执行的任务数
	private taskRunInstance: TaskRun
	private redis: Redis
	constructor(
		ctx: Context,
		queueId: number,
		namespace: string,
		url: string,
		runningKey: string,
		waitingKey: string,
		taskRunningCount: number
	) {
		super(ctx)
		this.url = url
		this.runningKey = runningKey
		this.waitingKey = waitingKey
		this.taskRunningCount = taskRunningCount
		this.taskRunInstance = new TaskRun(this.ctx, this.url, queueId, namespace)
		this.redis = redisCli.getInstance()
	}

	private async dispatchTask({ taskId, claimToken }: TaskClaim): Promise<void> {
		try {
			await this.taskRunInstance.run(taskId)
			this.selfLog('task trigger success', taskId)
		} catch (error: any) {
			this.baseLogError(`task trigger failed: ${taskId}`, error)
			try {
				const requeued = await this.redis.eval(
					REQUEUE_TASK_SCRIPT,
					2,
					this.runningKey,
					this.waitingKey,
					taskId,
					claimToken
				)
				this.selfLog(
					requeued === 1 ? 'task trigger failed; task returned to waiting queue' : 'task trigger failed; stale claim ignored',
					taskId
				)
			} catch (redisError) {
				this.baseLogError(`failed to return task to waiting queue: ${taskId}`, redisError)
			}
		}
	}

	/**
	 * 原子地从等待队列领取最多 maxRunning 个任务，并立即登记到运行集合。
	 * 领取和占位在同一个 Redis 脚本中完成，避免多个进程或重叠 cron 同时突破并发上限。
	 */
	private async claimTasks(maxRunning: number): Promise<TaskClaim[]> {
		const result = await this.redis.eval(
			CLAIM_TASKS_SCRIPT,
			2,
			this.waitingKey,
			this.runningKey,
			maxRunning,
			randomUUID()
		)
		if (!Array.isArray(result)) return []

		const claims: TaskClaim[] = []
		for (let index = 0; index + 1 < result.length; index += 2) {
			claims.push({ taskId: String(result[index]), claimToken: String(result[index + 1]) })
		}
		return claims
	}

	private async releaseTasks(taskSnapshot: Record<string, string>, taskIds: string[]): Promise<string[]> {
		const claimPairs = [...new Set(taskIds)].flatMap((taskId) =>
			taskSnapshot[taskId] === undefined ? [] : [taskId, taskSnapshot[taskId]]
		)
		if (!claimPairs.length) return []

		const result = await this.redis.eval(RELEASE_TASKS_SCRIPT, 1, this.runningKey, ...claimPairs)
		return Array.isArray(result) ? result.map(String) : []
	}

	async runTask(): Promise<void> {
		const taskRunningCount = Math.floor(Number(this.taskRunningCount))
		this.selfLog(`runTask: same time run task max number: ${taskRunningCount}`)
		if (!Number.isFinite(taskRunningCount) || taskRunningCount <= 0) {
			this.selfLog(`runTask: invalid max running task count: ${this.taskRunningCount}`)
			return
		}

		try {
			const claims = await this.claimTasks(taskRunningCount)
			this.selfLog(`runTask: claimed task count: ${claims.length}`)
			await Promise.all(
				claims.map((claim) => {
					this.selfLog('runTask: prepare exec task', claim.taskId)
					return this.dispatchTask(claim)
				})
			)
		} catch (err: any) {
			this.baseLogError('runTask: failed to claim or dispatch tasks', err)
		}
	}

	/**
	 * 对执行中任务进行检测
	 * 如果数据库中为已完成，则直接在 runningKey 中剔除
	 * 剩余任务，获取目标任务状态，更新数据库任务状态，并对已完成的在 runningKey 中剔除
	 */
	async checkTaskStatus(): Promise<void> {
		this.selfLog('CheckStatus: check task status start')
		const taskMap = await this.redis.hgetall(this.runningKey)
		const taskIds = Object.keys(taskMap)
		this.selfLog('CheckStatus: 正在执行中的任务 id ', taskIds.join(','))
		const completeIds = await this.taskRunInstance.checkTaskStatus(
			taskIds.filter((item) => {
				return item !== ''
			})
		)
		const releasedIds = await this.releaseTasks(taskMap, completeIds)
		if (releasedIds.length) {
			this.selfLog('CheckStatus: 从 runningkey 中移除的已完成任务 id ', releasedIds.join(','))
		}
	}

	/**
	 * 让长时间未结束的任务结束掉
	 * 各 task_run 中自己决定哪些任务为超时任务，并进行关闭
	 * 此时可以不用过分关注，数据库已完成，但是依然在 runningKey 中的， checkTaskStatus 中会进行处理
	 */
	async expireTask(): Promise<void> {
		this.selfLog('ExpireTask: expire task status start')
		const taskMap = await this.redis.hgetall(this.runningKey)

		const expiredIds = await this.taskRunInstance.expireTasks()
		this.selfLog('ExpireTask: 任务实际过期任务 id 列表 ', expiredIds.join(','))

		// 获取实际已过期但是仍然在缓存执行队列中的任务 id
		const releasedIds = await this.releaseTasks(taskMap, expiredIds)
		if (releasedIds.length) {
			this.selfLog('ExpireTask: 从 runningkey 中移除的过期任务 id ', releasedIds.join(','))
		}
	}

	selfLog(message: string, taskId?: string): void {
		this.baseLogInfo(`${this.url}${'|taskId: ' + taskId}|${message}`)
	}
}
