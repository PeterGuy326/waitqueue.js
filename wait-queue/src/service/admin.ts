import { Context } from 'koa'
import { ModelCtor } from 'sequelize'
import Redis from 'ioredis'
import { Service } from '../lib/service'
import { QueueAttributes, QueueDao } from '../dao/queue_dao'
import { redisCli } from '../conf/redis'
import { getRunningKey, getWaitingKey } from '../common/cache'
import { QueueOverview, QueueOverviewItem } from '../types/api'

function percentage(value: number, total: number): number {
	if (total === 0) return 0
	return Math.round((value / total) * 1000) / 10
}

function redisCount(result: [Error | null, unknown] | undefined): number {
	if (!result) throw new Error('redis pipeline returned an incomplete result')
	const [error, value] = result
	if (error) throw error
	const count = Number(value)
	if (!Number.isFinite(count)) throw new Error('redis pipeline returned an invalid count')
	return count
}

export class AdminService extends Service {
	private queueDao: ModelCtor<QueueAttributes>
	private redis: Redis

	constructor(ctx: Context) {
		super(ctx)
		this.queueDao = QueueDao
		this.redis = redisCli.getInstance()
	}

	async overview(): Promise<QueueOverview> {
		const queueModels = await this.queueDao.findAll({ order: [['id', 'ASC']] })
		const pipeline = this.redis.pipeline()
		for (const queue of queueModels) {
			pipeline.llen(getWaitingKey(queue.namespace, queue.id))
			pipeline.hlen(getRunningKey(queue.namespace, queue.id))
		}

		const counts = queueModels.length > 0 ? await pipeline.exec() : []
		if (!counts) throw new Error('redis pipeline did not return a result')

		const queues: QueueOverviewItem[] = queueModels.map((queue, index) => {
			const waiting = redisCount(counts[index * 2])
			const running = redisCount(counts[index * 2 + 1])
			const concurrency = queue.count
			return {
				queueId: queue.id,
				namespace: queue.namespace,
				hookUrl: queue.url,
				concurrency,
				waiting,
				running,
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
				capacity: total.capacity + queue.concurrency,
				utilization: 0,
			}),
			{ queueCount: 0, waiting: 0, running: 0, capacity: 0, utilization: 0 }
		)
		summary.utilization = percentage(summary.running, summary.capacity)

		return {
			generatedAt: new Date().toISOString(),
			summary,
			queues,
		}
	}
}
