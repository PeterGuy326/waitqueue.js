// middleware/queueController.js
import { Context, Next } from 'koa'
import { QueueController } from '../controller/queue'
import { SchedulerController } from '../controller/scheduler'

const controllerInsMiddleware = async (ctx: Context, next: Next) => {
	ctx.queueController = new QueueController(ctx)
	ctx.schedulerController = new SchedulerController(ctx)
	await next()
}

export { controllerInsMiddleware }
