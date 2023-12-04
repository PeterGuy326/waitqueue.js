import Router from 'koa-router'

const queueRoutes = new Router()

queueRoutes.post('/newQueue', async (ctx) => {
	ctx.body = 'User list'
})

export { queueRoutes }
