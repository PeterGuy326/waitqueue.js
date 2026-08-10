import { Context } from 'koa'
import { Service } from './service'
import { env } from '../conf/env'

export enum TASK_TYPE_CODE {
	run = 'run',
	check = 'check',
	expire = 'expire',
}

export class TaskRun extends Service {
	private url: string
	private queueId: number
	private namespace: string

	constructor(ctx: Context, url: string, queueId: number, namespace: string) {
		super(ctx)
		this.url = url
		this.queueId = queueId
		this.namespace = namespace
	}

	async run(taskId: string): Promise<void> {
		await this._run(taskId)
	}

	private async _run(taskId: string): Promise<void> {
		await this._fetch(TASK_TYPE_CODE.run, [taskId])
	}

	/**
	 * @param taskIds 检查任务状态
	 * @return 返回已完成任务 id
	 */
	async checkTaskStatus(taskIds: string[]): Promise<string[]> {
		if (!taskIds?.length) return []
		return this.taskIdsFromResponse(await this._fetch(TASK_TYPE_CODE.check, taskIds), TASK_TYPE_CODE.check)
	}

	/**
	 * @returns 返回长时间未有结果的任务 id
	 */
	async expireTasks(): Promise<string[]> {
		return this.taskIdsFromResponse(await this._fetch(TASK_TYPE_CODE.expire), TASK_TYPE_CODE.expire)
	}

	private taskIdsFromResponse(response: any, type: TASK_TYPE_CODE): string[] {
		const taskIds = response?.data?.taskIds
		if (!Array.isArray(taskIds) || taskIds.some((taskId) => typeof taskId !== 'string')) {
			throw new Error(`${type} callback response must contain data.taskIds as a string array`)
		}
		return taskIds
	}

	// 被调用方的返回必须严格遵守格式规范，{ data: { taskIds: string[], ... } ... }
	private async _fetch(type: TASK_TYPE_CODE, taskIds?: string[]) {
		const body = taskIds
			? { type, queueId: this.queueId, namespace: this.namespace, taskIds }
			: { type, queueId: this.queueId, namespace: this.namespace }
		this.baseLogInfo(`callback ${type}`, { url: this.url, taskIds })
		const abortController = new AbortController()
		const timeout = setTimeout(() => abortController.abort(), env.hookTimeoutMs)
		try {
			const res = await fetch(this.url, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify(body),
				signal: abortController.signal,
			})
			if (res.status !== 200) throw new Error(`${type} callback returned HTTP ${res.status}`)

			const responseBody = await res.text()
			if (!responseBody) return {}
			try {
				return JSON.parse(responseBody)
			} catch {
				return responseBody
			}
		} finally {
			clearTimeout(timeout)
		}
	}
}
