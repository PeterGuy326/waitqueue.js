import { Context } from 'koa'
import { Service } from '../lib/service'
import { QueueAttributes, QueueDao } from '../dao/queue_dao'
import { ModelCtor } from 'sequelize'
import { Redis } from 'ioredis'
import { redisCli } from '../conf/redis'
import { getWaitingKey } from '../common/cache'
import { AddTaskRequest, OperationResult } from '../types/api'
import { HttpError } from '../utils/http_error'

export class SchedulerService extends Service {
	private queueDao: ModelCtor<QueueAttributes>
	private redis: Redis
	constructor(ctx: Context) {
		super(ctx)
		this.queueDao = QueueDao
		this.redis = redisCli.getInstance()
	}

	async addTask(params: AddTaskRequest): Promise<OperationResult> {
		const { hookUrl, taskId, namespace } = params
		const queueRes = await this.queueDao.findOne({
			attributes: ['id', 'namespace'],
			where: {
				url: hookUrl,
				namespace,
			},
		})
		if (!queueRes || !queueRes.id) {
			throw new HttpError(404, 'queue not found; register it before adding tasks')
		}

		this.baseLogInfo(`TaskManager-${namespace}|url:${hookUrl}|taskId:${taskId}|addTask: push task to queue`)
		await this.redis.lpush(getWaitingKey(queueRes.namespace, queueRes.id), taskId)
		return {
			isOk: true,
		}
	}
}
