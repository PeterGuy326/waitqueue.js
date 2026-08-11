const test = require('node:test')
const assert = require('node:assert/strict')

const {
	DEFAULT_QUEUE_CONCURRENCY,
	DEFAULT_QUEUE_CRONTAB,
	validateAddTaskInput,
	validateDeadLetterQuery,
	validateNewQueueInput,
	validateReplayDeadLetterInput,
} = require('../dist/utils/validation.js')
const { HttpError } = require('../dist/utils/http_error.js')

function assertBadRequest(action, messagePattern) {
	assert.throws(action, (error) => {
		assert.ok(error instanceof HttpError)
		assert.equal(error.status, 400)
		assert.match(error.message, messagePattern)
		return true
	})
}

test('new queue validation supplies concurrency and cron defaults', () => {
	const result = validateNewQueueInput({
		hookUrl: 'https://worker.example.com/tasks',
		namespace: 'billing',
	})

	assert.deepEqual(result, {
		hookUrl: 'https://worker.example.com/tasks',
		namespace: 'billing',
		currMaxCount: DEFAULT_QUEUE_CONCURRENCY,
		crontab: { ...DEFAULT_QUEUE_CRONTAB },
	})
})

test('new queue validation accepts boundary concurrency and normalizes strings', () => {
	for (const currMaxCount of [1, 1000]) {
		const result = validateNewQueueInput({
			hookUrl: '  http://worker.example.com/hook  ',
			namespace: '  reports  ',
			currMaxCount,
			crontab: {
				run: ' */5 * * * * * ',
				check: '*/10 * * * * *',
				expire: '0 * * * * *',
			},
		})

		assert.equal(result.hookUrl, 'http://worker.example.com/hook')
		assert.equal(result.namespace, 'reports')
		assert.equal(result.currMaxCount, currMaxCount)
		assert.equal(result.crontab.run, '*/5 * * * * *')
	}
})

test('new queue validation rejects malformed bodies and required fields', () => {
	assertBadRequest(() => validateNewQueueInput(null), /JSON object/)
	assertBadRequest(() => validateNewQueueInput([]), /JSON object/)
	assertBadRequest(() => validateNewQueueInput({ namespace: 'billing' }), /hookUrl is required/)
	assertBadRequest(
		() => validateNewQueueInput({ hookUrl: 'https://worker.example.com', namespace: '   ' }),
		/namespace is required/
	)
})

test('new queue validation rejects unsafe URLs, invalid concurrency, and invalid cron', () => {
	const base = { hookUrl: 'https://worker.example.com/tasks', namespace: 'billing' }

	assertBadRequest(() => validateNewQueueInput({ ...base, hookUrl: 'file:///tmp/task' }), /valid HTTP\(S\) URL/)
	for (const currMaxCount of [0, 1001, 1.5, '5']) {
		assertBadRequest(() => validateNewQueueInput({ ...base, currMaxCount }), /integer between 1 and 1000/)
	}
	assertBadRequest(
		() => validateNewQueueInput({ ...base, crontab: { run: 'not-a-cron' } }),
		/crontab\.run is not a valid cron expression/
	)
	assertBadRequest(
		() => validateNewQueueInput({ ...base, crontab: { check: '0'.repeat(65) } }),
		/crontab\.check must be at most 64 characters/
	)
})

test('add task validation accepts and normalizes a valid request', () => {
	assert.deepEqual(
		validateAddTaskInput({
			hookUrl: ' https://worker.example.com/tasks ',
			namespace: ' billing ',
			taskId: ' invoice-42 ',
		}),
		{
			hookUrl: 'https://worker.example.com/tasks',
			namespace: 'billing',
			taskId: 'invoice-42',
		}
	)
})

test('add task validation rejects invalid URLs and task ids', () => {
	const base = { hookUrl: 'https://worker.example.com/tasks', namespace: 'billing' }

	assertBadRequest(() => validateAddTaskInput(base), /taskId is required/)
	assertBadRequest(() => validateAddTaskInput({ ...base, taskId: ' '.repeat(3) }), /taskId is required/)
	assertBadRequest(() => validateAddTaskInput({ ...base, taskId: 'x'.repeat(257) }), /at most 256 characters/)
	assertBadRequest(
		() => validateAddTaskInput({ ...base, hookUrl: 'redis://worker/tasks', taskId: 'task-1' }),
		/valid HTTP\(S\) URL/
	)
})

test('dead letter query validation normalizes pagination and enforces bounds', () => {
	assert.deepEqual(validateDeadLetterQuery({ queueId: '7' }), {
		queueId: 7,
		offset: 0,
		limit: 50,
	})
	assert.deepEqual(validateDeadLetterQuery({ queueId: 7, offset: '25', limit: '100' }), {
		queueId: 7,
		offset: 25,
		limit: 100,
	})
	for (const query of [
		{},
		{ queueId: '0' },
		{ queueId: '7', offset: '-1' },
		{ queueId: '7', limit: '101' },
		{ queueId: '7', limit: ['10'] },
	]) {
		assertBadRequest(() => validateDeadLetterQuery(query), /queueId|offset|limit/)
	}
})

test('dead letter replay validation requires a generation-safe entry id', () => {
	assert.deepEqual(
		validateReplayDeadLetterInput({
			queueId: 7,
			taskId: ' task-1 ',
			entryId: ' 33d443d1-17aa-45c7-958a-f21b39b25ea2 ',
		}),
		{
			queueId: 7,
			taskId: 'task-1',
			entryId: '33d443d1-17aa-45c7-958a-f21b39b25ea2',
		}
	)
	assertBadRequest(
		() => validateReplayDeadLetterInput({ queueId: 7, taskId: 'task-1', entryId: 'bad entry' }),
		/entryId/
	)
})
