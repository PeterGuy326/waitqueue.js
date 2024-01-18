import Router from 'koa-router'
import * as QueueControllerType from '../../type/controller/queue'
import { ContextExtensional } from '../../type/middleware/context'
import response from '../utils/response'

const queueRoutes = new Router<{}, ContextExtensional>()

queueRoutes.post('/newQueue', async (ctx) => {
	console.log(1111111)
	try {
		const res = await ctx.queueController.newQueue(ctx.request.body as QueueControllerType.NewQueueKeyReq)
		response.success(ctx, res)
	} catch (err) {
		response.error(ctx, err.message)
	}
})

export { queueRoutes }
