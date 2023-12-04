import { Context } from 'koa'
import * as QueueControllerType from '../../type/controller/queue'
import { Controller } from '../lib/controller'
import { QueueService } from '../service/queue'

export class QueueController extends Controller {
	private queueService: QueueService
	constructor(ctx: Context) {
		super(ctx)
		this.queueService = new QueueService(ctx)
	}

	async newQueue(params: QueueControllerType.NewQueueKeyReq) {
		return await this.queueService.newQueue(params)
	}
}
