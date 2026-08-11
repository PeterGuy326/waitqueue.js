import Router from '@koa/router'
import { AdminService } from '../service/admin'
import response from '../utils/response'
import {
	validateDeadLetterQuery,
	validateReplayDeadLetterInput,
} from '../utils/validation'

const adminRoutes = new Router({ sensitive: true })

adminRoutes.get('/overview', async (ctx) => {
	ctx.set('Cache-Control', 'no-store')
	const result = await new AdminService(ctx).overview()
	response.success(ctx, result)
})

adminRoutes.get('/deadLetters', async (ctx) => {
	ctx.set('Cache-Control', 'no-store')
	const result = await new AdminService(ctx).deadLetters(validateDeadLetterQuery(ctx.query))
	response.success(ctx, result)
})

adminRoutes.post('/deadLetters/replay', async (ctx) => {
	const result = await new AdminService(ctx).replayDeadLetter(
		validateReplayDeadLetterInput(ctx.request.body)
	)
	response.success(ctx, result)
})

export { adminRoutes }
