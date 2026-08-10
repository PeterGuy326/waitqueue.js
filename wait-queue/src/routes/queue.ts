import Router from '@koa/router'
import { QueueService } from '../service/queue'
import response from '../utils/response'
import { validateNewQueueInput } from '../utils/validation'

const queueRoutes = new Router()

queueRoutes.post('/newQueue', async (ctx) => {
	const input = validateNewQueueInput(ctx.request.body)
	const result = await new QueueService(ctx).newQueue(input)
	response.success(ctx, result)
})

export { queueRoutes }
