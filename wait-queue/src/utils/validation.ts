import { CronTime } from 'cron'
import { AddTaskRequest, NewQueueRequest, QueueCrontab } from '../types/api'
import { HttpError } from './http_error'
import {
	HookUrlPolicy,
	HookUrlPolicyError,
	permissiveHookUrlPolicy,
} from '../security/hook_url_policy'

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

function hookUrl(source: JsonObject, policy: HookUrlPolicy): string {
	const value = requiredString(source, 'hookUrl', 255)
	try {
		policy.assertAllowed(value)
	} catch (error) {
		if (error instanceof HookUrlPolicyError) throw new HttpError(400, error.message)
		throw error
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

export function validateNewQueueInput(
	value: unknown,
	hookUrlPolicy: HookUrlPolicy = permissiveHookUrlPolicy
): NewQueueRequest {
	const body = asObject(value)
	const rawConcurrency = body.currMaxCount ?? DEFAULT_QUEUE_CONCURRENCY
	if (!Number.isInteger(rawConcurrency) || (rawConcurrency as number) < 1 || (rawConcurrency as number) > 1000) {
		throw new HttpError(400, 'currMaxCount must be an integer between 1 and 1000')
	}

	const rawCrontab = body.crontab === undefined ? {} : asObject(body.crontab)
	return {
		hookUrl: hookUrl(body, hookUrlPolicy),
		namespace: requiredString(body, 'namespace', 64),
		currMaxCount: rawConcurrency as number,
		crontab: {
			run: cronExpression(rawCrontab.run ?? DEFAULT_QUEUE_CRONTAB.run, 'run'),
			check: cronExpression(rawCrontab.check ?? DEFAULT_QUEUE_CRONTAB.check, 'check'),
			expire: cronExpression(rawCrontab.expire ?? DEFAULT_QUEUE_CRONTAB.expire, 'expire'),
		},
	}
}

export function validateAddTaskInput(
	value: unknown,
	hookUrlPolicy: HookUrlPolicy = permissiveHookUrlPolicy
): AddTaskRequest {
	const body = asObject(value)
	return {
		hookUrl: hookUrl(body, hookUrlPolicy),
		namespace: requiredString(body, 'namespace', 64),
		taskId: requiredString(body, 'taskId', 256),
	}
}
