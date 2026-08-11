import 'dotenv/config'

function readPositiveInteger(name: string, fallback: number): number {
	const raw = process.env[name]
	if (raw === undefined || raw === '') return fallback

	const value = Number(raw)
	if (!Number.isInteger(value) || value <= 0) {
		throw new Error(`${name} must be a positive integer`)
	}
	return value
}

export const env = Object.freeze({
	appPort: readPositiveInteger('APP_PORT', 3000),
	hookTimeoutMs: readPositiveInteger('HOOK_TIMEOUT_MS', 10_000),
	queueSyncCron: process.env.CHECK_TASK_DIFF_CRON || '0 * * * * *',
	cronTimezone: process.env.CRON_TIMEZONE || 'Asia/Shanghai',
	database: Object.freeze({
		database: process.env.DB_DATABASE || 'waitqueue',
		username: process.env.DB_USER || 'root',
		password: process.env.DB_PASSWORD || '',
		host: process.env.DB_HOST || '127.0.0.1',
		port: readPositiveInteger('DB_PORT', 3306),
	}),
	redis: Object.freeze({
		host: process.env.REDIS_HOST || '127.0.0.1',
		port: readPositiveInteger('REDIS_PORT', 6379),
		password: process.env.REDIS_PASSWORD || undefined,
	}),
})
