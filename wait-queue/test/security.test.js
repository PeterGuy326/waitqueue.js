const test = require('node:test')
const assert = require('node:assert/strict')
const { once } = require('node:events')
const { Writable } = require('node:stream')

const { createApp } = require('../dist/app.js')
const { QueueDao } = require('../dist/dao/queue_dao.js')
const { redisCli } = require('../dist/conf/redis.js')
const { Timer } = require('../dist/lib/timer.js')
const {
	createSecurityConfigurationWarner,
	createSecurityConfig,
	readSecurityConfig,
} = require('../dist/security/config.js')
const { HookUrlPolicy } = require('../dist/security/hook_url_policy.js')
const { FixedWindowRateLimiter } = require('../dist/security/rate_limit.js')
const { validateAddTaskInput, validateNewQueueInput } = require('../dist/utils/validation.js')
const { HttpError } = require('../dist/utils/http_error.js')

function logSink(lines = undefined) {
	return new Writable({
		write(chunk, _encoding, callback) {
			if (lines) lines.push(String(chunk))
			callback()
		},
	})
}

async function startTestApp(t, options = {}) {
	const server = createApp({ requestLogStream: logSink(), ...options }).listen(0, '127.0.0.1')
	await once(server, 'listening')
	t.after(() => new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))))
	const address = server.address()
	assert.ok(address && typeof address === 'object')
	return `http://127.0.0.1:${address.port}`
}

test('security environment configuration validates numeric values, tokens, and exact origins', () => {
	assert.deepEqual(readSecurityConfig({}), {
		apiToken: undefined,
		hookUrlAllowlist: [],
		allowPrivateHookUrls: false,
		requestBodyLimitBytes: 32768,
		rateLimitMaxRequests: 0,
		rateLimitWindowMs: 60000,
	})

	const parsed = readSecurityConfig({
		WAITQUEUE_API_TOKEN: 'secret',
		HOOK_URL_ALLOWLIST: 'https://worker.example.com, https://jobs.example.net:8443/',
		HOOK_URL_ALLOW_PRIVATE: 'true',
		REQUEST_BODY_LIMIT_BYTES: '1024',
		RATE_LIMIT_MAX_REQUESTS: '20',
		RATE_LIMIT_WINDOW_MS: '5000',
	})
	assert.equal(parsed.apiToken, 'secret')
	assert.deepEqual(parsed.hookUrlAllowlist, [
		'https://worker.example.com',
		'https://jobs.example.net:8443',
	])
	assert.equal(parsed.allowPrivateHookUrls, true)
	assert.equal(parsed.requestBodyLimitBytes, 1024)
	assert.equal(parsed.rateLimitMaxRequests, 20)
	assert.equal(parsed.rateLimitWindowMs, 5000)

	for (const environment of [
		{ REQUEST_BODY_LIMIT_BYTES: '0' },
		{ RATE_LIMIT_MAX_REQUESTS: '-1' },
		{ RATE_LIMIT_WINDOW_MS: '1.5' },
		{ WAITQUEUE_API_TOKEN: '   ' },
		{ WAITQUEUE_API_TOKEN: 'abc def' },
		{ HOOK_URL_ALLOW_PRIVATE: 'yes' },
		{ HOOK_URL_ALLOWLIST: 'https://worker.example.com/path' },
		{ HOOK_URL_ALLOWLIST: 'https://worker.example.com?' },
		{ HOOK_URL_ALLOWLIST: 'redis://worker.example.com' },
		{ HOOK_URL_ALLOWLIST: 'https://user:pass@worker.example.com' },
	]) {
		assert.throws(() => readSecurityConfig(environment))
	}
	assert.throws(() => createSecurityConfig({ requestBodyLimitBytes: Number.NaN }))
})

test('insecure compatibility defaults emit each startup warning only once', () => {
	const warnings = []
	const warn = createSecurityConfigurationWarner({
		warn(bindings, message) {
			warnings.push({ bindings, message })
		},
	})
	const insecure = createSecurityConfig()
	warn(insecure)
	warn(insecure)
	assert.equal(warnings.length, 2)
	assert.deepEqual(
		warnings.map(({ bindings }) => bindings.configuration).sort(),
		['HOOK_URL_ALLOWLIST', 'WAITQUEUE_API_TOKEN']
	)
	assert.ok(warnings.every(({ message }) => !message.includes('undefined')))
})

test('Bearer authentication protects control APIs while health, readiness, and OPTIONS stay open', async (t) => {
	const originalFindAll = QueueDao.findAll
	QueueDao.findAll = async () => []
	t.after(() => {
		QueueDao.findAll = originalFindAll
	})

	const baseUrl = await startTestApp(t, {
		security: { apiToken: 'test-secret' },
		readinessCheck: async () => ({
			ready: true,
			dependencies: { mysql: 'ok', redis: 'ok' },
		}),
	})

	assert.equal((await fetch(`${baseUrl}/waitqueue/health`)).status, 200)
	assert.equal((await fetch(`${baseUrl}/waitqueue/ready`)).status, 200)
	assert.equal((await fetch(`${baseUrl}/waitqueue/admin/overview`, { method: 'OPTIONS' })).status, 200)

	const missing = await fetch(`${baseUrl}/waitqueue/admin/overview`)
	assert.equal(missing.status, 401)
	assert.equal(missing.headers.get('www-authenticate'), 'Bearer')
	assert.equal((await missing.json()).msg, 'authentication required')

	assert.equal(
		(
			await fetch(`${baseUrl}/waitqueue/admin/overview`, {
				headers: { authorization: 'Bearer wrong-secret' },
			})
		).status,
		401
	)
	assert.equal(
		(
			await fetch(`${baseUrl}/waitqueue/admin/overview`, {
				headers: { authorization: 'Bearer test-secret' },
			})
		).status,
		200
	)
	assert.equal((await fetch(`${baseUrl}/waitqueue/future-control-route`)).status, 401)
	assert.equal(
		(
			await fetch(`${baseUrl}/waitqueue/future-control-route`, {
				headers: { authorization: 'Bearer test-secret' },
			})
		).status,
		404,
		'new control-plane routes must be authenticated by default'
	)

	for (const path of [
		'/WAITQUEUE/ADMIN/overview',
		'/waitqueue/ADMIN/overview',
		'/waitqueue/QUEUE/newQueue',
		'/waitqueue/SCHEDULER/addTask',
	]) {
		const method = path.endsWith('overview') ? 'GET' : 'POST'
		assert.equal(
			(await fetch(`${baseUrl}${path}`, { method })).status,
			401,
			`case variants of protected paths must not bypass authentication: ${path}`
		)
		assert.equal(
			(
				await fetch(`${baseUrl}${path}`, {
					method,
					headers: { authorization: 'Bearer test-secret' },
				})
			).status,
			404,
			`routing must reject non-canonical path casing: ${path}`
		)
	}
})

test('authentication and rate limiting run before the JSON-only bounded body parser', async (t) => {
	const baseUrl = await startTestApp(t, {
		security: { apiToken: 'test-secret', requestBodyLimitBytes: 64 },
	})
	const oversizedBody = JSON.stringify({ hookUrl: `https://worker.example.com/${'x'.repeat(200)}` })

	const unauthorized = await fetch(`${baseUrl}/waitqueue/queue/newQueue`, {
		method: 'POST',
		headers: { 'content-type': 'application/json', authorization: 'Bearer wrong-secret' },
		body: oversizedBody,
	})
	assert.equal(unauthorized.status, 401, 'auth rejection must happen before parsing an oversized body')

	const oversized = await fetch(`${baseUrl}/waitqueue/queue/newQueue`, {
		method: 'POST',
		headers: { 'content-type': 'application/json', authorization: 'Bearer test-secret' },
		body: oversizedBody,
	})
	assert.equal(oversized.status, 413)

	const form = await fetch(`${baseUrl}/waitqueue/queue/newQueue`, {
		method: 'POST',
		headers: { 'content-type': 'application/x-www-form-urlencoded', authorization: 'Bearer test-secret' },
		body: 'hookUrl=https%3A%2F%2Fworker.example.com',
	})
	assert.equal(form.status, 400)
	assert.equal((await form.json()).msg, 'hookUrl is required')
})

test('fixed-window limiter resets on the injected clock, returns Retry-After, and stays bounded', async (t) => {
	let now = 10_000
	const baseUrl = await startTestApp(t, {
		security: { rateLimitMaxRequests: 2, rateLimitWindowMs: 5000 },
		rateLimitClock: () => now,
	})

	assert.equal((await fetch(`${baseUrl}/waitqueue/admin/missing`)).status, 404)
	assert.equal((await fetch(`${baseUrl}/waitqueue/admin/missing`)).status, 404)
	const limited = await fetch(`${baseUrl}/waitqueue/admin/missing`)
	assert.equal(limited.status, 429)
	assert.equal(limited.headers.get('retry-after'), '5')
	assert.equal((await fetch(`${baseUrl}/waitqueue/health`)).status, 200, 'health is not rate limited')

	now += 5000
	assert.equal((await fetch(`${baseUrl}/waitqueue/admin/missing`)).status, 404)

	const bounded = new FixedWindowRateLimiter(1, 1000, () => now, 2)
	bounded.consume('client-1')
	bounded.consume('client-2')
	bounded.consume('client-3')
	assert.equal(bounded.size, 2)
})

test('hook URL policy rejects credentials and non-allowlisted origins at request validation', () => {
	const policy = new HookUrlPolicy(['https://worker.example.com'])
	const base = { namespace: 'billing', hookUrl: 'https://worker.example.com/tasks' }
	assert.equal(validateNewQueueInput(base, policy).hookUrl, base.hookUrl)
	assert.equal(validateAddTaskInput({ ...base, taskId: 'task-1' }, policy).hookUrl, base.hookUrl)

	for (const hookUrl of [
		'https://other.example.com/tasks',
		'https://user:pass@worker.example.com/tasks',
		'file:///tmp/callback',
	]) {
		assert.throws(
			() => validateNewQueueInput({ ...base, hookUrl }, policy),
			(error) => error instanceof HttpError && error.status === 400
		)
	}

	for (const hookUrl of [
		'http://127.0.0.1:3101/callback',
		'http://127.255.255.254/callback',
		'http://2130706433/callback',
		'http://0x7f000001/callback',
		'http://localhost:3101/callback',
		'http://10.0.0.8/callback',
		'http://192.168.1.8/callback',
		'http://169.254.169.254/latest/meta-data',
		'http://[::1]:3101/callback',
		'http://[::ffff:127.0.0.1]/callback',
		'http://[::127.0.0.1]/callback',
		'http://[64:ff9b::127.0.0.1]/callback',
		'http://[2002:7f00:1::]/callback',
		'http://[fc00::1]/callback',
		'http://[fe80::1]/callback',
		'http://mock-hook:3101/callback',
	]) {
		const strictPolicy = new HookUrlPolicy([new URL(hookUrl).origin])
		assert.throws(
			() => validateNewQueueInput({ ...base, hookUrl }, strictPolicy),
			(error) =>
				error instanceof HttpError &&
				error.status === 400 &&
				error.message === 'hookUrl must not target a private or local address'
		)
	}

	const localHookUrl = 'http://mock-hook:3101/callback'
	assert.equal(
		validateNewQueueInput({ ...base, hookUrl: localHookUrl }).hookUrl,
		localHookUrl,
		'empty allowlist keeps the legacy local-development behavior'
	)
	const explicitDevelopmentPolicy = new HookUrlPolicy(['http://mock-hook:3101'], {
		allowPrivate: true,
	})
	assert.equal(
		validateNewQueueInput({ ...base, hookUrl: localHookUrl }, explicitDevelopmentPolicy).hookUrl,
		localHookUrl
	)
})

test('audit logs use final statuses and redact credentials and callback identifiers', async (t) => {
	const originalFindOne = QueueDao.findOne
	const originalFindOrCreate = QueueDao.findOrCreate
	const redis = redisCli.getInstance()
	const originalLpush = redis.lpush
	const originalInitializeQueueList = Timer.prototype.initializeQueueList
	let timerHookUrlPolicy
	QueueDao.findOne = async () => ({ id: 7, namespace: 'billing' })
	QueueDao.findOrCreate = async () => [{ id: 7, async update() {} }, true]
	redis.lpush = async () => 1
	Timer.prototype.initializeQueueList = async function () {
		timerHookUrlPolicy = this.hookUrlPolicy
	}
	t.after(() => {
		QueueDao.findOne = originalFindOne
		QueueDao.findOrCreate = originalFindOrCreate
		redis.lpush = originalLpush
		Timer.prototype.initializeQueueList = originalInitializeQueueList
	})

	const lines = []
	let now = 0
	const server = createApp({
		requestLogStream: logSink(lines),
		security: {
			apiToken: 'audit-secret-token',
			hookUrlAllowlist: ['https://private-worker.example.com'],
			rateLimitMaxRequests: 2,
			rateLimitWindowMs: 1000,
		},
		rateLimitClock: () => now,
	}).listen(0, '127.0.0.1')
	await once(server, 'listening')
	t.after(() => new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))))
	const address = server.address()
	assert.ok(address && typeof address === 'object')
	const url = `http://127.0.0.1:${address.port}/waitqueue/scheduler/addTask`
	const queueUrl = `http://127.0.0.1:${address.port}/waitqueue/queue/newQueue`
	const body = JSON.stringify({
		hookUrl: 'https://private-worker.example.com/callback',
		namespace: 'billing',
		taskId: 'private-task-id',
	})

	assert.equal(
		(
			await fetch(url, {
				method: 'POST',
				headers: { 'content-type': 'application/json', authorization: 'Bearer audit-secret-token' },
				body,
			})
		).status,
		200
	)
	assert.equal(
		(
			await fetch(queueUrl, {
				method: 'POST',
				headers: {
					'content-type': 'application/json',
					authorization: 'Bearer audit-secret-token',
					cookie: 'session=private-cookie-value',
				},
				body: JSON.stringify({
					hookUrl: 'https://private-worker.example.com/callback',
					namespace: 'billing',
				}),
			})
		).status,
		200
	)
	assert.equal(
		(
			await fetch(url, {
				method: 'POST',
				headers: { 'content-type': 'application/json', authorization: 'Bearer audit-secret-token' },
				body,
			})
		).status,
		429
	)
	now = 1000
	assert.equal(
		(
			await fetch(url, {
				method: 'POST',
				headers: { 'content-type': 'application/json', authorization: 'Bearer wrong-secret-token' },
				body,
			})
		).status,
		401
	)

	const records = lines
		.join('')
		.trim()
		.split('\n')
		.filter(Boolean)
		.map(JSON.parse)
	const audits = records.filter((record) => record.audit?.event === 'api_audit')
	assert.ok(
		audits.some(
			(record) =>
				record.audit.action === 'task.enqueue' &&
				record.audit.outcome === 'succeeded' &&
				record.audit.statusCode === 200 &&
				Number.isInteger(record.audit.durationMs)
		)
	)
	assert.equal(
		timerHookUrlPolicy?.configurationKey,
		new HookUrlPolicy(['https://private-worker.example.com']).configurationKey,
		'route validation and scheduled callbacks must share the same hook URL policy'
	)
	assert.ok(
		audits.some(
			(record) => record.audit.action === 'queue.configure' && record.audit.statusCode === 200
		)
	)
	assert.ok(
		audits.some((record) => record.audit.action === 'rate_limit.denied' && record.audit.statusCode === 429)
	)
	assert.ok(audits.some((record) => record.audit.action === 'auth.denied' && record.audit.statusCode === 401))

	const serialized = JSON.stringify(records)
	assert.doesNotMatch(serialized, /audit-secret-token|wrong-secret-token|private-cookie-value/)
	assert.doesNotMatch(serialized, /private-worker\.example\.com|private-task-id/)
	assert.ok(records.every((record) => record.req?.headers === undefined))
})

test('error serialization drops messages, SQL parameters, command arguments, and causes', async (t) => {
	const originalFindOrCreate = QueueDao.findOrCreate
	const sensitiveError = new Error(
		'database failure for https://secret-worker.example/callback and private-task-id'
	)
	sensitiveError.code = 'ER_SYNTHETIC'
	sensitiveError.sql = 'INSERT INTO queue VALUES ("https://secret-worker.example/callback")'
	sensitiveError.parameters = ['private-task-id']
	sensitiveError.command = { args: ['private-api-token'] }
	sensitiveError.cause = new Error('private-cause-value')
	QueueDao.findOrCreate = async () => {
		throw sensitiveError
	}
	t.after(() => {
		QueueDao.findOrCreate = originalFindOrCreate
	})

	const lines = []
	const server = createApp({
		requestLogStream: logSink(lines),
		security: { apiToken: 'private-api-token' },
	}).listen(0, '127.0.0.1')
	await once(server, 'listening')
	t.after(() => new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))))
	const address = server.address()
	assert.ok(address && typeof address === 'object')
	const response = await fetch(
		`http://127.0.0.1:${address.port}/waitqueue/queue/newQueue?token=private-query-secret&hookUrl=private-query-url`,
		{
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				authorization: 'Bearer private-api-token',
			},
			body: JSON.stringify({
				hookUrl: 'https://secret-worker.example/callback',
				namespace: 'billing',
			}),
		}
	)
	assert.equal(response.status, 500)
	assert.equal((await response.json()).msg, 'internal server error')
	const unknownPathResponse = await fetch(
		`http://127.0.0.1:${address.port}/waitqueue/private-path-secret?token=private-unknown-query`,
		{
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				authorization: 'Bearer private-api-token',
			},
			body: '{}',
		}
	)
	assert.equal(unknownPathResponse.status, 404)

	const serialized = lines.join('')
	assert.doesNotMatch(
		serialized,
		/private-api-token|private-query-secret|private-query-url|private-path-secret|private-unknown-query|secret-worker\.example|private-task-id|private-cause-value|INSERT INTO/
	)
	const records = serialized
		.trim()
		.split('\n')
		.filter(Boolean)
		.map(JSON.parse)
	const errorRecord = records.find((record) => record.err?.code === 'ER_SYNTHETIC')
	assert.deepEqual(errorRecord?.err, { type: 'Error', code: 'ER_SYNTHETIC' })
	assert.ok(
		records.some(
			(record) =>
				record.req?.method === 'POST' &&
				record.req.path === '/waitqueue/queue/newQueue' &&
				record.req.url === undefined
		),
		'request logs must contain only a canonical path without URL queries'
	)
	assert.ok(
		records.some(
			(record) =>
				record.audit?.action === 'queue.configure' &&
				record.audit.outcome === 'failed' &&
				record.audit.statusCode === 500
		),
		'failed write attempts must remain auditable without serializing their payloads'
	)
	assert.ok(
		records.some(
			(record) =>
				record.audit?.action === 'api.write' &&
				record.audit.path === '/waitqueue/[unmatched]' &&
				record.audit.statusCode === 404
		),
		'unknown write paths must be normalized before audit logging'
	)
})
