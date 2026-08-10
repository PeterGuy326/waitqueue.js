const test = require('node:test')
const assert = require('node:assert/strict')

const { getRunningKey, getWaitingKey } = require('../dist/common/cache.js')

test('cache keys follow the public queue key contract', () => {
	assert.equal(getWaitingKey('billing', 42), 'TaskQueue:billing:42:waitingQueue')
	assert.equal(getRunningKey('billing', 42), 'TaskQueue:billing:42:runningHashKv')
})

test('cache keys isolate namespaces, queue ids, and queue states', () => {
	const keys = new Set([
		getWaitingKey('billing', 1),
		getWaitingKey('email', 1),
		getWaitingKey('billing', 2),
		getRunningKey('billing', 1),
	])

	assert.equal(keys.size, 4)
})
