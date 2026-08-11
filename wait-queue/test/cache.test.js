const test = require('node:test')
const assert = require('node:assert/strict')

const {
	getClaimLeaseKey,
	getDeadLetterKey,
	getDeadLetterOrderKey,
	getEnqueuedAtKey,
	getRetryCountKey,
	getRetryScheduleKey,
	getRetryTokenKey,
	getReliabilityMigrationKey,
	getReliabilityMigrationWaitingKey,
	getRunningKey,
	getRunningAuditCursorKey,
	getTaskGenerationKey,
	getTaskStateKey,
	getWaitingKey,
} = require('../dist/common/cache.js')

test('cache keys follow the public queue key contract', () => {
	assert.equal(getWaitingKey('billing', 42), 'TaskQueue:billing:42:waitingQueue')
	assert.equal(getRunningKey('billing', 42), 'TaskQueue:billing:42:runningHashKv')
	assert.equal(getClaimLeaseKey('billing', 42), 'TaskQueue:billing:42:claimLeaseZset')
	assert.equal(getRetryScheduleKey('billing', 42), 'TaskQueue:billing:42:retryScheduleZset')
	assert.equal(getRetryCountKey('billing', 42), 'TaskQueue:billing:42:retryCountHashKv')
	assert.equal(getRetryTokenKey('billing', 42), 'TaskQueue:billing:42:retryTokenHashKv')
	assert.equal(getDeadLetterKey('billing', 42), 'TaskQueue:billing:42:deadLetterHashKv')
	assert.equal(getDeadLetterOrderKey('billing', 42), 'TaskQueue:billing:42:deadLetterZset')
	assert.equal(getEnqueuedAtKey('billing', 42), 'TaskQueue:billing:42:enqueuedAtHashKv')
	assert.equal(getTaskStateKey('billing', 42), 'TaskQueue:billing:42:taskStateHashKv')
	assert.equal(getTaskGenerationKey('billing', 42), 'TaskQueue:billing:42:taskGenerationHashKv')
	assert.equal(getReliabilityMigrationKey('billing', 42), 'TaskQueue:billing:42:reliabilityMigrationV1')
	assert.equal(
		getReliabilityMigrationWaitingKey('billing', 42),
		'TaskQueue:billing:42:reliabilityMigrationWaitingV1'
	)
	assert.equal(getRunningAuditCursorKey('billing', 42), 'TaskQueue:billing:42:runningAuditCursorV1')
})

test('cache keys isolate namespaces, queue ids, and queue states', () => {
	const keys = new Set([
		getWaitingKey('billing', 1),
		getWaitingKey('email', 1),
		getWaitingKey('billing', 2),
		getRunningKey('billing', 1),
		getClaimLeaseKey('billing', 1),
		getRetryScheduleKey('billing', 1),
		getDeadLetterKey('billing', 1),
		getReliabilityMigrationKey('billing', 1),
		getReliabilityMigrationWaitingKey('billing', 1),
		getRunningAuditCursorKey('billing', 1),
	])

	assert.equal(keys.size, 10)
})
