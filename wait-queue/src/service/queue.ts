import { Context } from 'koa'
import { Service } from '../lib/service'
import { QueueAttributes, QueueDao } from '../dao/queue_dao'
import { ModelCtor } from 'sequelize'
import { Timer } from '../lib/timer'
import { NewQueueRequest, OperationResult } from '../types/api'
import { createBackgroundContext } from '../common/logger'

export class QueueService extends Service {
	private queueDao: ModelCtor<QueueAttributes>
	constructor(ctx: Context) {
		super(ctx)
		this.queueDao = QueueDao
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

		await new Timer(createBackgroundContext()).initializeQueueList([queue.id])

		return { isOk: true }
	}
}
