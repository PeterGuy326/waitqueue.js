const test = require('node:test')
const assert = require('node:assert/strict')
const { spawnSync } = require('node:child_process')

const {
	createReliabilityConfig,
	readReliabilityConfig,
} = require('../dist/reliability/config.js')

test('reliability configuration provides bounded, production-safe defaults', () => {
	assert.deepEqual(readReliabilityConfig({}), {
		claimLeaseMs: 60000,
		maxRetries: 5,
		retryBaseDelayMs: 1000,
		retryMaxDelayMs: 60000,
	})

	assert.deepEqual(
		readReliabilityConfig({
			TASK_CLAIM_LEASE_MS: '120000',
			TASK_MAX_RETRIES: '3',
			TASK_RETRY_BASE_DELAY_MS: '250',
			TASK_RETRY_MAX_DELAY_MS: '10000',
		}),
		{
			claimLeaseMs: 120000,
			maxRetries: 3,
			retryBaseDelayMs: 250,
			retryMaxDelayMs: 10000,
		}
	)
})

test('reliability configuration rejects unsafe or ambiguous values', () => {
	for (const environment of [
		{ TASK_CLAIM_LEASE_MS: '999' },
		{ TASK_MAX_RETRIES: '-1' },
		{ TASK_MAX_RETRIES: '101' },
		{ TASK_RETRY_BASE_DELAY_MS: '1.5' },
		{ TASK_RETRY_MAX_DELAY_MS: '0' },
	]) {
		assert.throws(() => readReliabilityConfig(environment))
	}
	assert.throws(() =>
		createReliabilityConfig({ retryBaseDelayMs: 1000, retryMaxDelayMs: 999 })
	)
})

test('application startup rejects a claim lease that cannot cover the callback timeout', () => {
	const envModule = require.resolve('../dist/conf/env.js')
	const result = spawnSync(process.execPath, ['-e', `require(${JSON.stringify(envModule)})`], {
		env: {
			...process.env,
			HOOK_TIMEOUT_MS: '60000',
			TASK_CLAIM_LEASE_MS: '60000',
		},
		encoding: 'utf8',
	})
	assert.notEqual(result.status, 0)
	assert.match(result.stderr, /TASK_CLAIM_LEASE_MS must be greater than HOOK_TIMEOUT_MS/)
})
