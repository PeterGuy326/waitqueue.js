export function getWaitingKey(namespace: string, queueKey: number): string {
	return `TaskQueue:${namespace}:${queueKey}:waitingQueue`
}

export function getRunningKey(namespace: string, queueKey: number): string {
	return `TaskQueue:${namespace}:${queueKey}:runningHashKv`
}

export function getClaimLeaseKey(namespace: string, queueKey: number): string {
	return `TaskQueue:${namespace}:${queueKey}:claimLeaseZset`
}

export function getRetryScheduleKey(namespace: string, queueKey: number): string {
	return `TaskQueue:${namespace}:${queueKey}:retryScheduleZset`
}

export function getRetryCountKey(namespace: string, queueKey: number): string {
	return `TaskQueue:${namespace}:${queueKey}:retryCountHashKv`
}

export function getRetryTokenKey(namespace: string, queueKey: number): string {
	return `TaskQueue:${namespace}:${queueKey}:retryTokenHashKv`
}

export function getDeadLetterKey(namespace: string, queueKey: number): string {
	return `TaskQueue:${namespace}:${queueKey}:deadLetterHashKv`
}

export function getDeadLetterOrderKey(namespace: string, queueKey: number): string {
	return `TaskQueue:${namespace}:${queueKey}:deadLetterZset`
}

export function getEnqueuedAtKey(namespace: string, queueKey: number): string {
	return `TaskQueue:${namespace}:${queueKey}:enqueuedAtHashKv`
}

export function getTaskStateKey(namespace: string, queueKey: number): string {
	return `TaskQueue:${namespace}:${queueKey}:taskStateHashKv`
}

export function getTaskGenerationKey(namespace: string, queueKey: number): string {
	return `TaskQueue:${namespace}:${queueKey}:taskGenerationHashKv`
}

export function getReliabilityMigrationKey(namespace: string, queueKey: number): string {
	return `TaskQueue:${namespace}:${queueKey}:reliabilityMigrationV1`
}

export function getReliabilityMigrationWaitingKey(namespace: string, queueKey: number): string {
	return `TaskQueue:${namespace}:${queueKey}:reliabilityMigrationWaitingV1`
}

export function getRunningAuditCursorKey(namespace: string, queueKey: number): string {
	return `TaskQueue:${namespace}:${queueKey}:runningAuditCursorV1`
}
