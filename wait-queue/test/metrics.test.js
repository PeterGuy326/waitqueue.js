const test = require('node:test')
const assert = require('node:assert/strict')
const { once } = require('node:events')

const { createApp } = require('../dist/app.js')
const { QueueDao } = require('../dist/dao/queue_dao.js')
const {
	PROMETHEUS_CONTENT_TYPE,
	WaitQueueMetrics,
} = require('../dist/observability/metrics.js')
const {
	CoalescedRuntimeSnapshotReader,
} = require('../dist/observability/runtime_snapshot.js')

function runtimeSnapshot(namespace = 'billing') {
	return [
		{
			queueId: 7,
			namespace,
			waiting: 3,
			running: 2,
			retrying: 1,
			deadLetters: 4,
			oldestWaitingAt: '2026-08-11T00:00:00.000Z',
			oldestWaitingAgeSeconds: 12,
		},
	]
}

test('lightweight registry emits deterministic Prometheus text without sensitive labels', () => {
	const metrics = new WaitQueueMetrics()
	const namespace = 'billing"\\\nline'
	metrics.recordCallback(7, 'run', 'success')
	metrics.recordCallback(7, 'run', 'failure')
	metrics.recordClaim(7, 'claimed', 2)
	metrics.recordRetry(7, 'scheduled', 'callback_failed')

	const rendered = metrics.render(runtimeSnapshot(namespace))
	assert.match(rendered, /^# HELP waitqueue_queue_waiting_tasks/m)
	assert.match(rendered, /^# TYPE waitqueue_queue_waiting_tasks gauge$/m)
	assert.match(rendered, /^# TYPE waitqueue_callback_attempts_total counter$/m)
	assert.match(rendered, /waitqueue_queue_waiting_tasks\{[^}]+\} 3/)
	assert.match(rendered, /waitqueue_queue_retrying_tasks\{[^}]+\} 1/)
	assert.match(rendered, /waitqueue_queue_dead_letter_tasks\{[^}]+\} 4/)
	assert.match(rendered, /waitqueue_queue_oldest_waiting_seconds\{[^}]+\} 12/)
	assert.doesNotMatch(rendered, /task_id|taskId|claimToken|hookUrl|hook_url/)
	assert.doesNotMatch(rendered, /namespace=|billing/)
	assert.equal(typeof metrics.startedAt, 'string')
})

test('runtime reader coalesces concurrent reads and serves only a short-lived cache', async () => {
	let now = 1000
	let execCalls = 0
	let release
	const redis = {
		pipeline() {
			return {
				llen() {
					return this
				},
				hlen() {
					return this
				},
				zcard() {
					return this
				},
				lindex() {
					return this
				},
				hget() {
					return this
				},
				exec() {
					execCalls += 1
					return new Promise((resolve) => {
						release = () =>
							resolve([
								[null, 0],
								[null, 0],
								[null, 0],
								[null, 0],
								[null, 0],
								[null, null],
								[null, null],
							])
					})
				},
			}
		},
	}
	const reader = new CoalescedRuntimeSnapshotReader(redis, 1000, () => now)
	const queues = [{ id: 7, namespace: 'billing' }]

	const first = reader.read(queues)
	const second = reader.read(queues)
	assert.equal(execCalls, 1)
	release()
	const snapshots = await Promise.all([first, second])
	assert.deepEqual(snapshots, [
		[
			{
				queueId: 7,
				namespace: 'billing',
				waiting: 0,
				running: 0,
				retrying: 0,
				deadLetters: 0,
				oldestWaitingAt: null,
				oldestWaitingAgeSeconds: null,
			},
		],
		[
			{
				queueId: 7,
				namespace: 'billing',
				waiting: 0,
				running: 0,
				retrying: 0,
				deadLetters: 0,
				oldestWaitingAt: null,
				oldestWaitingAgeSeconds: null,
			},
		],
	])
	const emptyMetrics = new WaitQueueMetrics().render(snapshots[0])
	assert.match(emptyMetrics, /^# TYPE waitqueue_queue_oldest_waiting_seconds gauge$/m)
	assert.doesNotMatch(emptyMetrics, /^waitqueue_queue_oldest_waiting_seconds\{/m)
	await reader.read(queues)
	assert.equal(execCalls, 1)

	now = 2001
	const expired = reader.read(queues)
	assert.equal(execCalls, 2)
	release()
	await expired
})

test('metrics endpoint is no-store, token-protected when configured, and returns raw exposition', async (t) => {
	const originalFindAll = QueueDao.findAll
	QueueDao.findAll = async (options) => {
		assert.deepEqual(options, {
			attributes: ['id', 'namespace'],
			order: [['id', 'ASC']],
		})
		return [{ id: 7, namespace: 'billing' }]
	}
	t.after(() => {
		QueueDao.findAll = originalFindAll
	})
	const metrics = new WaitQueueMetrics()
	metrics.recordCallback(7, 'run', 'success')
	const runtimeSnapshotReader = async (queues) => {
		assert.deepEqual(queues, [{ id: 7, namespace: 'billing' }])
		return runtimeSnapshot()
	}
	const server = createApp({
		security: { apiToken: 'metrics-secret' },
		metrics,
		runtimeSnapshotReader,
	}).listen(0, '127.0.0.1')
	await once(server, 'listening')
	t.after(() => new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))))
	const address = server.address()
	assert.ok(address && typeof address === 'object')
	const url = `http://127.0.0.1:${address.port}/metrics`

	const unauthenticated = await fetch(url)
	assert.equal(unauthenticated.status, 401)
	assert.equal((await fetch(`${url}/`)).status, 401)
	const response = await fetch(url, {
		headers: { authorization: 'Bearer metrics-secret' },
	})
	const body = await response.text()

	assert.equal(response.status, 200)
	assert.equal(response.headers.get('cache-control'), 'no-store')
	assert.equal(response.headers.get('content-type'), PROMETHEUS_CONTENT_TYPE)
	assert.match(body, /waitqueue_callback_attempts_total/)
	assert.doesNotMatch(body, /"code"|metrics-secret/)

	const namespacedAlias = await fetch(
		`http://127.0.0.1:${address.port}/waitqueue/metrics`,
		{ headers: { authorization: 'Bearer metrics-secret' } }
	)
	assert.equal(namespacedAlias.status, 200)
	assert.match(await namespacedAlias.text(), /waitqueue_queue_waiting_tasks/)
})
