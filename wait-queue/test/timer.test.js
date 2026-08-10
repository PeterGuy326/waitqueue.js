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

const cronInstances = []
class FakeCronJob {
	constructor(cron, onTick) {
		if (cron === 'invalid-cron') throw new Error('invalid cron')
		this.cron = cron
		this.onTick = onTick
		this.started = false
		this.stopped = false
		cronInstances.push(this)
	}

	start() {
		this.started = true
	}

	stop() {
		this.stopped = true
	}
}

let queueRows = []
const queueDaoPath = require.resolve('../dist/dao/queue_dao.js')
const taskManagerPath = require.resolve('../dist/lib/task_manager.js')
const cronPath = require.resolve('cron')
replaceModule(queueDaoPath, { QueueDao: { async findAll() { return queueRows } } })
replaceModule(taskManagerPath, {
	TaskManager: class {
		async runTask() {}
		async checkTaskStatus() {}
		async expireTask() {}
	},
})
replaceModule(cronPath, { CronJob: FakeCronJob })

const { Timer } = require('../dist/lib/timer.js')

function createContext() {
	return {
		log: { info() {}, error() {} },
		zipkinTraceId: { traceId: 'test-trace' },
	}
}

function queue(count = 2, overrides = {}) {
	return {
		id: 7,
		namespace: 'billing',
		url: 'https://worker.example.com/tasks',
		count,
		runCrontab: '* * * * * *',
		checkCrontab: '*/10 * * * * *',
		expireCrontab: '0 * * * * *',
		...overrides,
	}
}

test('timer reuses unchanged jobs, replaces changed configuration, and stops deleted queues', async () => {
	const timer = new Timer(createContext())
	queueRows = [queue(2)]

	await timer.initializeQueueList()
	assert.equal(cronInstances.length, 3)
	assert.ok(cronInstances.every((job) => job.started && !job.stopped))

	await timer.initializeQueueList()
	assert.equal(cronInstances.length, 3, 'unchanged queue configuration must reuse jobs')

	queueRows = [queue(3)]
	await timer.initializeQueueList([7])
	assert.equal(cronInstances.length, 6, 'concurrency changes must replace all three jobs')
	assert.ok(cronInstances.slice(0, 3).every((job) => job.stopped))
	assert.ok(cronInstances.slice(3).every((job) => job.started && !job.stopped))

	const activeJobs = [timer.runTaskJobMap, timer.checkTaskJobMap, timer.expireTaskJobMap].map(
		(jobMap) => [...jobMap.values()][0].job
	)
	const candidateStart = cronInstances.length
	queueRows = [
		queue(4, {
			runCrontab: '*/2 * * * * *',
			checkCrontab: '*/3 * * * * *',
			expireCrontab: 'invalid-cron',
		}),
	]
	await assert.rejects(timer.initializeQueueList([7]), /failed to synchronize 1 queue configuration/)
	assert.equal(cronInstances.length, candidateStart + 2, 'the invalid third cron is never constructed')
	assert.deepEqual(
		[timer.runTaskJobMap, timer.checkTaskJobMap, timer.expireTaskJobMap].map(
			(jobMap) => [...jobMap.values()][0].job
		),
		activeJobs,
		'invalid replacement must not partially swap any existing job'
	)
	assert.ok(activeJobs.every((job) => job.started && !job.stopped))
	assert.ok(cronInstances.slice(candidateStart).every((job) => !job.started && !job.stopped))

	queueRows = []
	await timer.initializeQueueList()
	assert.ok(activeJobs.every((job) => job.stopped))
	assert.equal(timer.runTaskJobMap.size, 0)
	assert.equal(timer.checkTaskJobMap.size, 0)
	assert.equal(timer.expireTaskJobMap.size, 0)
})
