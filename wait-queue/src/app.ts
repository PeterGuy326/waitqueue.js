import Koa from 'koa';
import Router from 'koa-router';
import { schedulerRoutes } from './routes/scheduler';

const app = new Koa();

const router = new Router({
    prefix: 'waitqueue'
});
// 集成子模块路由
router.use('/scheduler', schedulerRoutes.routes());

// 应用路由中间件
app.use(router.routes());
app.use(router.allowedMethods());

app.listen(3000, () => {
    console.log('Server running on http://localhost:3000');
});