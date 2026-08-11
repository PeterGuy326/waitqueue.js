import Router from '@koa/router'
import { QueueService } from '../service/queue'
import response from '../utils/response'
import { validateNewQueueInput } from '../utils/validation'
import { HookUrlPolicy, permissiveHookUrlPolicy } from '../security/hook_url_policy'

export function createQueueRoutes(hookUrlPolicy: HookUrlPolicy = permissiveHookUrlPolicy): Router {
	const queueRoutes = new Router({ sensitive: true })

	queueRoutes.post('/newQueue', async (ctx) => {
		const input = validateNewQueueInput(ctx.request.body, hookUrlPolicy)
		const result = await new QueueService(ctx, hookUrlPolicy).newQueue(input)
		response.success(ctx, result)
	})
	return queueRoutes
}

export const queueRoutes = createQueueRoutes()
