import { createHash, timingSafeEqual } from 'crypto'
import { Context, Next } from 'koa'
import { HttpError } from '../utils/http_error'
import { FixedWindowRateLimiter } from '../security/rate_limit'
import { safeLogPath } from '../common/logger'

export type AuditRejection = 'authentication' | 'rate_limit'

const PUBLIC_CONTROL_PATHS = new Set(['/waitqueue/health', '/waitqueue/ready'])

function isControlPath(path: string): boolean {
	return path === '/waitqueue' || path.startsWith('/waitqueue/')
}

function isSecurityExempt(ctx: Context): boolean {
	if (ctx.method === 'OPTIONS') return true
	const normalizedPath = ctx.path.toLowerCase()
	return !isControlPath(normalizedPath) || PUBLIC_CONTROL_PATHS.has(normalizedPath)
}

function bearerToken(header: string): string | undefined {
	const match = /^Bearer ([^\s]+)$/i.exec(header)
	return match?.[1]
}

function tokensMatch(expectedDigest: Buffer, actual: string | undefined): boolean {
	const actualDigest = createHash('sha256').update(actual ?? '').digest()
	return timingSafeEqual(expectedDigest, actualDigest)
}

export function createBearerAuth(apiToken: string | undefined) {
	const expectedDigest = apiToken ? createHash('sha256').update(apiToken).digest() : undefined
	return async (ctx: Context, next: Next): Promise<void> => {
		if (!expectedDigest || isSecurityExempt(ctx)) {
			await next()
			return
		}

		if (!tokensMatch(expectedDigest, bearerToken(ctx.get('authorization')))) {
			ctx.state.auditRejection = 'authentication' satisfies AuditRejection
			ctx.set('WWW-Authenticate', 'Bearer')
			throw new HttpError(401, 'authentication required')
		}
		await next()
	}
}

function clientKey(ctx: Context): string {
	return ctx.ip || ctx.req.socket.remoteAddress || 'unknown'
}

export function createRateLimit(limiter: FixedWindowRateLimiter) {
	return async (ctx: Context, next: Next): Promise<void> => {
		if (isSecurityExempt(ctx)) {
			await next()
			return
		}

		const decision = limiter.consume(clientKey(ctx))
		if (!decision.allowed) {
			ctx.state.auditRejection = 'rate_limit' satisfies AuditRejection
			ctx.set('Retry-After', String(decision.retryAfterSeconds))
			throw new HttpError(429, 'too many requests')
		}
		await next()
	}
}

const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE'])

function successfulWriteAction(ctx: Context): string {
	if (ctx.method === 'POST' && ctx.path === '/waitqueue/queue/newQueue') return 'queue.configure'
	if (ctx.method === 'POST' && ctx.path === '/waitqueue/scheduler/addTask') return 'task.enqueue'
	return 'api.write'
}

export async function auditMiddleware(ctx: Context, next: Next): Promise<void> {
	const startedAt = Date.now()
	try {
		await next()
	} finally {
		const rejection = ctx.state.auditRejection as AuditRejection | undefined
		const writeRequest = WRITE_METHODS.has(ctx.method)
		const successfulWrite = writeRequest && ctx.status >= 200 && ctx.status < 400
		if (!rejection && !writeRequest) return

		const audit = {
			event: 'api_audit',
			action:
				rejection === 'authentication'
					? 'auth.denied'
					: rejection === 'rate_limit'
						? 'rate_limit.denied'
						: successfulWriteAction(ctx),
			outcome: rejection ? 'denied' : successfulWrite ? 'succeeded' : 'failed',
			method: ctx.method,
			path: safeLogPath(ctx.path),
			statusCode: ctx.status,
			durationMs: Math.max(0, Date.now() - startedAt),
		}
		if (rejection) ctx.log.warn({ audit }, 'api request rejected')
		else if (successfulWrite) ctx.log.info({ audit }, 'api write succeeded')
		else ctx.log.warn({ audit }, 'api write failed')
	}
}
