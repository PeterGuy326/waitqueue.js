import { Context } from 'koa'
import { Service } from '../lib/service'
import { QueueAttributes, QueueDao } from '../dao/queue_dao'
import { ModelCtor } from 'sequelize'
import { Timer } from '../lib/timer'
import { NewQueueRequest, OperationResult } from '../types/api'
import { createBackgroundContext } from '../common/logger'
import { HookUrlPolicy } from '../security/hook_url_policy'
import { env } from '../conf/env'

export class QueueService extends Service {
	private queueDao: ModelCtor<QueueAttributes>
	private hookUrlPolicy: HookUrlPolicy
	constructor(
		ctx: Context,
		hookUrlPolicy: HookUrlPolicy = new HookUrlPolicy(env.security.hookUrlAllowlist, {
			allowPrivate: env.security.allowPrivateHookUrls,
		})
	) {
		super(ctx)
		this.queueDao = QueueDao
		this.hookUrlPolicy = hookUrlPolicy
	}

	async newQueue(params: NewQueueRequest): Promise<OperationResult> {
		const { hookUrl, currMaxCount, crontab, namespace } = params
		const dbBody = {
			url: hookUrl,
			namespace,
			count: currMaxCount,
			runCrontab: crontab.run,
			checkCrontab: crontab.check,
			expireCrontab: crontab.expire,
		}
		const [queue, created] = await this.queueDao.findOrCreate({
			where: { url: hookUrl, namespace },
			defaults: dbBody,
		})
		if (!created) {
			await queue.update({
				count: currMaxCount,
				runCrontab: crontab.run,
				checkCrontab: crontab.check,
				expireCrontab: crontab.expire,
			})
		}

		await new Timer(createBackgroundContext(), this.hookUrlPolicy).initializeQueueList([queue.id])

		return { isOk: true }
	}
}
