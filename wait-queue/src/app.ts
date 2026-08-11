import Koa from 'koa'
import Router from '@koa/router'
import koaPino from 'koa-pino-logger'
import bodyParser from 'koa-bodyparser'
import { CronJob } from 'cron'
import { createQueueRoutes } from './routes/queue'
import { createSchedulerRoutes } from './routes/scheduler'
import { adminRoutes } from './routes/admin'
import { errorHandler } from './middleware/error_handler'
import { auditMiddleware, createBearerAuth, createRateLimit } from './middleware/security'
import response from './utils/response'
import { HttpError } from './utils/http_error'
import { env } from './conf/env'
import { daoMysql } from './conf/db'
import { redisCli } from './conf/redis'
import { Timer } from './lib/timer'
import {
	createBackgroundContext,
	LOGGER_REDACT_PATHS,
	logger,
	safeErrorSerializer,
	safeRequestSerializer,
} from './common/logger'
import { createReadinessCheck, ReadinessCheck, ReadinessResult } from './service/readiness'
import {
	createSecurityConfigurationWarner,
	createSecurityConfig,
	SecurityConfigInput,
} from './security/config'
import { FixedWindowRateLimiter } from './security/rate_limit'
import { HookUrlPolicy } from './security/hook_url_policy'

const warnSecurityConfiguration = createSecurityConfigurationWarner(logger)

export interface CreateAppOptions {
	readinessCheck?: ReadinessCheck
	security?: SecurityConfigInput
	rateLimitClock?: () => number
	requestLogStream?: NodeJS.WritableStream
}

export function createApp(options: CreateAppOptions = {}): Koa {
	const app = new Koa()
	const readinessCheck = options.readinessCheck ?? createReadinessCheck()
	const security = createSecurityConfig(options.security ?? env.security)
	const hookUrlPolicy = new HookUrlPolicy(security.hookUrlAllowlist, {
		allowPrivate: security.allowPrivateHookUrls,
	})
	const rateLimiter = new FixedWindowRateLimiter(
		security.rateLimitMaxRequests,
		security.rateLimitWindowMs,
		options.rateLimitClock
	)
	app.use(
		koaPino(
			{
				redact: { paths: [...LOGGER_REDACT_PATHS], censor: '[REDACTED]' },
				serializers: { err: safeErrorSerializer, req: safeRequestSerializer },
			},
			options.requestLogStream as any
		)
	)
	app.use(auditMiddleware)
	app.use(errorHandler)
	app.use(createRateLimit(rateLimiter))
	app.use(createBearerAuth(security.apiToken))
	app.use(
		bodyParser({
			enableTypes: ['json'],
			jsonLimit: `${security.requestBodyLimitBytes}b`,
		})
	)
	app.use(async (ctx, next) => {
		await next()
		if (ctx.status === 404 && !ctx.body) {
			ctx.status = 404
			response.error(ctx, 'route not found')
		}
	})

	const router = new Router({ prefix: '/waitqueue', sensitive: true })
	router.get('/health', (ctx) => response.success(ctx, { status: 'ok' }))
	router.get('/ready', async (ctx) => {
		ctx.set('Cache-Control', 'no-store')
		let readiness: ReadinessResult = {
			ready: false,
			dependencies: { mysql: 'unavailable', redis: 'unavailable' },
		}
		try {
			readiness = await readinessCheck()
		} catch {
			// Keep the public response intentionally free of connection and driver details.
		}

		if (!readiness.ready) {
			ctx.status = 503
			response.error(ctx, 'service unavailable', {
				status: 'unavailable',
				dependencies: readiness.dependencies,
			})
			return
		}
		response.success(ctx, { status: 'ready', dependencies: readiness.dependencies })
	})
	router.use('/admin', adminRoutes.routes())
	router.use('/scheduler', createSchedulerRoutes(hookUrlPolicy).routes())
	router.use('/queue', createQueueRoutes(hookUrlPolicy).routes())

	app.use(router.routes())
	app.use(
		router.allowedMethods({
			throw: true,
			notImplemented: () => new HttpError(501, 'method not implemented'),
			methodNotAllowed: () => new HttpError(405, 'method not allowed'),
		})
	)
	return app
}

export async function start() {
	warnSecurityConfiguration(env.security)
	const database = daoMysql.getInstance()
	const redis = redisCli.getInstance()
	let timer: Timer | undefined
	let syncJob: CronJob | undefined
	let server: ReturnType<Koa['listen']> | undefined
	let syncInFlight = false

	const closeRedis = async () => {
		if (redis.status === 'end') return
		if (redis.status === 'ready' || redis.status === 'connect') {
			await redis.quit()
			return
		}
		redis.disconnect()
	}

	const closeServer = async () => {
		if (!server?.listening) return
		await new Promise<void>((resolve, reject) => {
			server?.close((error) => (error ? reject(error) : resolve()))
		})
	}

	try {
		await database.authenticate()
		if (redis.status === 'wait') await redis.connect()
		await redis.ping()

		timer = new Timer(createBackgroundContext())
		timer.resume()
		await timer.initializeQueueList()
		syncJob = new CronJob(
			env.queueSyncCron,
			async () => {
				if (syncInFlight) {
					logger.warn('previous queue configuration sync is still running; skipping this tick')
					return
				}
				syncInFlight = true
				try {
					await timer?.initializeQueueList()
				} catch (error) {
					logger.error({ err: error }, 'failed to synchronize queue configuration')
				} finally {
					syncInFlight = false
				}
			},
			null,
			true,
			env.cronTimezone
		)

		const app = createApp()
		server = app.listen(env.appPort)
		await new Promise<void>((resolve, reject) => {
			const onError = (error: Error) => reject(error)
			server?.once('error', onError)
			server?.once('listening', () => {
				server?.off('error', onError)
				resolve()
			})
		})
		logger.info({ port: env.appPort }, 'waitqueue server started')

		let closing = false
		let onSigint: () => void
		let onSigterm: () => void
		const shutdown = async (signal = 'manual') => {
			if (closing) return
			closing = true
			process.off('SIGINT', onSigint)
			process.off('SIGTERM', onSigterm)
			logger.info({ signal }, 'shutting down waitqueue server')
			syncJob?.stop()
			await Promise.all([timer?.stopAll(), closeServer()])
			await Promise.all([database.close(), closeRedis()])
		}

		const handleSignal = (signal: string) => {
			void shutdown(signal).catch((error) => logger.error({ err: error }, 'graceful shutdown failed'))
		}
		onSigint = () => handleSignal('SIGINT')
		onSigterm = () => handleSignal('SIGTERM')
		process.once('SIGINT', onSigint)
		process.once('SIGTERM', onSigterm)
		return { app, server, shutdown }
	} catch (error) {
		syncJob?.stop()
		await Promise.allSettled([timer?.stopAll(), closeServer()])
		await Promise.allSettled([database.close(), closeRedis()])
		throw error
	}
}

if (require.main === module) {
	void start().catch((error) => {
		logger.fatal({ err: error }, 'failed to start waitqueue server')
		process.exitCode = 1
	})
}
