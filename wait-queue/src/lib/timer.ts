import { CronJob } from 'cron'
import { Context } from 'koa'
import { ModelCtor, WhereOptions } from 'sequelize'
import { QueueAttributes, QueueDao } from '../dao/queue_dao'
import { Service } from './service'
import { TaskManager } from './task_manager'
import { getRunningKey, getWaitingKey } from '../common/cache'
import { env } from '../conf/env'

interface TaskJob {
	cron: string
	signature: string
	job: CronJob
}

type TaskJobMap = Map<string, TaskJob>

interface JobReplacement {
	jobMap: TaskJobMap
	cron: string
	signature: string
	job: CronJob
}

const runTaskJob: Map<string, TaskJob> = new Map<string, TaskJob>()
const checkTaskJob: Map<string, TaskJob> = new Map<string, TaskJob>()
const expireTaskJob: Map<string, TaskJob> = new Map<string, TaskJob>()
const activeExecutions = new Set<Promise<void>>()
let queueSyncPromise: Promise<void> = Promise.resolve()
let timerStopped = false

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

	initializeQueueList(queueIds: number[] = []): Promise<void> {
		if (timerStopped) return Promise.resolve()
		const syncOperation = queueSyncPromise.then(() => this.syncQueueList(queueIds))
		// 一次同步失败不应让后续同步永远停在 rejected 状态。
		queueSyncPromise = syncOperation.catch(() => undefined)
		return syncOperation
	}

	private async syncQueueList(queueIds: number[]): Promise<void> {
		if (timerStopped) return
		const where: WhereOptions<QueueAttributes> = {
			...(queueIds.length ? { id: queueIds } : {}),
		}
		const allRows =
			(await this.queueDao.findAll({
				...(Object.keys(where).length ? { where } : {}),
			})) || []
		if (timerStopped) return
		const activeJobKeys = new Set<string>()
		const syncErrors: Error[] = []
		allRows.forEach((queueInfo) => {
			const jobKey = this.queueUniqKey(queueInfo)
			activeJobKeys.add(jobKey)
			try {
				this.syncQueueJob(queueInfo)
			} catch (err: any) {
				this.baseLogError(`Timer-${jobKey}|sync queue job failed`, err)
				syncErrors.push(err instanceof Error ? err : new Error(String(err)))
			}
		})

		// 指定 id 时是增量刷新；只有全量刷新才有足够信息清理已删除队列的任务。
		if (!queueIds.length) {
			this.removeStaleJobs(this.runTaskJobMap, activeJobKeys)
			this.removeStaleJobs(this.checkTaskJobMap, activeJobKeys)
			this.removeStaleJobs(this.expireTaskJobMap, activeJobKeys)
		}
		if (syncErrors.length) {
			throw new Error(`failed to synchronize ${syncErrors.length} queue configuration(s)`)
		}
	}

	queueUniqKey(queueInfo: QueueAttributes) {
		return JSON.stringify([queueInfo.namespace, queueInfo.url])
	}

	syncQueueJob(queueInfo: QueueAttributes) {
		if (timerStopped) return
		const jobKey = this.queueUniqKey(queueInfo)
		const taskInstance = new TaskManager(
			this.ctx,
			queueInfo.id,
			queueInfo.namespace,
			queueInfo.url,
			getRunningKey(queueInfo.namespace, queueInfo.id),
			getWaitingKey(queueInfo.namespace, queueInfo.id),
			queueInfo.count
		)
		const queueSignature = JSON.stringify([queueInfo.id, queueInfo.namespace, queueInfo.url, queueInfo.count])
		const replacements: JobReplacement[] = []
		;[
			{ job: this.runTaskJobMap, cronTab: queueInfo.runCrontab, execFunc: taskInstance.runTask.bind(taskInstance) },
			{ job: this.checkTaskJobMap, cronTab: queueInfo.checkCrontab, execFunc: taskInstance.checkTaskStatus.bind(taskInstance) },
			{ job: this.expireTaskJobMap, cronTab: queueInfo.expireCrontab, execFunc: taskInstance.expireTask.bind(taskInstance) },
		].forEach(({ job: jobMap, cronTab, execFunc }) => {
			const signature = `${queueSignature}:${cronTab}`
			const currentJob = jobMap.get(jobKey)
			if (currentJob?.signature === signature) return
			replacements.push({
				jobMap,
				cron: cronTab,
				signature,
				job: this.createCronJob(jobKey, cronTab, execFunc),
			})
		})

		if (timerStopped) return
		replacements.forEach(({ jobMap, cron, signature, job }) => {
			jobMap.get(jobKey)?.job.stop()
			job.start()
			jobMap.set(jobKey, { cron, signature, job })
		})
	}

	private createCronJob(jobKey: string, cron: string, execFunc: () => Promise<void>): CronJob {
		let isExecuting = false
		return new CronJob(
			cron,
			async () => {
				if (timerStopped) return
				if (isExecuting) {
					this.baseLogInfo(`Timer-${jobKey}|previous cron execution is still running, skip this tick`)
					return
				}

				isExecuting = true
				const execution = (async () => {
					try {
						await execFunc()
					} catch (err: any) {
						this.baseLogError(`Timer-${jobKey}|cron execution failed`, err)
					} finally {
						isExecuting = false
					}
				})()
				activeExecutions.add(execution)
				try {
					await execution
				} finally {
					activeExecutions.delete(execution)
				}
			},
			null,
			false,
			env.cronTimezone
		)
	}

	private removeStaleJobs(jobMap: Map<string, TaskJob>, activeJobKeys: Set<string>): void {
		jobMap.forEach((taskJob, jobKey) => {
			if (activeJobKeys.has(jobKey)) return
			taskJob.job.stop()
			jobMap.delete(jobKey)
		})
	}

	resume(): void {
		timerStopped = false
	}

	async stopAll(): Promise<void> {
		timerStopped = true
		;[this.runTaskJobMap, this.checkTaskJobMap, this.expireTaskJobMap].forEach((jobMap) => {
			jobMap.forEach(({ job }) => job.stop())
		})
		await queueSyncPromise.catch(() => undefined)
		await Promise.allSettled([...activeExecutions])
		;[this.runTaskJobMap, this.checkTaskJobMap, this.expireTaskJobMap].forEach((jobMap) => jobMap.clear())
	}
}
