import Router from 'koa-router'
import { ContextExtensional } from '../../type/middleware/context'
import response from '../utils/response'
import * as SchedulerControllerType from '../../type/controller/scheduler'

const schedulerRoutes = new Router<{}, ContextExtensional>()

schedulerRoutes.post('/addTask', async (ctx) => {
	try {
		const res = await ctx.schedulerController.addTask(ctx.request.body as SchedulerControllerType.AddTaskReq)
		response.success(ctx, res)
	} catch (err) {
		response.error(ctx, err.message)
	}
})

export { schedulerRoutes }
