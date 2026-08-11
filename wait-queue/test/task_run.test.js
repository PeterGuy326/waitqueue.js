const test = require('node:test')
const assert = require('node:assert/strict')

const { TaskRun } = require('../dist/lib/task_run.js')

function createContext() {
	return {
		log: { info() {}, error() {} },
		zipkinTraceId: { traceId: 'test-trace' },
	}
}

test('run, check, and expire callbacks include queueId and namespace', async (t) => {
	const originalFetch = globalThis.fetch
	const calls = []
	globalThis.fetch = async (url, init) => {
		const body = JSON.parse(init.body)
		calls.push({ url, init, body })
		const responseBody =
			body.type === 'run'
				? ''
				: JSON.stringify({ data: { taskIds: body.type === 'check' ? ['task-2'] : ['task-3'] } })
		return {
			status: 200,
			async text() {
				return responseBody
			},
		}
	}
	t.after(() => {
		globalThis.fetch = originalFetch
	})

	const taskRun = new TaskRun(createContext(), 'https://worker.example.com/tasks', 7, 'billing')
	await taskRun.run('task-1')
	assert.deepEqual(await taskRun.checkTaskStatus(['task-1', 'task-2']), ['task-2'])
	assert.deepEqual(await taskRun.expireTasks(), ['task-3'])

	assert.equal(calls.length, 3)
	assert.ok(calls.every(({ url }) => url === 'https://worker.example.com/tasks'))
	assert.ok(calls.every(({ init }) => init.method === 'POST'))
	assert.ok(calls.every(({ init }) => init.headers['content-type'] === 'application/json'))
	assert.ok(calls.every(({ init }) => init.signal instanceof AbortSignal))
	assert.deepEqual(
		calls.map(({ body }) => body),
		[
			{ type: 'run', queueId: 7, namespace: 'billing', taskIds: ['task-1'] },
			{ type: 'check', queueId: 7, namespace: 'billing', taskIds: ['task-1', 'task-2'] },
			{ type: 'expire', queueId: 7, namespace: 'billing' },
		]
	)
})
