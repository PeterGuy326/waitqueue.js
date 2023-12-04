import Router from 'koa-router'

const schedulerRoutes = new Router();

schedulerRoutes.post('/addTask', async (ctx) => {
  ctx.body = 'User list';
});

export { schedulerRoutes }