import { daoMysql } from '../conf/db'
import { redisCli } from '../conf/redis'

export interface ReadinessDependencies {
	database: () => Promise<unknown>
	redis: () => Promise<unknown>
}

export interface ReadinessResult {
	ready: boolean
	dependencies: {
		mysql: 'ok' | 'unavailable'
		redis: 'ok' | 'unavailable'
	}
}

export interface ReadinessOptions {
	timeoutMs?: number
}

export type ReadinessCheck = () => Promise<ReadinessResult>

function defaultDependencies(): ReadinessDependencies {
	return {
		database: () => daoMysql.getInstance().query('SELECT 1'),
		redis: () => redisCli.getInstance().ping(),
	}
}

async function runProbe(probe: () => Promise<unknown>, timeoutMs: number): Promise<'ok' | 'unavailable'> {
	let timeout: NodeJS.Timeout | undefined
	try {
		await Promise.race([
			Promise.resolve().then(probe),
			new Promise<never>((_, reject) => {
				timeout = setTimeout(() => reject(new Error('readiness probe timed out')), timeoutMs)
			}),
		])
		return 'ok'
	} catch {
		return 'unavailable'
	} finally {
		if (timeout) clearTimeout(timeout)
	}
}

export async function checkReadiness(
	dependencies: ReadinessDependencies = defaultDependencies(),
	options: ReadinessOptions = {}
): Promise<ReadinessResult> {
	const timeoutMs = options.timeoutMs ?? 2_000
	if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) throw new Error('readiness timeout must be a positive integer')

	const [mysql, redis] = await Promise.all([
		runProbe(dependencies.database, timeoutMs),
		runProbe(dependencies.redis, timeoutMs),
	])
	return { ready: mysql === 'ok' && redis === 'ok', dependencies: { mysql, redis } }
}

export function createReadinessCheck(
	dependencies: ReadinessDependencies = defaultDependencies(),
	options: ReadinessOptions = {}
): ReadinessCheck {
	let inFlight: Promise<ReadinessResult> | undefined
	return () => {
		if (!inFlight) {
			inFlight = checkReadiness(dependencies, options).finally(() => {
				inFlight = undefined
			})
		}
		return inFlight
	}
}
