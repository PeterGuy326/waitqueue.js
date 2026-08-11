import { Context } from 'koa'
import { lookup as dnsLookup } from 'node:dns/promises'
import * as http from 'node:http'
import * as https from 'node:https'
import { isIP } from 'node:net'
import { Service } from './service'
import { env } from '../conf/env'
import { HookUrlPolicy } from '../security/hook_url_policy'
import { waitQueueMetrics, WaitQueueMetrics } from '../observability/metrics'

const MAX_CALLBACK_RESPONSE_BYTES = 1_048_576

export interface CallbackResponse {
	status: number
	body: string
}

export interface CallbackRequestOptions {
	body: string
	signal: AbortSignal
	hookUrlPolicy: HookUrlPolicy
}

export type CallbackTransport = (url: URL, options: CallbackRequestOptions) => Promise<CallbackResponse>
export type CallbackAddressResolver = (
	hostname: string
) => Promise<readonly { address: string; family: number }[]>

function hostnameWithoutBrackets(hostname: string): string {
	return hostname.replace(/^\[|\]$/g, '')
}

const defaultAddressResolver: CallbackAddressResolver = async (hostname) =>
	dnsLookup(hostname, { all: true, verbatim: true })

function abortError(): Error {
	const error = new Error('callback request aborted')
	error.name = 'AbortError'
	return error
}

function withAbortSignal<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
	if (signal.aborted) return Promise.reject(abortError())
	return new Promise<T>((resolve, reject) => {
		const onAbort = () => reject(abortError())
		signal.addEventListener('abort', onAbort, { once: true })
		operation.then(
			(value) => {
				signal.removeEventListener('abort', onAbort)
				resolve(value)
			},
			(error) => {
				signal.removeEventListener('abort', onAbort)
				reject(error)
			}
		)
	})
}

export async function resolvePinnedCallbackAddresses(
	url: URL,
	hookUrlPolicy: HookUrlPolicy,
	resolveAddresses: CallbackAddressResolver = defaultAddressResolver
): Promise<readonly { address: string; family: number }[] | undefined> {
	if (!hookUrlPolicy.enforcesPublicAddresses) return undefined
	const hostname = hostnameWithoutBrackets(url.hostname)
	if (isIP(hostname)) return undefined
	const addresses = await resolveAddresses(hostname)
	if (addresses.length === 0) throw new Error('callback hostname did not resolve')
	addresses.forEach(({ address }) => hookUrlPolicy.assertAllowedAddress(address))
	return addresses
}

export function createCallbackTransport(
	resolveAddresses: CallbackAddressResolver = defaultAddressResolver
): CallbackTransport {
	return async (url, options) => {
		const pinnedAddresses = await withAbortSignal(
			resolvePinnedCallbackAddresses(url, options.hookUrlPolicy, resolveAddresses),
			options.signal
		)
		const requestOptions: http.RequestOptions = {
			method: 'POST',
			headers: {
				accept: 'application/json',
				'content-type': 'application/json',
				'content-length': Buffer.byteLength(options.body),
			},
			agent: false,
			signal: options.signal,
		}
		if (pinnedAddresses) {
			requestOptions.lookup = ((_hostname: string, lookupOptions: { all?: boolean }, callback: Function) => {
				if (lookupOptions.all) callback(null, pinnedAddresses)
				else callback(null, pinnedAddresses[0].address, pinnedAddresses[0].family)
			}) as any
		}

		return new Promise<CallbackResponse>((resolve, reject) => {
			const request = (url.protocol === 'https:' ? https : http).request(url, requestOptions, (response) => {
				const chunks: Buffer[] = []
				let receivedBytes = 0
				response.on('data', (chunk: Buffer | string) => {
					const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
					receivedBytes += buffer.length
					if (receivedBytes > MAX_CALLBACK_RESPONSE_BYTES) {
						response.destroy(new Error('callback response exceeded the size limit'))
						return
					}
					chunks.push(buffer)
				})
				response.on('error', reject)
				response.on('end', () => {
					resolve({ status: response.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') })
				})
			})
			request.on('error', reject)
			request.end(options.body)
		})
	}
}

export const postCallback = createCallbackTransport()

export enum TASK_TYPE_CODE {
	run = 'run',
	check = 'check',
	expire = 'expire',
}

export class TaskRun extends Service {
	private url: string
	private queueId: number
	private namespace: string
	private hookUrlPolicy: HookUrlPolicy
	private callbackTransport: CallbackTransport
	private metrics: WaitQueueMetrics

	constructor(
		ctx: Context,
		url: string,
		queueId: number,
		namespace: string,
		hookUrlPolicy: HookUrlPolicy = new HookUrlPolicy(env.security.hookUrlAllowlist, {
			allowPrivate: env.security.allowPrivateHookUrls,
		}),
		callbackTransport: CallbackTransport = postCallback,
		metrics: WaitQueueMetrics = waitQueueMetrics
	) {
		super(ctx)
		this.url = url
		this.queueId = queueId
		this.namespace = namespace
		this.hookUrlPolicy = hookUrlPolicy
		this.callbackTransport = callbackTransport
		this.metrics = metrics
	}

	async run(taskId: string): Promise<void> {
		await this.observeCallback(TASK_TYPE_CODE.run, () => this._run(taskId))
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
		return this.observeCallback(TASK_TYPE_CODE.check, async () =>
			this.taskIdsFromResponse(
				await this._fetch(TASK_TYPE_CODE.check, taskIds),
				TASK_TYPE_CODE.check
			)
		)
	}

	/**
	 * @returns 返回长时间未有结果的任务 id
	 */
	async expireTasks(): Promise<string[]> {
		return this.observeCallback(TASK_TYPE_CODE.expire, async () =>
			this.taskIdsFromResponse(await this._fetch(TASK_TYPE_CODE.expire), TASK_TYPE_CODE.expire)
		)
	}

	private async observeCallback<T>(type: TASK_TYPE_CODE, callback: () => Promise<T>): Promise<T> {
		try {
			const result = await callback()
			this.metrics.recordCallback(this.queueId, type, 'success')
			return result
		} catch (error) {
			this.metrics.recordCallback(this.queueId, type, 'failure')
			throw error
		}
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
		const callbackUrl = this.hookUrlPolicy.assertAllowed(this.url)
		this.baseLogInfo('callback requested', {
			callbackType: type,
			queueId: this.queueId,
			namespace: this.namespace,
			taskCount: taskIds?.length ?? 0,
		})
		const abortController = new AbortController()
		const timeout = setTimeout(() => abortController.abort(), env.hookTimeoutMs)
		try {
			const res = await this.callbackTransport(callbackUrl, {
				body: JSON.stringify(body),
				signal: abortController.signal,
				hookUrlPolicy: this.hookUrlPolicy,
			})
			if (res.status !== 200) throw new Error(`${type} callback returned HTTP ${res.status}`)

			const responseBody = res.body
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
