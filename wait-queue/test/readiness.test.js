const test = require('node:test')
const assert = require('node:assert/strict')
const { once } = require('node:events')

const { createApp } = require('../dist/app.js')
const { checkReadiness, createReadinessCheck } = require('../dist/service/readiness.js')

async function startTestApp(t, readinessCheck) {
	const server = createApp({ readinessCheck }).listen(0, '127.0.0.1')
	await once(server, 'listening')
	t.after(() => new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))))

	const address = server.address()
	assert.ok(address && typeof address === 'object')
	return `http://127.0.0.1:${address.port}`
}

test('readiness probe checks MySQL and Redis in parallel and converts failures to false', async () => {
	const calls = []
	const ready = await checkReadiness({
		database: async () => calls.push('database'),
		redis: async () => calls.push('redis'),
	})
	assert.deepEqual(ready, {
		ready: true,
		dependencies: { mysql: 'ok', redis: 'ok' },
	})
	assert.deepEqual(calls.sort(), ['database', 'redis'])

	let redisChecked = false
	const unavailable = await checkReadiness({
		database: () => {
			throw new Error('database password must never reach the response')
		},
		redis: async () => {
			redisChecked = true
		},
	})
	assert.deepEqual(unavailable, {
		ready: false,
		dependencies: { mysql: 'unavailable', redis: 'ok' },
	})
	assert.equal(redisChecked, true)
})

test('readiness probe bounds a slow dependency and reports it unavailable', async () => {
	const unavailable = await checkReadiness(
		{
			database: () => new Promise(() => {}),
			redis: async () => 'PONG',
		},
		{ timeoutMs: 10 }
	)
	assert.deepEqual(unavailable, {
		ready: false,
		dependencies: { mysql: 'unavailable', redis: 'ok' },
	})
})

test('readiness checker coalesces concurrent dependency probes', async () => {
	let databaseCalls = 0
	let releaseDatabase
	const readinessCheck = createReadinessCheck({
		database: () => {
			databaseCalls += 1
			return new Promise((resolve) => {
				releaseDatabase = resolve
			})
		},
		redis: async () => 'PONG',
	})

	const first = readinessCheck()
	const second = readinessCheck()
	assert.equal(first, second)
	await Promise.resolve()
	assert.equal(databaseCalls, 1)
	releaseDatabase()
	assert.equal((await first).ready, true)
})

test('GET /waitqueue/ready returns 200 only when all dependencies are ready', async (t) => {
	const baseUrl = await startTestApp(t, async () => ({
		ready: true,
		dependencies: { mysql: 'ok', redis: 'ok' },
	}))
	const apiResponse = await fetch(`${baseUrl}/waitqueue/ready`)

	assert.equal(apiResponse.status, 200)
	assert.equal(apiResponse.headers.get('cache-control'), 'no-store')
	assert.deepEqual(await apiResponse.json(), {
		code: 0,
		msg: 'success',
		data: { status: 'ready', dependencies: { mysql: 'ok', redis: 'ok' } },
	})
})

test('GET /waitqueue/ready returns a generic 503 without dependency details', async (t) => {
	const secret = 'mysql://root:secret@database.internal/waitqueue'
	const baseUrl = await startTestApp(t, async () => {
		throw new Error(secret)
	})
	const apiResponse = await fetch(`${baseUrl}/waitqueue/ready`)
	const rawBody = await apiResponse.text()

	assert.equal(apiResponse.status, 503)
	assert.deepEqual(JSON.parse(rawBody), {
		code: 1,
		msg: 'service unavailable',
		data: {
			status: 'unavailable',
			dependencies: { mysql: 'unavailable', redis: 'unavailable' },
		},
	})
	assert.equal(rawBody.includes(secret), false)
})

test('liveness endpoint remains shallow and unchanged when readiness fails', async (t) => {
	const baseUrl = await startTestApp(t, async () => ({
		ready: false,
		dependencies: { mysql: 'unavailable', redis: 'ok' },
	}))
	const apiResponse = await fetch(`${baseUrl}/waitqueue/health`)

	assert.equal(apiResponse.status, 200)
	assert.deepEqual(await apiResponse.json(), {
		code: 0,
		msg: 'success',
		data: { status: 'ok' },
	})
})
