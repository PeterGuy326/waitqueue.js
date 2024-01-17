import Router from 'koa-router'
import * as QueueControllerType from '../../type/controller/queue'
import { controllerInsMiddleware } from '../middleware/controllerIns'
import { ContextExtensional } from '../../type/middleware/context'
import response from '../utils/response'

const queueRoutes = new Router<{}, ContextExtensional>()
queueRoutes.use(controllerInsMiddleware) // 应用中间件

queueRoutes.post('/newQueue', async (ctx) => {
	try {
		const res = await ctx.queueController.newQueue(ctx.request.body as QueueControllerType.NewQueueKeyReq)
		response.success(ctx, res)
	} catch (err) {
		response.error(ctx, err.message)
	}
})

export { queueRoutes }
