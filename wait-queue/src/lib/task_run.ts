import { Context } from 'koa'
import { Service } from './service'
import axios from 'axios'
import { StatusCodes } from 'http-status-codes'

export enum TASK_TYPE_CODE {
	run = 'run',
	check = 'check',
	expire = 'expire',
}

export class TaskRun extends Service {
	running: boolean
	private url: string

	constructor(ctx: Context, url: string) {
		super(ctx)
		this.running = false
		this.url = url
	}

	async before(data: string) {
		this.running = true
	}

	after() {
		this.running = false
	}

	async run(taskId: string, cb: (err: Error | null, taskId: string) => object): Promise<void> {
		try {
			await this._run(taskId)
			cb(null, taskId)
		} catch (error: any) {
			this.baseLogError(`执行任务 taskId: ${taskId} 失败`, error)
			cb(error, taskId)
		}
	}

	async _run(taskId: string) {
		return await this._fetch(TASK_TYPE_CODE.run, [taskId])
	}

    /**
     * @param taskIds 检查任务状态
     * @return 返回已完成任务 id
     */
    async checkTaskStatus(taskIds: string[]): Promise<string[]> {
        if (!taskIds?.length) return []
        const { data } = await this._fetch(TASK_TYPE_CODE.check, taskIds)
        return data?.taskIds || []
    }
    
    /**
     * @returns 返回长时间未有结果的任务 id
     */
    async expireTasks(): Promise<string[]> {
        const { data } = await this._fetch(TASK_TYPE_CODE.expire)
        return data?.taskIds || []
    }

    // 被调用方的返回必须严格遵守格式规范，{ data: { taskIds: string[], ... } ... }
    private async _fetch(type: TASK_TYPE_CODE, taskIds?: string[]) {
		let body = { type }
		if (taskIds) {
			body = Object.assign(body, { taskIds })
		}
		// 回调预准备的方法
		this.ctx.log.info(`${this.ctx.zipkinTrace}${this.url}`)
		const res = await axios.post(this.url, body)
		if (res.status !== StatusCodes.OK) {
			this.ctx.log.error(`${type}|http status: ${res.status}, ${JSON.stringify(res)}`)
		}
		return res.data
	}
}
