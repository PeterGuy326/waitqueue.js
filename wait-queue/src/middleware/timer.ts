import { Context, Next } from 'koa'
import { Timer } from '../lib/timer'
import { CronJob } from 'cron'

export const cronInit = async (ctx: Context, next: Next) => {
	const check_task_diff_cron = process.env.CHECK_TASK_DIFF_CRON || '0 0 0 * * *'
	await new Timer(ctx).initializeQueueList()
	new CronJob(
		check_task_diff_cron,
		async function () {
			await new Timer(ctx).initializeQueueList()
		}.bind(this),
		null,
		true,
		'Asia/Shanghai'
	)
	await next()
}
