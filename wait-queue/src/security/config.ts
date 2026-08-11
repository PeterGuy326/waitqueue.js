import { normalizeAllowedOrigins } from './hook_url_policy'

export interface SecurityConfig {
	apiToken?: string
	hookUrlAllowlist: readonly string[]
	allowPrivateHookUrls: boolean
	requestBodyLimitBytes: number
	rateLimitMaxRequests: number
	rateLimitWindowMs: number
}

export type SecurityConfigInput = Partial<SecurityConfig>

export const DEFAULT_SECURITY_CONFIG: SecurityConfig = Object.freeze({
	apiToken: undefined,
	hookUrlAllowlist: Object.freeze([]),
	allowPrivateHookUrls: false,
	requestBodyLimitBytes: 32_768,
	rateLimitMaxRequests: 0,
	rateLimitWindowMs: 60_000,
})

function assertInteger(name: string, value: number, minimum: number): number {
	if (!Number.isInteger(value) || value < minimum) {
		throw new Error(`${name} must be an integer greater than or equal to ${minimum}`)
	}
	return value
}

function assertBoolean(name: string, value: boolean): boolean {
	if (typeof value !== 'boolean') throw new Error(`${name} must be a boolean`)
	return value
}

function normalizeApiToken(value: string | undefined): string | undefined {
	if (value === undefined || value === '') return undefined
	if (value.trim() === '') throw new Error('WAITQUEUE_API_TOKEN must not contain only whitespace')
	if (/\s/.test(value)) throw new Error('WAITQUEUE_API_TOKEN must not contain whitespace')
	return value
}

export function createSecurityConfig(input: SecurityConfigInput = {}): SecurityConfig {
	const config = {
		apiToken: normalizeApiToken(input.apiToken ?? DEFAULT_SECURITY_CONFIG.apiToken),
		hookUrlAllowlist: normalizeAllowedOrigins(input.hookUrlAllowlist ?? DEFAULT_SECURITY_CONFIG.hookUrlAllowlist),
		allowPrivateHookUrls: assertBoolean(
			'HOOK_URL_ALLOW_PRIVATE',
			input.allowPrivateHookUrls ?? DEFAULT_SECURITY_CONFIG.allowPrivateHookUrls
		),
		requestBodyLimitBytes: assertInteger(
			'REQUEST_BODY_LIMIT_BYTES',
			input.requestBodyLimitBytes ?? DEFAULT_SECURITY_CONFIG.requestBodyLimitBytes,
			1
		),
		rateLimitMaxRequests: assertInteger(
			'RATE_LIMIT_MAX_REQUESTS',
			input.rateLimitMaxRequests ?? DEFAULT_SECURITY_CONFIG.rateLimitMaxRequests,
			0
		),
		rateLimitWindowMs: assertInteger(
			'RATE_LIMIT_WINDOW_MS',
			input.rateLimitWindowMs ?? DEFAULT_SECURITY_CONFIG.rateLimitWindowMs,
			1
		),
	}
	return Object.freeze({ ...config, hookUrlAllowlist: Object.freeze([...config.hookUrlAllowlist]) })
}

function readInteger(
	environment: NodeJS.ProcessEnv,
	name: string,
	fallback: number,
	minimum: number
): number {
	const raw = environment[name]
	if (raw === undefined || raw === '') return fallback
	const value = Number(raw)
	return assertInteger(name, value, minimum)
}

function readAllowedOrigins(environment: NodeJS.ProcessEnv): readonly string[] {
	const raw = environment.HOOK_URL_ALLOWLIST
	if (raw === undefined || raw.trim() === '') return []
	const values = raw.split(',').map((value) => value.trim())
	if (values.some((value) => value === '')) {
		throw new Error('HOOK_URL_ALLOWLIST must be a comma-separated list of non-empty origins')
	}
	try {
		return normalizeAllowedOrigins(values)
	} catch (error) {
		throw new Error(`HOOK_URL_ALLOWLIST is invalid: ${(error as Error).message}`)
	}
}

function readBoolean(environment: NodeJS.ProcessEnv, name: string, fallback: boolean): boolean {
	const raw = environment[name]
	if (raw === undefined || raw === '') return fallback
	if (raw === 'true') return true
	if (raw === 'false') return false
	throw new Error(`${name} must be either true or false`)
}

export function readSecurityConfig(environment: NodeJS.ProcessEnv = process.env): SecurityConfig {
	return createSecurityConfig({
		apiToken: environment.WAITQUEUE_API_TOKEN,
		hookUrlAllowlist: readAllowedOrigins(environment),
		allowPrivateHookUrls: readBoolean(
			environment,
			'HOOK_URL_ALLOW_PRIVATE',
			DEFAULT_SECURITY_CONFIG.allowPrivateHookUrls
		),
		requestBodyLimitBytes: readInteger(
			environment,
			'REQUEST_BODY_LIMIT_BYTES',
			DEFAULT_SECURITY_CONFIG.requestBodyLimitBytes,
			1
		),
		rateLimitMaxRequests: readInteger(
			environment,
			'RATE_LIMIT_MAX_REQUESTS',
			DEFAULT_SECURITY_CONFIG.rateLimitMaxRequests,
			0
		),
		rateLimitWindowMs: readInteger(
			environment,
			'RATE_LIMIT_WINDOW_MS',
			DEFAULT_SECURITY_CONFIG.rateLimitWindowMs,
			1
		),
	})
}

interface WarningLogger {
	warn(bindings: Record<string, string>, message: string): unknown
}

export function createSecurityConfigurationWarner(log: WarningLogger): (config: SecurityConfig) => void {
	let warnedAboutAuthentication = false
	let warnedAboutHookPolicy = false
	let warnedAboutPrivateHooks = false
	return (config: SecurityConfig) => {
		if (!config.apiToken && !warnedAboutAuthentication) {
			warnedAboutAuthentication = true
			log.warn(
				{ configuration: 'WAITQUEUE_API_TOKEN' },
				'control API authentication is disabled; configure a token before exposing the service'
			)
		}
		if (config.hookUrlAllowlist.length === 0 && !warnedAboutHookPolicy) {
			warnedAboutHookPolicy = true
			log.warn(
				{ configuration: 'HOOK_URL_ALLOWLIST' },
				'callback origin allowlist is empty; configure exact origins before exposing the service'
			)
		}
		if (config.allowPrivateHookUrls && !warnedAboutPrivateHooks) {
			warnedAboutPrivateHooks = true
			log.warn(
				{ configuration: 'HOOK_URL_ALLOW_PRIVATE' },
				'private and local callback targets are enabled; use this override only for isolated development'
			)
		}
	}
}
