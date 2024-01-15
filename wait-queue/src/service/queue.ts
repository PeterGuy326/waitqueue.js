import { Context } from 'koa'
import { Service } from '../lib/service'
import * as QueueServiceType from '../../type/service/queue'
import { QueueAttributes, QueueDao } from '../dao/queue_dao'
import { ModelCtor } from 'sequelize'
import { Timer } from '../lib/timer'

export class QueueService extends Service {
	private queueDao: ModelCtor<QueueAttributes>
	constructor(ctx: Context) {
		super(ctx)
		this.queueDao = QueueDao
	}

	async newQueue(params: QueueServiceType.NewQueueKeyReq): Promise<QueueServiceType.NewQueueKeyRes> {
		const {
			hookUrl,
			currMaxCount = 5,
			crontab = {
				run: '0 0 0 * * *',
				check: '0 0 0 * * *',
				expire: '0 0 0 * * *',
			},
			namespace,
		} = params

		const queueItem = await this.queueDao.findOne({
			attributes: ['id'],
			where: {
				url: hookUrl,
				namespace,
			},
		})

		let queueId
		const dbBody = {
			url: hookUrl,
			namespace,
			count: currMaxCount,
			runCrontab: crontab.run,
			checkCrontab: crontab.check,
			expireCrontab: crontab.expire,
		}
		if (queueItem?.id) {
			// 更新
			queueId = queueItem.id
			await this.queueDao.update(dbBody, {
				where: {
					id: queueItem.id,
				},
			})
		} else {
			const { id } = await this.queueDao.create(dbBody)
			queueId = id
		}

		// 初始化 Timer
		new Timer(this.ctx).initializeQueueList([queueId])

		return { isOk: true }
	}
}
