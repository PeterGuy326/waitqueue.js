import Router from '@koa/router'
import { AdminService } from '../service/admin'
import response from '../utils/response'

const adminRoutes = new Router()

adminRoutes.get('/overview', async (ctx) => {
	ctx.set('Cache-Control', 'no-store')
	const result = await new AdminService(ctx).overview()
	response.success(ctx, result)
})

export { adminRoutes }
