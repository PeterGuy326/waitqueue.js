import Router from 'koa-router'

const schedulerRoutes = new Router();

schedulerRoutes.get('/', async (ctx) => {
  ctx.body = 'User list';
});

schedulerRoutes.get('/:id', async (ctx) => {
  ctx.body = `User with id ${ctx.params.id}`;
});

export { schedulerRoutes }