const test = require('node:test')
const assert = require('node:assert/strict')
const { once } = require('node:events')

const { createApp } = require('../dist/app.js')
const { QueueDao } = require('../dist/dao/queue_dao.js')
const { RedisTaskStore } = require('../dist/reliability/task_store.js')

test('active task ids are idempotency keys and duplicate submissions return 409', async (t) => {
	const originalFindOne = QueueDao.findOne
	const originalEnqueue = RedisTaskStore.prototype.enqueue
	QueueDao.findOne = async () => ({ id: 7, namespace: 'billing' })
	let accepted = false
	RedisTaskStore.prototype.enqueue = async function (taskId) {
		assert.equal(taskId, 'invoice-42')
		return accepted
	}
	t.after(() => {
		QueueDao.findOne = originalFindOne
		RedisTaskStore.prototype.enqueue = originalEnqueue
	})

	const server = createApp().listen(0, '127.0.0.1')
	await once(server, 'listening')
	t.after(() => new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))))
	const address = server.address()
	assert.ok(address && typeof address === 'object')
	const url = `http://127.0.0.1:${address.port}/waitqueue/scheduler/addTask`
	const request = () =>
		fetch(url, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({
				namespace: 'billing',
				hookUrl: 'https://worker.example.com/tasks',
				taskId: 'invoice-42',
			}),
		})

	const duplicate = await request()
	assert.equal(duplicate.status, 409)
	assert.equal((await duplicate.json()).msg, 'task already exists in this queue')

	accepted = true
	const created = await request()
	assert.equal(created.status, 200)
	assert.deepEqual((await created.json()).data, { isOk: true })
})
