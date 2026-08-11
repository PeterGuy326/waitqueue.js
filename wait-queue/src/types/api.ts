export interface QueueCrontab {
	run: string
	check: string
	expire: string
}

export interface NewQueueRequest {
	hookUrl: string
	namespace: string
	currMaxCount: number
	crontab: QueueCrontab
}

export interface AddTaskRequest {
	hookUrl: string
	taskId: string
	namespace: string
}

export interface OperationResult {
	isOk: true
}

export interface DeadLetterQuery {
	queueId: number
	offset: number
	limit: number
}

export interface ReplayDeadLetterRequest {
	queueId: number
	taskId: string
	entryId: string
}

export interface QueueOverviewItem {
	queueId: number
	namespace: string
	hookUrl: string
	concurrency: number
	waiting: number
	running: number
	retrying: number
	deadLetters: number
	oldestWaitingAt: string | null
	oldestWaitingAgeSeconds: number | null
	callbacks: {
		success: number
		failure: number
	}
	claims: {
		claimed: number
		recovered: number
	}
	available: number
	utilization: number
	crontab: QueueCrontab
	updatedAt: string
}

export interface QueueOverview {
	generatedAt: string
	metricsStartedAt: string
	summary: {
		queueCount: number
		waiting: number
		running: number
		retrying: number
		deadLetters: number
		oldestWaitingAt: string | null
		oldestWaitingAgeSeconds: number | null
		callbackSuccesses: number
		callbackFailures: number
		claims: number
		recovered: number
		capacity: number
		utilization: number
	}
	queues: QueueOverviewItem[]
}
