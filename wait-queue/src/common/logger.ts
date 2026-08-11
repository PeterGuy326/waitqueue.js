import { Context } from 'koa'
import createLogger from 'pino'

export const LOGGER_REDACT_PATHS = Object.freeze([
	'req.headers.authorization',
	'req.headers.cookie',
	'request.headers.authorization',
	'request.headers.cookie',
	'headers.authorization',
	'headers.cookie',
	'authorization',
	'cookie',
	'apiToken',
	'token',
	'password',
	'hookUrl',
	'taskId',
	'taskIds',
	'context.apiToken',
	'context.token',
	'context.password',
	'context.url',
	'context.hookUrl',
	'context.taskId',
	'context.taskIds',
	'*.headers.authorization',
	'*.headers.cookie',
	'*.apiToken',
	'*.token',
	'*.password',
	'database.password',
	'redis.password',
	'err.config.password',
	'err.options.password',
	'*.hookUrl',
	'*.taskId',
	'*.taskIds',
])

function safeErrorIdentifier(value: unknown, fallback: string): string {
	return typeof value === 'string' && /^[A-Za-z0-9_.-]{1,64}$/.test(value) ? value : fallback
}

const SAFE_REQUEST_PATHS = new Set([
	'/waitqueue/health',
	'/waitqueue/ready',
	'/waitqueue/admin/overview',
	'/waitqueue/queue/newQueue',
	'/waitqueue/scheduler/addTask',
])

export function safeLogPath(value: unknown): string {
	if (typeof value !== 'string') return '/[invalid]'
	let pathname: string
	try {
		pathname = new URL(value, 'http://request.invalid').pathname
	} catch {
		return '/[invalid]'
	}
	if (SAFE_REQUEST_PATHS.has(pathname)) return pathname
	if (pathname === '/waitqueue' || pathname.startsWith('/waitqueue/')) return '/waitqueue/[unmatched]'
	return '/[unmatched]'
}

export function safeRequestSerializer(request: any): { id?: string | number; method: string; path: string } {
	const serialized: { id?: string | number; method: string; path: string } = {
		method: safeErrorIdentifier(request?.method, 'UNKNOWN'),
		path: safeLogPath(request?.url ?? request?.path),
	}
	if (typeof request?.id === 'string' || typeof request?.id === 'number') serialized.id = request.id
	return serialized
}

export function safeErrorSerializer(error: any): { type: string; code?: string } {
	const serialized: { type: string; code?: string } = {
		type: safeErrorIdentifier(error?.type ?? error?.name ?? error?.constructor?.name, 'Error'),
	}
	const code = safeErrorIdentifier(error?.code, '')
	if (code) serialized.code = code
	return serialized
}

export const logger = createLogger({
	name: 'waitqueue',
	redact: { paths: [...LOGGER_REDACT_PATHS], censor: '[REDACTED]' },
	serializers: { err: safeErrorSerializer, req: safeRequestSerializer },
})

export function createBackgroundContext(): Context {
	return {
		log: logger.child({ component: 'scheduler' }),
		zipkinTrace: '',
		zipkinTraceId: {},
	} as unknown as Context
}
