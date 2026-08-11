const test = require('node:test')
const assert = require('node:assert/strict')

function replaceModule(modulePath, exports) {
	require.cache[modulePath] = {
		id: modulePath,
		filename: modulePath,
		loaded: true,
		exports,
	}
}

const redisConfigPath = require.resolve('../dist/conf/redis.js')
replaceModule(redisConfigPath, { redisCli: { getInstance: () => ({}) } })

const { TaskManager } = require('../dist/lib/task_manager.js')
const { TaskRun } = require('../dist/lib/task_run.js')

function createContext() {
	return {
		log: { info() {}, error() {} },
		zipkinTraceId: { traceId: 'test-trace' },
	}
}

function createManager(taskRunningCount, redis, taskRunner) {
	const manager = new TaskManager(
		createContext(),
		7,
		'billing',
		'https://worker.example.com/tasks',
		'running',
		'waiting',
		taskRunningCount
	)
	manager.redis = redis
	manager.taskRunInstance = taskRunner
	return manager
}

function createTokenAwareRedis(initialClaims) {
	const running = { ...initialClaims }
	const evalCalls = []
	return {
		running,
		evalCalls,
		async hgetall() {
			return { ...running }
		},
		async eval(...args) {
			evalCalls.push(args)
			const [script, keyCount, runningKey, ...claimPairs] = args
			assert.match(script, /redis\.call\('HGET'/)
			assert.match(script, /redis\.call\('HDEL'/)
			assert.equal(keyCount, 1)
			assert.equal(runningKey, 'running')

			const released = []
			for (let index = 0; index < claimPairs.length; index += 2) {
				const taskId = claimPairs[index]
				const snapshotToken = claimPairs[index + 1]
				if (running[taskId] === snapshotToken) {
					delete running[taskId]
					released.push(taskId)
				}
			}
			return released
		},
	}
}

test('runTask claims atomically up to the configured limit and dispatches only claimed tasks', async () => {
	const evalCalls = []
	const runCalls = []
	const redis = {
		async eval(...args) {
			evalCalls.push(args)
			return ['task-1', 'claim-1', Buffer.from('task-2'), Buffer.from('claim-2')]
		},
	}
	const taskRunner = {
		async run(taskId) {
			runCalls.push(taskId)
		},
	}
	const manager = createManager(2, redis, taskRunner)

	await manager.runTask()
	await Promise.resolve()

	assert.equal(evalCalls.length, 1)
	assert.match(evalCalls[0][0], /redis\.call\('HLEN'/)
	assert.match(evalCalls[0][0], /redis\.call\('HSET'.*claimToken/s)
	assert.deepEqual(evalCalls[0].slice(1, 5), [2, 'waiting', 'running', 2])
	assert.match(evalCalls[0][5], /^[0-9a-f-]{36}$/)
	assert.deepEqual(runCalls, ['task-1', 'task-2'])
})

test('runTask ignores invalid concurrency without touching Redis', async () => {
	let evalCount = 0
	const redis = { async eval() { evalCount += 1 } }
	const taskRunner = { async before() {}, async run() {}, after() {} }

	for (const count of [0, -1, Number.NaN]) {
		await createManager(count, redis, taskRunner).runTask()
	}

	assert.equal(evalCount, 0)
})

test('dispatchTask releases the running slot and requeues when dispatch fails', async () => {
	const evalCalls = []
	const redis = {
		async eval(...args) {
			evalCalls.push(args)
			return 1
		},
	}
	const taskRunner = {
		async run() {
			throw new Error('worker unavailable')
		},
	}

	await createManager(1, redis, taskRunner).dispatchTask({ taskId: 'task-1', claimToken: 'claim-1' })

	assert.equal(evalCalls.length, 1)
	assert.match(evalCalls[0][0], /redis\.call\('HGET'/)
	assert.match(evalCalls[0][0], /redis\.call\('LPUSH'/)
	assert.deepEqual(evalCalls[0].slice(1), [2, 'running', 'waiting', 'task-1', 'claim-1'])
})

test('TaskRun failure propagates so TaskManager releases the slot and requeues the task', async () => {
	const evalCalls = []
	const redis = {
		async eval(...args) {
			evalCalls.push(args)
			return 1
		},
	}
	const context = createContext()
	const manager = createManager(1, redis, {})
	const taskRun = new TaskRun(context, 'https://worker.example.com/tasks', 7, 'billing')
	const callbackError = new Error('callback returned HTTP 503')
	taskRun._run = async () => {
		throw callbackError
	}
	manager.taskRunInstance = taskRun

	await manager.dispatchTask({ taskId: 'task-1', claimToken: 'claim-1' })

	assert.equal(evalCalls.length, 1)
	assert.deepEqual(evalCalls[0].slice(1), [2, 'running', 'waiting', 'task-1', 'claim-1'])
})

test('checkTaskStatus keeps a newer claim when the snapshot token is stale', async () => {
	const redis = createTokenAwareRedis({ 'task-1': 'old-claim', 'task-2': 'steady-claim' })
	const taskRunner = {
		async checkTaskStatus(taskIds) {
			assert.deepEqual(taskIds.sort(), ['task-1', 'task-2'])
			redis.running['task-1'] = 'new-claim'
			return ['task-1', 'task-2', 'task-2']
		},
	}

	await createManager(2, redis, taskRunner).checkTaskStatus()

	assert.deepEqual(redis.running, { 'task-1': 'new-claim' })
	assert.equal(redis.evalCalls.length, 1)
	assert.match(redis.evalCalls[0][0], /redis\.call\('HGET'/)
	assert.deepEqual(redis.evalCalls[0].slice(1), [1, 'running', 'task-1', 'old-claim', 'task-2', 'steady-claim'])
})

test('expireTask keeps a newer claim when the snapshot token is stale', async () => {
	const redis = createTokenAwareRedis({ 'task-1': 'old-claim', 'task-3': 'steady-claim' })
	const taskRunner = {
		async expireTasks() {
			redis.running['task-1'] = 'new-claim'
			return ['task-1', 'task-3']
		},
	}

	await createManager(2, redis, taskRunner).expireTask()

	assert.deepEqual(redis.running, { 'task-1': 'new-claim' })
	assert.equal(redis.evalCalls.length, 1)
	assert.deepEqual(redis.evalCalls[0].slice(1), [1, 'running', 'task-1', 'old-claim', 'task-3', 'steady-claim'])
})
