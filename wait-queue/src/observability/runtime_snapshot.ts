import { Redis } from 'ioredis'
import {
	getDeadLetterOrderKey,
	getEnqueuedAtKey,
	getReliabilityMigrationWaitingKey,
	getRetryScheduleKey,
	getRunningKey,
	getWaitingKey,
} from '../common/cache'

export interface RuntimeQueueIdentity {
	id: number
	namespace: string
}

export interface QueueRuntimeSnapshot {
	queueId: number
	namespace: string
	waiting: number
	running: number
	retrying: number
	deadLetters: number
	oldestWaitingAt: string | null
	oldestWaitingAgeSeconds: number | null
}

export type RuntimeSnapshotReader = (
	queues: readonly RuntimeQueueIdentity[]
) => Promise<QueueRuntimeSnapshot[]>

type PipelineResult = [Error | null, unknown] | undefined

function pipelineValue(result: PipelineResult): unknown {
	if (!result) throw new Error('redis pipeline returned an incomplete result')
	const [error, value] = result
	if (error) throw error
	return value
}

function pipelineCount(result: PipelineResult): number {
	const count = Number(pipelineValue(result))
	if (!Number.isSafeInteger(count) || count < 0) {
		throw new Error('redis pipeline returned an invalid count')
	}
	return count
}

function optionalString(result: PipelineResult): string | undefined {
	const value = pipelineValue(result)
	if (value === null || value === undefined) return undefined
	return Buffer.isBuffer(value) ? value.toString('utf8') : String(value)
}

function oldestWaiting(
	enqueuedAt: unknown,
	now: number
): Pick<QueueRuntimeSnapshot, 'oldestWaitingAt' | 'oldestWaitingAgeSeconds'> {
	if (enqueuedAt === null || enqueuedAt === undefined) {
		return { oldestWaitingAt: null, oldestWaitingAgeSeconds: null }
	}
	const timestamp = Number(Buffer.isBuffer(enqueuedAt) ? enqueuedAt.toString('utf8') : enqueuedAt)
	const date = new Date(timestamp)
	if (!Number.isSafeInteger(timestamp) || timestamp < 0 || Number.isNaN(date.valueOf())) {
		return { oldestWaitingAt: null, oldestWaitingAgeSeconds: null }
	}
	return {
		oldestWaitingAt: date.toISOString(),
		oldestWaitingAgeSeconds: Math.floor(Math.max(now - timestamp, 0) / 1000),
	}
}

/**
 * Reads a bounded, task-id-free runtime snapshot. Waiting is the sum of the
 * steady-state FIFO and the temporary FIFO used by the bounded legacy migration.
 * The oldest item is always at the right side of those lists, so this remains
 * O(queue count) instead of scanning every waiting task.
 */
export async function readQueueRuntimeSnapshots(
	redis: Redis,
	queues: readonly RuntimeQueueIdentity[],
	clock: () => number = Date.now
): Promise<QueueRuntimeSnapshot[]> {
	if (!queues.length) return []

	const pipeline = redis.pipeline()
	for (const queue of queues) {
		pipeline.llen(getWaitingKey(queue.namespace, queue.id))
		pipeline.llen(getReliabilityMigrationWaitingKey(queue.namespace, queue.id))
		pipeline.hlen(getRunningKey(queue.namespace, queue.id))
		pipeline.zcard(getRetryScheduleKey(queue.namespace, queue.id))
		pipeline.zcard(getDeadLetterOrderKey(queue.namespace, queue.id))
		pipeline.lindex(getWaitingKey(queue.namespace, queue.id), -1)
		pipeline.lindex(getReliabilityMigrationWaitingKey(queue.namespace, queue.id), -1)
	}

	const counts = await pipeline.exec()
	if (!counts) throw new Error('redis pipeline did not return a result')

	const oldestTaskIds = queues.map((_queue, index) => {
		const offset = index * 7
		const steadyStateOldest = optionalString(counts[offset + 5])
		const migrationOldest = optionalString(counts[offset + 6])
		return migrationOldest ?? steadyStateOldest
	})
	const enqueuedAtPipeline = redis.pipeline()
	oldestTaskIds.forEach((taskId, index) => {
		if (taskId !== undefined) {
			enqueuedAtPipeline.hget(getEnqueuedAtKey(queues[index].namespace, queues[index].id), taskId)
		}
	})
	const timestampResults = oldestTaskIds.some((taskId) => taskId !== undefined)
		? await enqueuedAtPipeline.exec()
		: []
	if (!timestampResults) throw new Error('redis pipeline did not return a result')

	const now = Math.floor(clock())
	if (!Number.isSafeInteger(now) || now < 0) throw new Error('runtime snapshot clock returned an invalid timestamp')
	let timestampIndex = 0
	return queues.map((queue, index) => {
		const offset = index * 7
		const taskId = oldestTaskIds[index]
		const enqueuedAt =
			taskId === undefined ? undefined : pipelineValue(timestampResults[timestampIndex++])
		return {
			queueId: queue.id,
			namespace: queue.namespace,
			waiting: pipelineCount(counts[offset]) + pipelineCount(counts[offset + 1]),
			running: pipelineCount(counts[offset + 2]),
			retrying: pipelineCount(counts[offset + 3]),
			deadLetters: pipelineCount(counts[offset + 4]),
			...oldestWaiting(enqueuedAt, now),
		}
	})
}

/** A one-entry TTL cache that also coalesces identical in-flight Redis reads. */
export class CoalescedRuntimeSnapshotReader {
	private cached?: { key: string; expiresAt: number; value: QueueRuntimeSnapshot[] }
	private inFlight?: { key: string; operation: Promise<QueueRuntimeSnapshot[]> }

	constructor(
		private readonly redis: Redis,
		private readonly ttlMs = 1000,
		private readonly clock: () => number = Date.now
	) {
		if (!Number.isSafeInteger(ttlMs) || ttlMs < 0) {
			throw new Error('runtime snapshot TTL must be a non-negative integer')
		}
	}

	readonly read: RuntimeSnapshotReader = async (queues) => {
		const key = JSON.stringify(queues.map((queue) => [queue.id, queue.namespace]))
		const now = Math.floor(this.clock())
		if (!Number.isSafeInteger(now) || now < 0) {
			throw new Error('runtime snapshot clock returned an invalid timestamp')
		}
		if (this.cached?.key === key && this.cached.expiresAt > now) return this.cached.value
		if (this.inFlight?.key === key) return this.inFlight.operation

		const operation = readQueueRuntimeSnapshots(this.redis, queues, this.clock)
		this.inFlight = { key, operation }
		try {
			const value = await operation
			this.cached = { key, expiresAt: now + this.ttlMs, value }
			return value
		} finally {
			if (this.inFlight?.operation === operation) this.inFlight = undefined
		}
	}
}
