import { Context } from 'koa'
import { ModelCtor } from 'sequelize'
import Redis from 'ioredis'
import { Service } from '../lib/service'
import { QueueAttributes, QueueDao } from '../dao/queue_dao'
import { redisCli } from '../conf/redis'
import {
	DeadLetterQuery,
	OperationResult,
	QueueOverview,
	QueueOverviewItem,
	ReplayDeadLetterRequest,
} from '../types/api'
import { RedisTaskStore, DeadLetterPage } from '../reliability/task_store'
import { env } from '../conf/env'
import { HttpError } from '../utils/http_error'
import {
	readQueueRuntimeSnapshots,
	RuntimeSnapshotReader,
} from '../observability/runtime_snapshot'
import { waitQueueMetrics, WaitQueueMetrics } from '../observability/metrics'

function percentage(value: number, total: number): number {
	if (total === 0) return 0
	return Math.round((value / total) * 1000) / 10
}

export class AdminService extends Service {
	private queueDao: ModelCtor<QueueAttributes>
	private redis: Redis

	constructor(
		ctx: Context,
		private readonly runtimeSnapshotReader: RuntimeSnapshotReader = (queues) =>
			readQueueRuntimeSnapshots(redisCli.getInstance(), queues),
		private readonly metrics: WaitQueueMetrics = waitQueueMetrics
	) {
		super(ctx)
		this.queueDao = QueueDao
		this.redis = redisCli.getInstance()
	}

	private async queueById(queueId: number): Promise<QueueAttributes> {
		const queue = await this.queueDao.findByPk(queueId, {
			attributes: ['id', 'namespace'],
		})
		if (!queue) throw new HttpError(404, 'queue not found')
		return queue
	}

	async deadLetters(query: DeadLetterQuery): Promise<DeadLetterPage> {
		const queue = await this.queueById(query.queueId)
		return new RedisTaskStore(
			this.redis,
			queue.namespace,
			queue.id,
			env.reliability
		).listDeadLetters(query.offset, query.limit)
	}

	async replayDeadLetter(input: ReplayDeadLetterRequest): Promise<OperationResult> {
		const queue = await this.queueById(input.queueId)
		const result = await new RedisTaskStore(
			this.redis,
			queue.namespace,
			queue.id,
			env.reliability
		).replayDeadLetter(input.taskId, input.entryId)
		if (result === 'missing') throw new HttpError(404, 'dead letter not found')
		if (result === 'stale') throw new HttpError(409, 'dead letter generation is stale')
		if (result === 'conflict') throw new HttpError(409, 'task is already active')
		return { isOk: true }
	}

	async overview(): Promise<QueueOverview> {
		const queueModels = await this.queueDao.findAll({ order: [['id', 'ASC']] })
		const runtime = await this.runtimeSnapshotReader(queueModels)

		const queues: QueueOverviewItem[] = queueModels.map((queue, index) => {
			const {
				waiting,
				running,
				retrying,
				deadLetters,
				oldestWaitingAt,
				oldestWaitingAgeSeconds,
			} = runtime[index]
			const counters = this.metrics.queueSnapshot(queue.id)
			const concurrency = queue.count
			return {
				queueId: queue.id,
				namespace: queue.namespace,
				hookUrl: queue.url,
				concurrency,
				waiting,
				running,
				retrying,
				deadLetters,
				oldestWaitingAt,
				oldestWaitingAgeSeconds,
				callbacks: counters.callbacks,
				claims: counters.claims,
				available: Math.max(concurrency - running, 0),
				utilization: percentage(running, concurrency),
				crontab: {
					run: queue.runCrontab,
					check: queue.checkCrontab,
					expire: queue.expireCrontab,
				},
				updatedAt: new Date(queue.updatedTime).toISOString(),
			}
		})

		const summary = queues.reduce(
			(total, queue) => ({
				queueCount: total.queueCount + 1,
				waiting: total.waiting + queue.waiting,
				running: total.running + queue.running,
				retrying: total.retrying + queue.retrying,
				deadLetters: total.deadLetters + queue.deadLetters,
				oldestWaitingAt:
					queue.oldestWaitingAt &&
					(!total.oldestWaitingAt ||
						total.oldestWaitingAgeSeconds === null ||
						(queue.oldestWaitingAgeSeconds !== null &&
							queue.oldestWaitingAgeSeconds > total.oldestWaitingAgeSeconds))
						? queue.oldestWaitingAt
						: total.oldestWaitingAt,
				oldestWaitingAgeSeconds:
					queue.oldestWaitingAgeSeconds !== null &&
					(total.oldestWaitingAgeSeconds === null ||
						queue.oldestWaitingAgeSeconds > total.oldestWaitingAgeSeconds)
						? queue.oldestWaitingAgeSeconds
						: total.oldestWaitingAgeSeconds,
				callbackSuccesses: total.callbackSuccesses + queue.callbacks.success,
				callbackFailures: total.callbackFailures + queue.callbacks.failure,
				claims: total.claims + queue.claims.claimed,
				recovered: total.recovered + queue.claims.recovered,
				capacity: total.capacity + queue.concurrency,
				utilization: 0,
			}),
			{
				queueCount: 0,
				waiting: 0,
				running: 0,
				retrying: 0,
				deadLetters: 0,
				oldestWaitingAt: null as string | null,
				oldestWaitingAgeSeconds: null as number | null,
				callbackSuccesses: 0,
				callbackFailures: 0,
				claims: 0,
				recovered: 0,
				capacity: 0,
				utilization: 0,
			}
		)
		summary.utilization = percentage(summary.running, summary.capacity)

		return {
			generatedAt: new Date().toISOString(),
			metricsStartedAt: this.metrics.startedAt,
			summary,
			queues,
		}
	}
}
