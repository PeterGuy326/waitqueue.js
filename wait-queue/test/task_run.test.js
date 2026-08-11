const test = require('node:test')
const assert = require('node:assert/strict')
const http = require('node:http')
const { once } = require('node:events')

const {
	TaskRun,
	createCallbackTransport,
	resolvePinnedCallbackAddresses,
} = require('../dist/lib/task_run.js')
const { HookUrlPolicy } = require('../dist/security/hook_url_policy.js')
const { WaitQueueMetrics } = require('../dist/observability/metrics.js')

function createContext() {
	return {
		log: { info() {}, error() {} },
		zipkinTraceId: { traceId: 'test-trace' },
	}
}

test('run, check, and expire callbacks include queueId and namespace', async (t) => {
	const calls = []
	const callbackTransport = async (url, options) => {
		const body = JSON.parse(options.body)
		calls.push({ url, options, body })
		const responseBody =
			body.type === 'run'
				? ''
				: JSON.stringify({ data: { taskIds: body.type === 'check' ? ['task-2'] : ['task-3'] } })
		return { status: 200, body: responseBody }
	}

	const taskRun = new TaskRun(
		createContext(),
		'https://worker.example.com/tasks',
		7,
		'billing',
		undefined,
		callbackTransport
	)
	await taskRun.run('task-1')
	assert.deepEqual(await taskRun.checkTaskStatus(['task-1', 'task-2']), ['task-2'])
	assert.deepEqual(await taskRun.expireTasks(), ['task-3'])

	assert.equal(calls.length, 3)
	assert.ok(calls.every(({ url }) => url.href === 'https://worker.example.com/tasks'))
	assert.ok(calls.every(({ options }) => options.signal instanceof AbortSignal))
	assert.deepEqual(
		calls.map(({ body }) => body),
		[
			{ type: 'run', queueId: 7, namespace: 'billing', taskIds: ['task-1'] },
			{ type: 'check', queueId: 7, namespace: 'billing', taskIds: ['task-1', 'task-2'] },
			{ type: 'expire', queueId: 7, namespace: 'billing' },
		]
	)
})

test('TaskRun revalidates callback policy before sending and never follows redirects', async (t) => {
	const calls = []
	const callbackTransport = async (url, options) => {
		calls.push({ url, options })
		return { status: 302, body: '' }
	}

	const denied = new TaskRun(
		createContext(),
		'https://blocked.example.com/tasks',
		7,
		'billing',
		new HookUrlPolicy(['https://worker.example.com']),
		callbackTransport
	)
	await assert.rejects(denied.run('private-task-id'), /origin is not allowed/)
	assert.equal(calls.length, 0, 'policy rejection must happen immediately before fetch')

	const redirecting = new TaskRun(
		createContext(),
		'https://worker.example.com/tasks',
		7,
		'billing',
		new HookUrlPolicy(['https://worker.example.com']),
		callbackTransport
	)
	await assert.rejects(redirecting.run('private-task-id'), /returned HTTP 302/)
	assert.equal(calls.length, 1)
})

test('strict callback resolution rejects private DNS answers and pins public answers', async () => {
	const url = new URL('https://worker.example.com/tasks')
	const policy = new HookUrlPolicy(['https://worker.example.com'])
	await assert.rejects(
		resolvePinnedCallbackAddresses(url, policy, async () => [{ address: '127.0.0.1', family: 4 }]),
		/resolved to a private or local address/
	)
	await assert.rejects(
		resolvePinnedCallbackAddresses(url, policy, async () => [{ address: '169.254.169.254', family: 4 }]),
		/resolved to a private or local address/
	)
	assert.deepEqual(
		await resolvePinnedCallbackAddresses(url, policy, async () => [
			{ address: '1.1.1.1', family: 4 },
			{ address: '2001:4860:4860::8888', family: 6 },
		]),
		[
			{ address: '1.1.1.1', family: 4 },
			{ address: '2001:4860:4860::8888', family: 6 },
		]
	)
})

test('pinned callback transport connects with the validated address on Node lookup APIs', async (t) => {
	let receivedBody
	const server = http.createServer((request, response) => {
		const chunks = []
		request.on('data', (chunk) => chunks.push(chunk))
		request.on('end', () => {
			receivedBody = JSON.parse(Buffer.concat(chunks).toString('utf8'))
			response.statusCode = 200
			response.end()
		})
	})
	server.listen(0, '127.0.0.1')
	await once(server, 'listening')
	t.after(() => new Promise((resolve) => server.close(resolve)))
	const address = server.address()
	assert.ok(address && typeof address === 'object')
	const origin = `http://callback.example.test:${address.port}`
	const policy = new HookUrlPolicy([origin])
	policy.assertAllowedAddress = () => {}
	const transport = createCallbackTransport(async (hostname) => {
		assert.equal(hostname, 'callback.example.test')
		return [{ address: '127.0.0.1', family: 4 }]
	})
	const taskRun = new TaskRun(createContext(), `${origin}/callback`, 7, 'billing', policy, transport)

	await taskRun.run('task-1')
	assert.deepEqual(receivedBody, {
		type: 'run',
		queueId: 7,
		namespace: 'billing',
		taskIds: ['task-1'],
	})
})

test('callback timeout also bounds DNS resolution', async () => {
	const policy = new HookUrlPolicy(['https://worker.example.com'])
	const transport = createCallbackTransport(() => new Promise(() => {}))
	const controller = new AbortController()
	const request = transport(new URL('https://worker.example.com/callback'), {
		body: '{}',
		signal: controller.signal,
		hookUrlPolicy: policy,
	})
	controller.abort()
	await assert.rejects(request, (error) => error?.name === 'AbortError')
})

test('default callback transport returns a redirect without requesting its location', async (t) => {
	let redirectedRequests = 0
	const destination = http.createServer((_request, response) => {
		redirectedRequests += 1
		response.end('unexpected')
	})
	destination.listen(0, '127.0.0.1')
	await once(destination, 'listening')
	t.after(() => new Promise((resolve) => destination.close(resolve)))
	const destinationAddress = destination.address()
	assert.ok(destinationAddress && typeof destinationAddress === 'object')

	const redirect = http.createServer((_request, response) => {
		response.writeHead(302, {
			location: `http://127.0.0.1:${destinationAddress.port}/private-destination`,
		})
		response.end()
	})
	redirect.listen(0, '127.0.0.1')
	await once(redirect, 'listening')
	t.after(() => new Promise((resolve) => redirect.close(resolve)))
	const redirectAddress = redirect.address()
	assert.ok(redirectAddress && typeof redirectAddress === 'object')
	const origin = `http://127.0.0.1:${redirectAddress.port}`
	const taskRun = new TaskRun(
		createContext(),
		`${origin}/callback`,
		7,
		'billing',
		new HookUrlPolicy([origin], { allowPrivate: true })
	)

	await assert.rejects(taskRun.run('private-task-id'), /returned HTTP 302/)
	assert.equal(redirectedRequests, 0)
})

test('default callback transport rejects oversized callback responses', async (t) => {
	const server = http.createServer((_request, response) => {
		response.statusCode = 200
		response.end(Buffer.alloc(1_048_577, 'x'))
	})
	server.listen(0, '127.0.0.1')
	await once(server, 'listening')
	t.after(() => new Promise((resolve) => server.close(resolve)))
	const address = server.address()
	assert.ok(address && typeof address === 'object')
	const origin = `http://127.0.0.1:${address.port}`
	const taskRun = new TaskRun(
		createContext(),
		`${origin}/callback`,
		7,
		'billing',
		new HookUrlPolicy([origin], { allowPrivate: true })
	)

	await assert.rejects(taskRun.run('task-1'), /response exceeded the size limit/)
})

test('callback counters include only queue, type, and bounded outcomes', async () => {
	const metrics = new WaitQueueMetrics()
	const transport = async (_url, options) => {
		const { type } = JSON.parse(options.body)
		return type === 'run'
			? { status: 200, body: '' }
			: { status: 200, body: JSON.stringify({ data: { taskIds: [123] } }) }
	}
	const taskRun = new TaskRun(
		createContext(),
		'https://worker.example.com/private-hook',
		7,
		'billing',
		undefined,
		transport,
		metrics
	)

	await taskRun.run('sensitive-task-id')
	await assert.rejects(taskRun.checkTaskStatus(['sensitive-task-id']), /string array/)
	const rendered = metrics.render([])

	assert.match(rendered, /waitqueue_callback_attempts_total\{queue_id="7",type="run",outcome="success"\} 1/)
	assert.match(rendered, /waitqueue_callback_attempts_total\{queue_id="7",type="check",outcome="failure"\} 1/)
	assert.doesNotMatch(rendered, /namespace=/)
	assert.doesNotMatch(rendered, /sensitive-task-id|private-hook|worker\.example\.com/)
})
