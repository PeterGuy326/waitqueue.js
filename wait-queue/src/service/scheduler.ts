import { Context } from 'koa'
import { Service } from '../lib/service'
import { QueueAttributes, QueueDao } from '../dao/queue_dao'
import { ModelCtor } from 'sequelize'
import { Redis } from 'ioredis'
import { redisCli } from '../conf/redis'
import { AddTaskRequest, OperationResult } from '../types/api'
import { HttpError } from '../utils/http_error'
import { RedisTaskStore } from '../reliability/task_store'
import { env } from '../conf/env'

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

		const taskStore = new RedisTaskStore(
			this.redis,
			queueRes.namespace,
			queueRes.id,
			env.reliability
		)
		if (!(await taskStore.enqueue(taskId))) {
			throw new HttpError(409, 'task already exists in this queue')
		}
		this.baseLogInfo('task added to waiting queue', { queueId: queueRes.id, namespace })
		return {
			isOk: true,
		}
	}
}
