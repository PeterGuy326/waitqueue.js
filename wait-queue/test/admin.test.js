const test = require('node:test')
const assert = require('node:assert/strict')
const { once } = require('node:events')
const { Writable } = require('node:stream')

const { createApp } = require('../dist/app.js')
const { QueueDao } = require('../dist/dao/queue_dao.js')
const { redisCli } = require('../dist/conf/redis.js')
const { RedisTaskStore } = require('../dist/reliability/task_store.js')
const { WaitQueueMetrics } = require('../dist/observability/metrics.js')

test('admin overview aggregates queue configuration and live Redis counts', async (t) => {
	const redis = redisCli.getInstance()
	const originalFindAll = QueueDao.findAll
	const originalPipeline = redis.pipeline
	const originalDateNow = Date.now
	const now = 1_786_406_400_000
	Date.now = () => now
	QueueDao.findAll = async () => [
		{
			id: 7,
			namespace: 'billing',
			url: 'http://worker.internal/callback',
			count: 4,
			runCrontab: '*/2 * * * * *',
			checkCrontab: '*/5 * * * * *',
			expireCrontab: '0 */1 * * * *',
			updatedTime: '2026-08-10T08:00:00.000Z',
		},
	]
	let pipelineNumber = 0
	redis.pipeline = () => {
		pipelineNumber += 1
		const commands = []
		return {
			llen(key) {
				commands.push(['llen', key])
				return this
			},
			hlen(key) {
				commands.push(['hlen', key])
				return this
			},
			zcard(key) {
				commands.push(['zcard', key])
				return this
			},
			lindex(key, index) {
				commands.push(['lindex', key, index])
				return this
			},
			hget(key, field) {
				commands.push(['hget', key, field])
				return this
			},
			async exec() {
				if (pipelineNumber === 1) {
					assert.deepEqual(commands, [
						['llen', 'TaskQueue:billing:7:waitingQueue'],
						['llen', 'TaskQueue:billing:7:reliabilityMigrationWaitingV1'],
						['hlen', 'TaskQueue:billing:7:runningHashKv'],
						['zcard', 'TaskQueue:billing:7:retryScheduleZset'],
						['zcard', 'TaskQueue:billing:7:deadLetterZset'],
						['lindex', 'TaskQueue:billing:7:waitingQueue', -1],
						['lindex', 'TaskQueue:billing:7:reliabilityMigrationWaitingV1', -1],
					])
					return [
						[null, 3],
						[null, 0],
						[null, 2],
						[null, 1],
						[null, 2],
						[null, 'oldest-task-never-returned'],
						[null, null],
					]
				}
				assert.deepEqual(commands, [
					[
						'hget',
						'TaskQueue:billing:7:enqueuedAtHashKv',
						'oldest-task-never-returned',
					],
				])
				return [[null, now - 12_000]]
			},
		}
	}
	t.after(() => {
		QueueDao.findAll = originalFindAll
		redis.pipeline = originalPipeline
		Date.now = originalDateNow
	})

	const server = createApp({ metrics: new WaitQueueMetrics() }).listen(0, '127.0.0.1')
	await once(server, 'listening')
	t.after(() => new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))))

	const address = server.address()
	assert.ok(address && typeof address === 'object')
	const apiResponse = await fetch(`http://127.0.0.1:${address.port}/waitqueue/admin/overview`)
	const body = await apiResponse.json()

	assert.equal(apiResponse.status, 200)
	assert.equal(apiResponse.headers.get('cache-control'), 'no-store')
	assert.equal(body.code, 0)
	assert.equal(typeof body.data.generatedAt, 'string')
	assert.equal(typeof body.data.metricsStartedAt, 'string')
	assert.deepEqual(body.data.summary, {
		queueCount: 1,
		waiting: 3,
		running: 2,
		retrying: 1,
		deadLetters: 2,
		oldestWaitingAt: new Date(now - 12_000).toISOString(),
		oldestWaitingAgeSeconds: 12,
		callbackSuccesses: 0,
		callbackFailures: 0,
		claims: 0,
		recovered: 0,
		capacity: 4,
		utilization: 50,
	})
	assert.deepEqual(body.data.queues, [
		{
			queueId: 7,
			namespace: 'billing',
			hookUrl: 'http://worker.internal/callback',
			concurrency: 4,
			waiting: 3,
			running: 2,
			retrying: 1,
			deadLetters: 2,
			oldestWaitingAt: new Date(now - 12_000).toISOString(),
			oldestWaitingAgeSeconds: 12,
			callbacks: { success: 0, failure: 0 },
			claims: { claimed: 0, recovered: 0 },
			available: 2,
			utilization: 50,
			crontab: {
				run: '*/2 * * * * *',
				check: '*/5 * * * * *',
				expire: '0 */1 * * * *',
			},
			updatedAt: '2026-08-10T08:00:00.000Z',
		},
	])
})

test('admin overview distinguishes an empty queue from a task that just started waiting', async (t) => {
	const originalFindAll = QueueDao.findAll
	QueueDao.findAll = async () => [
		{
			id: 7,
			namespace: 'billing',
			url: 'https://worker.example.com/callback',
			count: 1,
			runCrontab: '* * * * * *',
			checkCrontab: '* * * * * *',
			expireCrontab: '* * * * * *',
			updatedTime: '2026-08-10T08:00:00.000Z',
		},
	]
	t.after(() => {
		QueueDao.findAll = originalFindAll
	})
	const metrics = new WaitQueueMetrics(() => Date.parse('2026-08-10T07:00:00.000Z'))
	const server = createApp({
		metrics,
		runtimeSnapshotReader: async () => [
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
	}).listen(0, '127.0.0.1')
	await once(server, 'listening')
	t.after(() => new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))))
	const address = server.address()
	assert.ok(address && typeof address === 'object')
	const response = await fetch(`http://127.0.0.1:${address.port}/waitqueue/admin/overview`)
	const overview = (await response.json()).data

	assert.equal(overview.metricsStartedAt, '2026-08-10T07:00:00.000Z')
	assert.equal(overview.summary.oldestWaitingAt, null)
	assert.equal(overview.summary.oldestWaitingAgeSeconds, null)
	assert.equal(overview.queues[0].oldestWaitingAt, null)
	assert.equal(overview.queues[0].oldestWaitingAgeSeconds, null)
})

test('admin dead letter APIs query a queue and replay an exact generation', async (t) => {
	const originalFindByPk = QueueDao.findByPk
	const originalList = RedisTaskStore.prototype.listDeadLetters
	const originalReplay = RedisTaskStore.prototype.replayDeadLetter
	QueueDao.findByPk = async (queueId, options) => {
		assert.equal(queueId, 7)
		assert.deepEqual(options, { attributes: ['id', 'namespace'] })
		return { id: 7, namespace: 'billing' }
	}
	RedisTaskStore.prototype.listDeadLetters = async function (offset, limit) {
		assert.equal(this.keys.deadLetters, 'TaskQueue:billing:7:deadLetterHashKv')
		assert.deepEqual([offset, limit], [5, 2])
		return {
			total: 1,
			offset,
			limit,
			items: [
				{
					entryId: 'entry-1',
					taskId: 'task-1',
					retryCount: 3,
					failedAt: '2026-08-11T00:00:00.000Z',
					reason: 'callback_failed',
				},
			],
		}
	}
	RedisTaskStore.prototype.replayDeadLetter = async (taskId, entryId) => {
		assert.deepEqual([taskId, entryId], ['task-1', 'entry-1'])
		return 'replayed'
	}
	t.after(() => {
		QueueDao.findByPk = originalFindByPk
		RedisTaskStore.prototype.listDeadLetters = originalList
		RedisTaskStore.prototype.replayDeadLetter = originalReplay
	})

	const server = createApp().listen(0, '127.0.0.1')
	await once(server, 'listening')
	t.after(() => new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))))
	const address = server.address()
	assert.ok(address && typeof address === 'object')
	const baseUrl = `http://127.0.0.1:${address.port}`

	const listResponse = await fetch(
		`${baseUrl}/waitqueue/admin/deadLetters?queueId=7&offset=5&limit=2`
	)
	assert.equal(listResponse.status, 200)
	assert.equal(listResponse.headers.get('cache-control'), 'no-store')
	assert.deepEqual((await listResponse.json()).data, {
		total: 1,
		offset: 5,
		limit: 2,
		items: [
			{
				entryId: 'entry-1',
				taskId: 'task-1',
				retryCount: 3,
				failedAt: '2026-08-11T00:00:00.000Z',
				reason: 'callback_failed',
			},
		],
	})

	const replayResponse = await fetch(`${baseUrl}/waitqueue/admin/deadLetters/replay`, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ queueId: 7, taskId: 'task-1', entryId: 'entry-1' }),
	})
	assert.equal(replayResponse.status, 200)
	assert.deepEqual((await replayResponse.json()).data, { isOk: true })
})

test('dead letter APIs authenticate, map replay conflicts, and audit without identifiers', async (t) => {
	const originalFindByPk = QueueDao.findByPk
	const originalReplay = RedisTaskStore.prototype.replayDeadLetter
	QueueDao.findByPk = async (queueId) =>
		queueId === 404 ? null : { id: queueId, namespace: 'billing' }
	RedisTaskStore.prototype.replayDeadLetter = async (_taskId, entryId) => {
		if (entryId === 'missing-entry') return 'missing'
		if (entryId === 'stale-entry') return 'stale'
		if (entryId === 'active-entry') return 'conflict'
		return 'replayed'
	}
	t.after(() => {
		QueueDao.findByPk = originalFindByPk
		RedisTaskStore.prototype.replayDeadLetter = originalReplay
	})

	const logLines = []
	const requestLogStream = new Writable({
		write(chunk, _encoding, callback) {
			logLines.push(String(chunk))
			callback()
		},
	})
	const server = createApp({
		security: { apiToken: 'dead-letter-secret' },
		requestLogStream,
	}).listen(0, '127.0.0.1')
	await once(server, 'listening')
	t.after(() => new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))))
	const address = server.address()
	assert.ok(address && typeof address === 'object')
	const baseUrl = `http://127.0.0.1:${address.port}`
	const replay = (queueId, entryId, authorization = 'Bearer dead-letter-secret') =>
		fetch(`${baseUrl}/waitqueue/admin/deadLetters/replay`, {
			method: 'POST',
			headers: { 'content-type': 'application/json', authorization },
			body: JSON.stringify({ queueId, taskId: 'sensitive-task', entryId }),
		})

	assert.equal(
		(await fetch(`${baseUrl}/waitqueue/admin/deadLetters?queueId=7`)).status,
		401
	)
	assert.equal((await replay(7, 'ok-entry', '')).status, 401)
	assert.equal(
		(
			await fetch(`${baseUrl}/waitqueue/admin/deadLetters?queueId=404`, {
				headers: { authorization: 'Bearer dead-letter-secret' },
			})
		).status,
		404
	)
	assert.equal((await replay(404, 'ok-entry')).status, 404)
	assert.equal((await replay(7, 'missing-entry')).status, 404)
	assert.equal((await replay(7, 'stale-entry')).status, 409)
	assert.equal((await replay(7, 'active-entry')).status, 409)
	assert.equal((await replay(7, 'ok-entry')).status, 200)

	const serialized = logLines.join('')
	assert.doesNotMatch(serialized, /dead-letter-secret|sensitive-task|missing-entry|stale-entry|active-entry|ok-entry/)
	const records = serialized
		.trim()
		.split('\n')
		.filter(Boolean)
		.map(JSON.parse)
	const replayAudits = records.filter((record) => record.audit?.action === 'dead_letter.replay')
	assert.ok(replayAudits.some((record) => record.audit.outcome === 'succeeded' && record.audit.statusCode === 200))
	assert.ok(replayAudits.some((record) => record.audit.outcome === 'failed' && record.audit.statusCode === 404))
	assert.ok(replayAudits.some((record) => record.audit.outcome === 'failed' && record.audit.statusCode === 409))
	assert.ok(records.some((record) => record.audit?.action === 'auth.denied' && record.audit.statusCode === 401))
})
