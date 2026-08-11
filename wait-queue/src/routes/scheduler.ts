import Router from '@koa/router'
import response from '../utils/response'
import { SchedulerService } from '../service/scheduler'
import { validateAddTaskInput } from '../utils/validation'
import { HookUrlPolicy, permissiveHookUrlPolicy } from '../security/hook_url_policy'

export function createSchedulerRoutes(hookUrlPolicy: HookUrlPolicy = permissiveHookUrlPolicy): Router {
	const schedulerRoutes = new Router({ sensitive: true })

	schedulerRoutes.post('/addTask', async (ctx) => {
		const input = validateAddTaskInput(ctx.request.body, hookUrlPolicy)
		const result = await new SchedulerService(ctx).addTask(input)
		response.success(ctx, result)
	})
	return schedulerRoutes
}

export const schedulerRoutes = createSchedulerRoutes()
