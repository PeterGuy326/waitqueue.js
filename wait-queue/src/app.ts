import Koa from 'koa'
import Router from 'koa-router'
import pino from 'koa-pino-logger'
import bodyParser from 'koa-bodyparser'
import { cronInit } from './middleware/timer'
import { queueRoutes } from './routes/queue'
import { ContextExtensional } from '../type/middleware/context'
import { schedulerRoutes } from './routes/scheduler'
import { controllerInsMiddleware } from './middleware/controllerIns'
require('dotenv').config()

const app = new Koa<{}, ContextExtensional>()

app.use(bodyParser())
app.use(pino())
app.use((ctx, next) => cronInit(ctx, next))

const router = new Router<{}, ContextExtensional>({
	prefix: 'waitqueue',
})

router.use(controllerInsMiddleware) // 应用中间件

// 集成子模块路由
router.use('/scheduler', schedulerRoutes.routes())
router.use('/queue', queueRoutes.routes())

// 应用路由中间件
app.use(router.routes())
app.use(router.allowedMethods())

app.listen(process.env.APP_PORT, () => {
	console.log(`Server running on http://localhost:${process.env.APP_PORT}`)
})
