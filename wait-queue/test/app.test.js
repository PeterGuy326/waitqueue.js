const test = require('node:test')
const assert = require('node:assert/strict')
const { once } = require('node:events')

const { createApp } = require('../dist/app.js')
const { QueueDao } = require('../dist/dao/queue_dao.js')

async function request(baseUrl, path, init) {
	const response = await fetch(`${baseUrl}${path}`, init)
	return {
		status: response.status,
		body: await response.json(),
	}
}

test('app exposes prefixed health and structured 400/404 responses without external services', async (t) => {
	const originalFindOne = QueueDao.findOne
	QueueDao.findOne = async () => null
	t.after(() => {
		QueueDao.findOne = originalFindOne
	})

	const server = createApp().listen(0, '127.0.0.1')
	await once(server, 'listening')
	t.after(() => new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))))

	const address = server.address()
	assert.ok(address && typeof address === 'object')
	const baseUrl = `http://127.0.0.1:${address.port}`

	const health = await request(baseUrl, '/waitqueue/health')
	assert.deepEqual(health, {
		status: 200,
		body: { code: 0, msg: 'success', data: { status: 'ok' } },
	})

	const missingPrefix = await request(baseUrl, '/health')
	assert.deepEqual(missingPrefix, {
		status: 404,
		body: { code: 1, msg: 'route not found', data: [] },
	})

	const invalidQueue = await request(baseUrl, '/waitqueue/queue/newQueue', {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({}),
	})
	assert.deepEqual(invalidQueue, {
		status: 400,
		body: { code: 1, msg: 'hookUrl is required', data: [] },
	})

	const malformedJson = await request(baseUrl, '/waitqueue/queue/newQueue', {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: '{"hookUrl":',
	})
	assert.equal(malformedJson.status, 400)
	assert.equal(malformedJson.body.code, 1)
	assert.match(malformedJson.body.msg, /json|unexpected/i)
	assert.deepEqual(malformedJson.body.data, [])

	const missingQueue = await request(baseUrl, '/waitqueue/scheduler/addTask', {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({
			hookUrl: 'https://worker.example.com/tasks',
			namespace: 'billing',
			taskId: 'task-1',
		}),
	})
	assert.deepEqual(missingQueue, {
		status: 404,
		body: { code: 1, msg: 'queue not found; register it before adding tasks', data: [] },
	})

	const wrongMethod = await request(baseUrl, '/waitqueue/health', { method: 'POST' })
	assert.deepEqual(wrongMethod, {
		status: 405,
		body: { code: 1, msg: 'method not allowed', data: [] },
	})

	const optionsResponse = await fetch(`${baseUrl}/waitqueue/health`, { method: 'OPTIONS' })
	assert.equal(optionsResponse.status, 200)
	assert.match(optionsResponse.headers.get('allow') || '', /\bGET\b/)

	const unknownRoute = await request(baseUrl, '/waitqueue/does-not-exist')
	assert.deepEqual(unknownRoute, {
		status: 404,
		body: { code: 1, msg: 'route not found', data: [] },
	})
})
