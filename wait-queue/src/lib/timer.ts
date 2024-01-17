import { CronJob } from 'cron'
import { Context } from 'koa'
import { ModelCtor, WhereOptions } from 'sequelize'
import { QueueAttributes, QueueDao } from '../dao/queue_dao'
import { Service } from './service'
import { TaskManager } from './task_manager'
import { getRunningKey, getWaitingKey } from '../common/cache'

interface TaskJob {
	cron: string
	job: CronJob
}

const runTaskJob: Map<string, TaskJob> = new Map<string, TaskJob>()
const checkTaskJob: Map<string, TaskJob> = new Map<string, TaskJob>()
const expireTaskJob: Map<string, TaskJob> = new Map<string, TaskJob>()

export class Timer extends Service {
	private runTaskJobMap: Map<string, TaskJob>
	private checkTaskJobMap: Map<string, TaskJob>
	private expireTaskJobMap: Map<string, TaskJob>
	private queueDao: ModelCtor<QueueAttributes>
	constructor(ctx: Context) {
		super(ctx)
		this.runTaskJobMap = runTaskJob
		this.checkTaskJobMap = checkTaskJob
		this.expireTaskJobMap = expireTaskJob
		this.queueDao = QueueDao
	}

	async initializeQueueList(queueIds: number[] = []) {
		const where: WhereOptions<QueueAttributes> = {
			...(queueIds.length ? { id: queueIds } : {}),
		}
		const allRows =
			(await this.queueDao.findAll({
				...(Object.keys(where).length ? { where } : {}),
			})) || []
		allRows.map((queueInfo) => {
			this.syncQueueJob(queueInfo)
		})
	}

	queueUniqKey(queueInfo: QueueAttributes) {
		return `${queueInfo.namespace}:${queueInfo.url}`
	}

	syncQueueJob(queueInfo: QueueAttributes) {
		const jobKey = this.queueUniqKey(queueInfo)
		const taskInstance = new TaskManager(this.ctx, queueInfo.url, getRunningKey(queueInfo.namespace, queueInfo.id), getWaitingKey(queueInfo.namespace, queueInfo.id), queueInfo.count)
		;[
			{ job: this.runTaskJobMap, cronTab: queueInfo.runCrontab, execFunc: taskInstance.runTask.bind(taskInstance) },
			{ job: this.checkTaskJobMap, cronTab: queueInfo.checkCrontab, execFunc: taskInstance.checkTaskStatus.bind(taskInstance) },
			{ job: this.expireTaskJobMap, cronTab: queueInfo.expireCrontab, execFunc: taskInstance.expireTask.bind(taskInstance) },
		].map(({ job, cronTab, execFunc }) => {
            // 查找表中的批量队列名称（queueKey）以及运行的周期时间（run_crontab）
            // 比较哪些队列中的运行周期时间与之前不同的
            // 将表中的没有队列将 map 的队列消除
            if (!job.get(jobKey) || job.get(jobKey)?.cron !== cronTab) {
                // 将原先 map 中的 job 置为 stop
                job.get(jobKey)?.job.stop()
                // 批量实例化任务实例
                const JobIns = new CronJob(
                    cronTab,
                    execFunc,
                    null,
                    true,
                    'Asia/Shanghai'
                )
                JobIns.start()
                job.set(jobKey, { cron: cronTab, job: JobIns })
            }
        })
	}
}
