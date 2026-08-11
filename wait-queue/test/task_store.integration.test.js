const test = require('node:test')
const assert = require('node:assert/strict')
const { randomUUID } = require('node:crypto')
const Redis = require('ioredis')

const { createReliabilityConfig } = require('../dist/reliability/config.js')
const { RedisTaskStore } = require('../dist/reliability/task_store.js')

const redisUrl = process.env.WAITQUEUE_REDIS_INTEGRATION_URL

function redisTest(name, fn) {
	test(name, { skip: redisUrl ? false : 'WAITQUEUE_REDIS_INTEGRATION_URL is not configured' }, fn)
}

async function harness(t, reliability, initialNow = 1_000_000) {
	const clients = [new Redis(redisUrl), new Redis(redisUrl)]
	await Promise.all(clients.map((client) => client.ping()))
	let now = initialNow
	const namespace = `integration-${randomUUID()}`
	const queueId = 7
	const clock = () => now
	const stores = clients.map(
		(client) => new RedisTaskStore(client, namespace, queueId, reliability, clock)
	)
	t.after(async () => {
		await clients[0].del(...Object.values(stores[0].keys))
		await Promise.all(clients.map((client) => client.quit()))
	})
	return {
		clients,
		stores,
		setNow(value) {
			now = value
		},
	}
}

redisTest('two Redis clients atomically respect the shared concurrency limit', async (t) => {
	const reliability = createReliabilityConfig({
		claimLeaseMs: 1000,
		maxRetries: 2,
		retryBaseDelayMs: 100,
		retryMaxDelayMs: 400,
	})
	const { clients, stores } = await harness(t, reliability)
	for (let index = 1; index <= 5; index += 1) {
		assert.equal(await stores[0].enqueue(`task-${index}`), true)
	}

	const batches = await Promise.all([stores[0].claim(3), stores[1].claim(3)])
	const claims = batches.flatMap((batch) => batch.claims)
	assert.equal(claims.length, 3)
	assert.equal(new Set(claims.map((claim) => claim.taskId)).size, 3)
	assert.equal(new Set(claims.map((claim) => claim.claimToken)).size, 3)
	assert.equal(await clients[0].hlen(stores[0].keys.running), 3)
	assert.equal(await clients[0].llen(stores[0].keys.waiting), 2)
})

redisTest('failure backoff is bounded, exhausts into DLQ, and replay is generation-safe', async (t) => {
	const reliability = createReliabilityConfig({
		claimLeaseMs: 1000,
		maxRetries: 2,
		retryBaseDelayMs: 100,
		retryMaxDelayMs: 150,
	})
	const state = await harness(t, reliability)
	const [store, competingStore] = state.stores
	assert.equal(await store.enqueue('task-1'), true)
	assert.equal(await store.enqueue('task-1'), false, 'an active taskId is an idempotency key')

	const first = (await store.claim(1)).claims[0]
	assert.ok(first)
	assert.deepEqual(await store.fail(first), {
		outcome: 'retry',
		retryCount: 1,
		dueAt: 1_000_100,
	})
	state.setNow(1_000_099)
	assert.equal((await store.claim(1)).claims.length, 0)

	state.setNow(1_000_100)
	const second = (await competingStore.claim(1)).claims[0]
	assert.ok(second)
	assert.notEqual(second.claimToken, first.claimToken)
	assert.equal(await store.acknowledge(first), false)
	assert.equal((await store.fail(first)).outcome, 'stale')
	assert.deepEqual(await competingStore.fail(second), {
		outcome: 'retry',
		retryCount: 2,
		dueAt: 1_000_250,
	})

	state.setNow(1_000_249)
	assert.equal((await store.claim(1)).claims.length, 0)
	state.setNow(1_000_250)
	const third = (await store.claim(1)).claims[0]
	assert.ok(third)
	assert.deepEqual(await store.fail(third), { outcome: 'dead', retryCount: 2 })

	const firstDeadPage = await store.listDeadLetters(0, 10)
	assert.equal(firstDeadPage.total, 1)
	assert.equal(firstDeadPage.items.length, 1)
	assert.equal(firstDeadPage.items[0].taskId, 'task-1')
	assert.equal(firstDeadPage.items[0].retryCount, 2)
	assert.equal(firstDeadPage.items[0].reason, 'callback_failed')
	const firstEntryId = firstDeadPage.items[0].entryId
	assert.equal(await store.replayDeadLetter('task-1', 'wrong-entry'), 'stale')

	const replayResults = await Promise.all([
		store.replayDeadLetter('task-1', firstEntryId),
		competingStore.replayDeadLetter('task-1', firstEntryId),
	])
	assert.deepEqual(replayResults.sort(), ['missing', 'replayed'])
	assert.equal(await state.clients[0].llen(store.keys.waiting), 1)

	const noRetryStore = new RedisTaskStore(
		state.clients[0],
		store.keys.waiting.split(':')[1],
		7,
		createReliabilityConfig({
			claimLeaseMs: 1000,
			maxRetries: 0,
			retryBaseDelayMs: 100,
			retryMaxDelayMs: 100,
		}),
		() => 1_000_300
	)
	// Use the exact same key family; the namespace is stable and contains no colon.
	assert.deepEqual(noRetryStore.keys, store.keys)
	const replayedClaim = (await noRetryStore.claim(1)).claims[0]
	assert.ok(replayedClaim)
	assert.equal((await noRetryStore.fail(replayedClaim)).outcome, 'dead')
	const secondDeadPage = await noRetryStore.listDeadLetters(0, 10)
	const secondEntryId = secondDeadPage.items[0].entryId
	assert.notEqual(secondEntryId, firstEntryId)
	assert.equal(await store.replayDeadLetter('task-1', firstEntryId), 'stale')
	assert.equal(await store.replayDeadLetter('task-1', secondEntryId), 'replayed')
})

redisTest('acknowledged long tasks are not reclaimed after the dispatch lease', async (t) => {
	const reliability = createReliabilityConfig({
		claimLeaseMs: 1000,
		maxRetries: 1,
		retryBaseDelayMs: 100,
		retryMaxDelayMs: 100,
	})
	const state = await harness(t, reliability)
	const store = state.stores[0]
	await store.enqueue('long-task')
	const claim = (await store.claim(1)).claims[0]
	assert.equal(await store.acknowledge(claim), true)

	state.setNow(9_000_000)
	const later = await store.claim(1)
	assert.equal(later.recovered, 0)
	assert.equal(later.claims.length, 0)
	assert.match((await store.runningSnapshot())['long-task'], /^ack:/)
	assert.equal((await store.listDeadLetters(0, 10)).total, 0)
})

redisTest('repeated process-crash lease recovery consumes the retry budget', async (t) => {
	const reliability = createReliabilityConfig({
		claimLeaseMs: 1000,
		maxRetries: 2,
		retryBaseDelayMs: 100,
		retryMaxDelayMs: 200,
	})
	const state = await harness(t, reliability)
	const store = state.stores[0]
	await store.enqueue('crash-loop-task')
	assert.ok((await store.claim(1)).claims[0])

	state.setNow(1_001_000)
	assert.equal((await store.claim(1)).recovered, 1)
	state.setNow(1_001_100)
	assert.ok((await store.claim(1)).claims[0])

	state.setNow(1_002_100)
	assert.equal((await store.claim(1)).recovered, 1)
	state.setNow(1_002_300)
	assert.ok((await store.claim(1)).claims[0])

	state.setNow(1_003_300)
	const exhausted = await store.claim(1)
	assert.equal(exhausted.recovered, 1)
	assert.equal(exhausted.deadLettered, 1)
	assert.equal(exhausted.claims.length, 0)
	const deadLetters = await store.listDeadLetters(0, 10)
	assert.equal(deadLetters.total, 1)
	assert.equal(deadLetters.items[0].retryCount, 2)
	assert.equal(deadLetters.items[0].reason, 'lease_expired')
})

redisTest('legacy and crashed pending claims receive grace then recover exactly once', async (t) => {
	const reliability = createReliabilityConfig({
		claimLeaseMs: 1000,
		maxRetries: 1,
		retryBaseDelayMs: 100,
		retryMaxDelayMs: 100,
	})
	const state = await harness(t, reliability)
	const [store, competingStore] = state.stores
	await state.clients[0].hset(store.keys.running, 'legacy-task', 'old-raw-token')
	await state.clients[0].lpush(store.keys.waiting, 'legacy-waiting-task', 'legacy-task')
	assert.equal(await store.enqueue('legacy-task'), false)
	assert.equal(await store.enqueue('legacy-waiting-task'), false)
	assert.equal(await state.clients[0].llen(store.keys.waiting), 2)

	const grace = await store.claim(1)
	assert.equal(grace.recovered, 0)
	assert.equal(await state.clients[0].zscore(store.keys.leases, 'legacy-task'), '1001000')
	assert.equal(await state.clients[0].hget(store.keys.state, 'legacy-task'), 'pending')
	assert.equal(await state.clients[0].get(store.keys.migration), 'complete')

	state.setNow(1_001_000)
	const recovery = await Promise.all([store.claim(0), competingStore.claim(0)])
	assert.equal(recovery.reduce((total, batch) => total + batch.recovered, 0), 1)
	assert.equal(await state.clients[0].hlen(store.keys.running), 0)
	assert.equal(await state.clients[0].zscore(store.keys.retrySchedule, 'legacy-task'), '1001100')

	const lateRelease = await store.release(
		{ 'legacy-task': 'old-raw-token' },
		['legacy-task']
	)
	assert.deepEqual(lateRelease, ['legacy-task'])
	assert.equal(await state.clients[0].zscore(store.keys.retrySchedule, 'legacy-task'), null)
	assert.equal((await store.listDeadLetters(0, 10)).total, 0)
	const legacyWaitingClaim = (await store.claim(1)).claims[0]
	assert.equal(legacyWaitingClaim.taskId, 'legacy-waiting-task')
	assert.match(await state.clients[0].hget(store.keys.generation, 'legacy-waiting-task'), /^legacy:/)
})

redisTest('late release tokens cannot clean a newer generation with the same taskId', async (t) => {
	const reliability = createReliabilityConfig({
		claimLeaseMs: 1000,
		maxRetries: 1,
		retryBaseDelayMs: 100,
		retryMaxDelayMs: 100,
	})
	const state = await harness(t, reliability)
	const [store, competingStore] = state.stores
	await store.enqueue('aba-task')
	const firstClaim = (await store.claim(1)).claims[0]
	assert.equal(await store.acknowledge(firstClaim), true)
	const firstSnapshot = await store.runningSnapshot()
	assert.deepEqual(await store.release(firstSnapshot, ['aba-task']), ['aba-task'])

	assert.equal(await competingStore.enqueue('aba-task'), true)
	const secondClaim = (await competingStore.claim(1)).claims[0]
	assert.ok(secondClaim)
	assert.notEqual(secondClaim.claimToken, firstClaim.claimToken)
	assert.deepEqual(await store.release(firstSnapshot, ['aba-task']), [])
	assert.equal((await competingStore.runningSnapshot())['aba-task'], secondClaim.claimToken)

	assert.equal((await competingStore.fail(secondClaim)).outcome, 'retry')
	state.setNow(1_000_100)
	const thirdClaim = (await store.claim(1)).claims[0]
	assert.ok(thirdClaim)
	assert.notEqual(thirdClaim.claimToken, secondClaim.claimToken)
	assert.deepEqual(
		await competingStore.release({ 'aba-task': secondClaim.claimToken }, ['aba-task']),
		[]
	)
	assert.equal((await store.runningSnapshot())['aba-task'], thirdClaim.claimToken)
})

redisTest('legacy waiting migration is bounded and restores steady-state O(1) membership', async (t) => {
	const reliability = createReliabilityConfig({
		claimLeaseMs: 1000,
		maxRetries: 1,
		retryBaseDelayMs: 100,
		retryMaxDelayMs: 100,
	})
	const state = await harness(t, reliability)
	const store = state.stores[0]
	const legacyTaskIds = Array.from({ length: 1001 }, (_, index) => `legacy-batch-${index + 1}`)
	await state.clients[0].lpush(store.keys.waiting, ...legacyTaskIds)

	await store.claim(0)
	assert.equal(await state.clients[0].get(store.keys.migration), 'in-progress')
	assert.equal(await state.clients[0].llen(store.keys.waiting), 1)
	assert.equal(await state.clients[0].llen(store.keys.migrationWaiting), 1000)
	assert.equal(await store.enqueue('legacy-batch-1'), false)
	assert.equal(await store.enqueue('legacy-batch-1001'), false)

	await store.claim(0)
	assert.equal(await state.clients[0].get(store.keys.migration), 'complete')
	assert.equal(await state.clients[0].exists(store.keys.migrationWaiting), 0)
	assert.equal(await state.clients[0].llen(store.keys.waiting), 1001)
	assert.equal(await state.clients[0].hlen(store.keys.state), 1001)
	assert.equal(await store.enqueue('steady-state-new-task'), true)
	assert.equal(await store.enqueue('steady-state-new-task'), false)
})
