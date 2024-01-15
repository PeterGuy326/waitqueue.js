import { Context } from 'koa'
import { Redis } from 'ioredis'
import _ from 'lodash'
import { Service } from './service'
import { TaskRun } from './task_run'
import { redisCli } from './conf'
import { sleep } from '../utils/util'

export class TaskManager extends Service {
	private url: string
	private runningKey: string // 正在执行的任务
	private waitingKey: string // 等待执行的任务
	private taskRunningCount: number // 并发执行的任务数
	private taskRunInstance: TaskRun
	private redis: Redis
	constructor(ctx: Context, url: string, runningKey: string, waitingKey: string, taskRunningCount: number) {
		super(ctx)
		this.url = url
		this.runningKey = runningKey
		this.waitingKey = waitingKey
		this.taskRunningCount = taskRunningCount
		this.taskRunInstance = new TaskRun(this.ctx, this.url)
		this.redis = redisCli.getInstance()
	}

	/**
	 * 添加任务
	 * @param taskId
	 */
	async addTask(taskId: string): Promise<void> {
		this.selfLog('addTask: push task to queue ', taskId)
		await this.redis.lpush(this.waitingKey, taskId)
	}

	async taskFinishCallback(err: Error | null, taskId: string): Promise<void> {
		if (err) {
			// 不做处理
		}
		this.selfLog(`task trigger success`, taskId)
	}

	// data -> 参数
	async runTask(): Promise<void> {
		const taskRunningCount = this.taskRunningCount
		this.selfLog(`runTask: same time run task max number: ${taskRunningCount}`)
		try {
			// 获取正在执行的任务数
			const runningCount = await this.redis.hlen(this.runningKey)
			this.selfLog(`runTask: running task count: ${runningCount}`)
			let left = taskRunningCount - runningCount
			this.selfLog(`runTask: can run task count: ${left}`)
			while (left && left > 0) {
				const taskId = (await this.redis.rpop(this.waitingKey)) || ''
				this.selfLog(`runTask: prepare exec task`, taskId)
				if (!taskId) break
				const exist = await this.redis.hexists(this.runningKey, taskId)
				// 防止同一任务 id 同一时间重复跑
				if (exist) {
					this.selfLog('runTask: taskId repeat, skip', taskId)
					continue
				}

				// 优先执行任务执行时的前置操作，比如心跳（避免任务先进入 running hash，但是没有心跳，被置位失败）等
				await this.taskRunInstance.before(taskId)
				// 设置任务执行中
				await this.redis.hset(this.runningKey, taskId, 1)
				// 休眠 1s
				await sleep(1000)
				// 异步执行任务
				this.taskRunInstance.run(taskId, this.taskFinishCallback.bind(this)).finally(() => {
					this.taskRunInstance.after()
				})
			}
		} catch (err: any) {
			this.selfLog(`runTask: run task error: ${err.toString()}`)
		}
	}

	/**
	 * 对执行中任务进行检测
	 * 如果数据库中为已完成，则直接在 runningKey 中剔除
	 * 剩余任务，获取目标任务状态，更新数据库任务状态，并对已完成的在 runningKey 中剔除
	 */
	async checkTaskStatus(): Promise<void> {
		this.selfLog('CheckStatus: check task status start')
		const taskMap = await this.redis.hgetall(this.runningKey)
		const taskIds = Object.keys(taskMap)
		this.selfLog('CheckStatus: 正在执行中的任务 id ', taskIds.join(','))
		const completeIds = await this.taskRunInstance.checkTaskStatus(
			taskIds.filter((item) => {
				return item !== ''
			})
		)
		if (completeIds.length) {
			this.selfLog('CheckStatus: 需要从 runningkey 中移除的已完成任务 id ', completeIds.join(','))
			await this.redis.hdel(this.runningKey, ...completeIds)
		}
	}

	/**
	 * 让长时间未结束的任务结束掉
	 * 各 task_run 中自己决定哪些任务为超时任务，并进行关闭
	 * 此时可以不用过分关注，数据库已完成，但是依然在 runningKey 中的， checkTaskStatus 中会进行处理
	 */
	async expireTask(): Promise<void> {
		this.selfLog('ExpireTask: expire task status start')
		const taskMap = await this.redis.hgetall(this.runningKey)
		const taskIds = Object.keys(taskMap)

		const expiredIds = await this.taskRunInstance.expireTasks()
		this.selfLog('ExpireTask: 任务实际过期任务 id 列表 ', expiredIds.join(','))

		// 获取实际已过期但是仍然在缓存执行队列中的任务 id
		const needRemoveFromRunningIds = _.intersection(expiredIds, taskIds)
		if (needRemoveFromRunningIds.length) {
			this.selfLog('ExpireTask: 需要从 runningkey 中移除的过期任务 id ', needRemoveFromRunningIds.join(','))
			await this.redis.hdel(this.runningKey, ...needRemoveFromRunningIds)
		}
	}

	selfLog(message: string, taskId?: string): void {
		this.baseLogInfo(`${this.url}${'|taskId: ' + taskId}|${message}`)
	}
}
