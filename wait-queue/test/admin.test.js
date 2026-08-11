const test = require('node:test')
const assert = require('node:assert/strict')
const { once } = require('node:events')

const { createApp } = require('../dist/app.js')
const { QueueDao } = require('../dist/dao/queue_dao.js')
const { redisCli } = require('../dist/conf/redis.js')

test('admin overview aggregates queue configuration and live Redis counts', async (t) => {
	const redis = redisCli.getInstance()
	const originalFindAll = QueueDao.findAll
	const originalPipeline = redis.pipeline
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
	redis.pipeline = () => {
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
			async exec() {
				assert.deepEqual(commands, [
					['llen', 'TaskQueue:billing:7:waitingQueue'],
					['hlen', 'TaskQueue:billing:7:runningHashKv'],
				])
				return [
					[null, 3],
					[null, 2],
				]
			},
		}
	}
	t.after(() => {
		QueueDao.findAll = originalFindAll
		redis.pipeline = originalPipeline
	})

	const server = createApp().listen(0, '127.0.0.1')
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
	assert.deepEqual(body.data.summary, {
		queueCount: 1,
		waiting: 3,
		running: 2,
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
