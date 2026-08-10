import Router from '@koa/router'
import response from '../utils/response'
import { SchedulerService } from '../service/scheduler'
import { validateAddTaskInput } from '../utils/validation'

const schedulerRoutes = new Router()

schedulerRoutes.post('/addTask', async (ctx) => {
	const input = validateAddTaskInput(ctx.request.body)
	const result = await new SchedulerService(ctx).addTask(input)
	response.success(ctx, result)
})

export { schedulerRoutes }
