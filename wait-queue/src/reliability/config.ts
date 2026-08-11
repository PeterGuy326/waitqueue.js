export interface ReliabilityConfig {
	claimLeaseMs: number
	maxRetries: number
	retryBaseDelayMs: number
	retryMaxDelayMs: number
}

export type ReliabilityConfigInput = Partial<ReliabilityConfig>

export const DEFAULT_RELIABILITY_CONFIG: ReliabilityConfig = Object.freeze({
	claimLeaseMs: 60_000,
	maxRetries: 5,
	retryBaseDelayMs: 1_000,
	retryMaxDelayMs: 60_000,
})

function integerInRange(name: string, value: number, minimum: number, maximum: number): number {
	if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
		throw new Error(`${name} must be an integer between ${minimum} and ${maximum}`)
	}
	return value
}

export function createReliabilityConfig(input: ReliabilityConfigInput = {}): ReliabilityConfig {
	const config = {
		claimLeaseMs: integerInRange(
			'TASK_CLAIM_LEASE_MS',
			input.claimLeaseMs ?? DEFAULT_RELIABILITY_CONFIG.claimLeaseMs,
			1_000,
			86_400_000
		),
		maxRetries: integerInRange(
			'TASK_MAX_RETRIES',
			input.maxRetries ?? DEFAULT_RELIABILITY_CONFIG.maxRetries,
			0,
			100
		),
		retryBaseDelayMs: integerInRange(
			'TASK_RETRY_BASE_DELAY_MS',
			input.retryBaseDelayMs ?? DEFAULT_RELIABILITY_CONFIG.retryBaseDelayMs,
			1,
			86_400_000
		),
		retryMaxDelayMs: integerInRange(
			'TASK_RETRY_MAX_DELAY_MS',
			input.retryMaxDelayMs ?? DEFAULT_RELIABILITY_CONFIG.retryMaxDelayMs,
			1,
			86_400_000
		),
	}
	if (config.retryMaxDelayMs < config.retryBaseDelayMs) {
		throw new Error('TASK_RETRY_MAX_DELAY_MS must be greater than or equal to TASK_RETRY_BASE_DELAY_MS')
	}
	return Object.freeze(config)
}

function readInteger(
	environment: NodeJS.ProcessEnv,
	name: string,
	fallback: number
): number {
	const raw = environment[name]
	if (raw === undefined || raw === '') return fallback
	return Number(raw)
}

export function readReliabilityConfig(environment: NodeJS.ProcessEnv = process.env): ReliabilityConfig {
	return createReliabilityConfig({
		claimLeaseMs: readInteger(
			environment,
			'TASK_CLAIM_LEASE_MS',
			DEFAULT_RELIABILITY_CONFIG.claimLeaseMs
		),
		maxRetries: readInteger(environment, 'TASK_MAX_RETRIES', DEFAULT_RELIABILITY_CONFIG.maxRetries),
		retryBaseDelayMs: readInteger(
			environment,
			'TASK_RETRY_BASE_DELAY_MS',
			DEFAULT_RELIABILITY_CONFIG.retryBaseDelayMs
		),
		retryMaxDelayMs: readInteger(
			environment,
			'TASK_RETRY_MAX_DELAY_MS',
			DEFAULT_RELIABILITY_CONFIG.retryMaxDelayMs
		),
	})
}
