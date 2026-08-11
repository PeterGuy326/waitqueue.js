import Router from '@koa/router'
import { AdminService } from '../service/admin'
import response from '../utils/response'
import {
	validateDeadLetterQuery,
	validateReplayDeadLetterInput,
} from '../utils/validation'
import { RuntimeSnapshotReader } from '../observability/runtime_snapshot'
import { WaitQueueMetrics } from '../observability/metrics'

export function createAdminRoutes(
	runtimeSnapshotReader?: RuntimeSnapshotReader,
	metrics?: WaitQueueMetrics
): Router {
	const routes = new Router({ sensitive: true })

	routes.get('/overview', async (ctx) => {
		ctx.set('Cache-Control', 'no-store')
		const result = await new AdminService(ctx, runtimeSnapshotReader, metrics).overview()
		response.success(ctx, result)
	})

	routes.get('/deadLetters', async (ctx) => {
		ctx.set('Cache-Control', 'no-store')
		const result = await new AdminService(ctx).deadLetters(validateDeadLetterQuery(ctx.query))
		response.success(ctx, result)
	})

	routes.post('/deadLetters/replay', async (ctx) => {
		const result = await new AdminService(ctx).replayDeadLetter(
			validateReplayDeadLetterInput(ctx.request.body)
		)
		response.success(ctx, result)
	})
	return routes
}

export const adminRoutes = createAdminRoutes()
