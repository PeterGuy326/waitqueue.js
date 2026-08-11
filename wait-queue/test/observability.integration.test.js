const test = require('node:test')
const assert = require('node:assert/strict')
const { randomUUID } = require('node:crypto')
const Redis = require('ioredis')

const { RedisTaskStore } = require('../dist/reliability/task_store.js')
const { readQueueRuntimeSnapshots } = require('../dist/observability/runtime_snapshot.js')
const { WaitQueueMetrics } = require('../dist/observability/metrics.js')

const redisUrl = process.env.WAITQUEUE_REDIS_INTEGRATION_URL

test(
	'real Redis snapshot reports steady/migration waiting, running, retry, DLQ, and oldest age',
	{ skip: redisUrl ? false : 'WAITQUEUE_REDIS_INTEGRATION_URL is not configured' },
	async (t) => {
		const redis = new Redis(redisUrl)
		await redis.ping()
		const namespace = `observability-${randomUUID()}`
		const queueId = 19
		const store = new RedisTaskStore(redis, namespace, queueId)
		t.after(async () => {
			await redis.del(...Object.values(store.keys))
			await redis.quit()
		})
		const now = 1_786_406_400_000
		await redis.lpush(store.keys.waiting, 'newer-sensitive-task')
		await redis.lpush(store.keys.migrationWaiting, 'oldest-sensitive-task')
		await redis.hset(
			store.keys.enqueuedAt,
			'newer-sensitive-task',
			now - 1000,
			'oldest-sensitive-task',
			now - 7000
		)
		await redis.hset(store.keys.running, 'running-a', 'ack:a', 'running-b', 'ack:b')
		await redis.zadd(store.keys.retrySchedule, now + 1000, 'retry-sensitive-task')
		await redis.zadd(store.keys.deadLetterOrder, now, 'dead-sensitive-task')

		const snapshots = await readQueueRuntimeSnapshots(
			redis,
			[{ id: queueId, namespace }],
			() => now
		)
		assert.deepEqual(snapshots, [
			{
				queueId,
				namespace,
				waiting: 2,
				running: 2,
				retrying: 1,
				deadLetters: 1,
				oldestWaitingAt: new Date(now - 7000).toISOString(),
				oldestWaitingAgeSeconds: 7,
			},
		])
		const rendered = new WaitQueueMetrics().render(snapshots)
		assert.doesNotMatch(
			rendered,
			/newer-sensitive-task|oldest-sensitive-task|running-a|ack:a|retry-sensitive-task|dead-sensitive-task/
		)
	}
)
