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

export interface QueueOverviewItem {
	queueId: number
	namespace: string
	hookUrl: string
	concurrency: number
	waiting: number
	running: number
	available: number
	utilization: number
	crontab: QueueCrontab
	updatedAt: string
}

export interface QueueOverview {
	generatedAt: string
	summary: {
		queueCount: number
		waiting: number
		running: number
		capacity: number
		utilization: number
	}
	queues: QueueOverviewItem[]
}
