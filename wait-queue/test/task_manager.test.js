const test = require('node:test')
const assert = require('node:assert/strict')

const { TaskManager } = require('../dist/lib/task_manager.js')

function createContext() {
	return {
		log: { info() {}, error() {} },
		zipkinTraceId: { traceId: 'test-trace' },
	}
}

function createStore(overrides = {}) {
	return {
		async claim() {
			return { claims: [], recovered: 0, promoted: 0, deadLettered: 0 }
		},
		async acknowledge() {
			return true
		},
		async fail() {
			return { outcome: 'retry', retryCount: 1, dueAt: 1100 }
		},
		async runningSnapshot() {
			return {}
		},
		async release() {
			return []
		},
		...overrides,
	}
}

function createManager(taskRunningCount, taskStore, taskRunner) {
	return new TaskManager(
		createContext(),
		7,
		'billing',
		'https://worker.example.com/tasks',
		'running',
		'waiting',
		taskRunningCount,
		undefined,
		{ taskStore, taskRunner }
	)
}

test('runTask dispatches only atomically claimed tasks and acknowledges successful delivery', async () => {
	const runCalls = []
	const acknowledgements = []
	const claims = [
		{ taskId: 'task-1', claimToken: 'pending:claim-1' },
		{ taskId: 'task-2', claimToken: 'pending:claim-2' },
	]
	const taskStore = createStore({
		async claim(maxRunning) {
			assert.equal(maxRunning, 2)
			return { claims, recovered: 1, promoted: 1, deadLettered: 0 }
		},
		async acknowledge(claim) {
			acknowledgements.push(claim)
			return true
		},
	})
	const taskRunner = {
		async run(taskId) {
			runCalls.push(taskId)
		},
	}

	await createManager(2, taskStore, taskRunner).runTask()

	assert.deepEqual(runCalls, ['task-1', 'task-2'])
	assert.deepEqual(acknowledgements, claims)
})

test('runTask ignores invalid concurrency without touching the state store', async () => {
	let claimCount = 0
	const taskStore = createStore({
		async claim() {
			claimCount += 1
			return { claims: [], recovered: 0, promoted: 0, deadLettered: 0 }
		},
	})
	const taskRunner = { async run() {} }

	for (const count of [0, -1, Number.NaN]) {
		await createManager(count, taskStore, taskRunner).runTask()
	}

	assert.equal(claimCount, 0)
})

test('dispatch failure transitions the matching claim to delayed retry without acknowledging it', async () => {
	const failures = []
	let acknowledgeCount = 0
	const claim = { taskId: 'task-1', claimToken: 'pending:claim-1' }
	const taskStore = createStore({
		async claim() {
			return { claims: [claim], recovered: 0, promoted: 0, deadLettered: 0 }
		},
		async acknowledge() {
			acknowledgeCount += 1
			return true
		},
		async fail(value) {
			failures.push(value)
			return { outcome: 'retry', retryCount: 1, dueAt: 2000 }
		},
	})
	const taskRunner = {
		async run() {
			throw new Error('worker unavailable')
		},
	}

	await createManager(1, taskStore, taskRunner).runTask()

	assert.deepEqual(failures, [claim])
	assert.equal(acknowledgeCount, 0)
})

test('check ignores dispatching claims and releases only the acknowledged snapshot', async () => {
	const releaseCalls = []
	const taskStore = createStore({
		async runningSnapshot() {
			return {
				'pending-task': 'pending:new-claim',
				'ack-task': 'ack:steady-claim',
				'legacy-task': 'legacy-claim',
			}
		},
		async release(snapshot, taskIds) {
			releaseCalls.push({ snapshot, taskIds })
			return ['ack-task']
		},
	})
	const taskRunner = {
		async checkTaskStatus(taskIds) {
			assert.deepEqual(taskIds, ['ack-task', 'legacy-task'])
			return ['pending-task', 'ack-task']
		},
	}

	await createManager(2, taskStore, taskRunner).checkTaskStatus()

	assert.deepEqual(releaseCalls, [
		{
			snapshot: { 'ack-task': 'ack:steady-claim', 'legacy-task': 'legacy-claim' },
			taskIds: ['pending-task', 'ack-task'],
		},
	])
})

test('expire releases only IDs matched to the acknowledged snapshot', async () => {
	const releaseCalls = []
	const taskStore = createStore({
		async runningSnapshot() {
			return { 'task-1': 'ack:claim-1', 'task-2': 'pending:claim-2' }
		},
		async release(snapshot, taskIds) {
			releaseCalls.push({ snapshot, taskIds })
			return ['task-1']
		},
	})
	const taskRunner = {
		async expireTasks() {
			return ['task-1', 'task-2']
		},
	}

	await createManager(2, taskStore, taskRunner).expireTask()

	assert.deepEqual(releaseCalls, [
		{ snapshot: { 'task-1': 'ack:claim-1' }, taskIds: ['task-1', 'task-2'] },
	])
})
