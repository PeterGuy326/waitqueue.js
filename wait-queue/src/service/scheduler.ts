import { Context } from 'koa'
import { Service } from '../lib/service'
import { QueueAttributes, QueueDao } from '../dao/queue_dao'
import { ModelCtor } from 'sequelize'
import * as SchedulerServiceType from '../../type/service/scheduler'
import { Redis } from 'ioredis'
import { redisCli } from '../conf/redis'
import { getWaitingKey } from '../common/cache'

export class SchedulerService extends Service {
	private queueDao: ModelCtor<QueueAttributes>
	private redis: Redis
	constructor(ctx: Context) {
		super(ctx)
		this.queueDao = QueueDao
		this.redis = redisCli.getInstance()
	}

	async addTask(params: SchedulerServiceType.AddTaskReq) {
		const { hookUrl, taskId, namespace } = params
		const queueRes = await this.queueDao.findOne({
			where: {
				url: hookUrl,
				namespace,
			},
		})
		if (!queueRes || !queueRes.id) {
			// 接口抛出异常
		}

		this.baseLogInfo(`TaskManager-${namespace}|url:${hookUrl}|taskId:${taskId}|addTask: push task to queue`)
		await this.redis.lpush(getWaitingKey(namespace, queueRes?.id || -1), taskId)
		return {
            isOk: true
        }
	}
}
