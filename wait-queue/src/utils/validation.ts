import { CronTime } from 'cron'
import { AddTaskRequest, NewQueueRequest, QueueCrontab } from '../types/api'
import { HttpError } from './http_error'

export const DEFAULT_QUEUE_CONCURRENCY = 5
export const DEFAULT_QUEUE_CRONTAB: QueueCrontab = Object.freeze({
	run: '* * * * * *',
	check: '*/10 * * * * *',
	expire: '0 * * * * *',
})

type JsonObject = Record<string, unknown>

function asObject(value: unknown): JsonObject {
	if (!value || typeof value !== 'object' || Array.isArray(value)) {
		throw new HttpError(400, 'request body must be a JSON object')
	}
	return value as JsonObject
}

function requiredString(source: JsonObject, field: string, maxLength: number): string {
	const value = source[field]
	if (typeof value !== 'string' || value.trim() === '') {
		throw new HttpError(400, `${field} is required`)
	}
	const normalized = value.trim()
	if (normalized.length > maxLength) {
		throw new HttpError(400, `${field} must be at most ${maxLength} characters`)
	}
	return normalized
}

function hookUrl(source: JsonObject): string {
	const value = requiredString(source, 'hookUrl', 255)
	try {
		const parsed = new URL(value)
		if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error('unsupported protocol')
	} catch {
		throw new HttpError(400, 'hookUrl must be a valid HTTP(S) URL')
	}
	return value
}

function cronExpression(value: unknown, field: keyof QueueCrontab): string {
	if (typeof value !== 'string' || value.trim() === '') {
		throw new HttpError(400, `crontab.${field} must be a non-empty cron expression`)
	}
	const normalized = value.trim()
	if (normalized.length > 64) {
		throw new HttpError(400, `crontab.${field} must be at most 64 characters`)
	}
	try {
		new CronTime(normalized)
	} catch {
		throw new HttpError(400, `crontab.${field} is not a valid cron expression`)
	}
	return normalized
}

export function validateNewQueueInput(value: unknown): NewQueueRequest {
	const body = asObject(value)
	const rawConcurrency = body.currMaxCount ?? DEFAULT_QUEUE_CONCURRENCY
	if (!Number.isInteger(rawConcurrency) || (rawConcurrency as number) < 1 || (rawConcurrency as number) > 1000) {
		throw new HttpError(400, 'currMaxCount must be an integer between 1 and 1000')
	}

	const rawCrontab = body.crontab === undefined ? {} : asObject(body.crontab)
	return {
		hookUrl: hookUrl(body),
		namespace: requiredString(body, 'namespace', 64),
		currMaxCount: rawConcurrency as number,
		crontab: {
			run: cronExpression(rawCrontab.run ?? DEFAULT_QUEUE_CRONTAB.run, 'run'),
			check: cronExpression(rawCrontab.check ?? DEFAULT_QUEUE_CRONTAB.check, 'check'),
			expire: cronExpression(rawCrontab.expire ?? DEFAULT_QUEUE_CRONTAB.expire, 'expire'),
		},
	}
}

export function validateAddTaskInput(value: unknown): AddTaskRequest {
	const body = asObject(value)
	return {
		hookUrl: hookUrl(body),
		namespace: requiredString(body, 'namespace', 64),
		taskId: requiredString(body, 'taskId', 256),
	}
}
