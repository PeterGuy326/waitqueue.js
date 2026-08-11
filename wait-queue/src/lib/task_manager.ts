import { Context } from 'koa'
import { Redis } from 'ioredis'
import { Service } from './service'
import { TaskRun } from './task_run'
import { redisCli } from '../conf/redis'
import { env } from '../conf/env'
import { HookUrlPolicy } from '../security/hook_url_policy'
import { ReliabilityConfig } from '../reliability/config'
import {
	ClaimBatch,
	FailureTransition,
	RedisTaskStore,
	TaskClaim,
} from '../reliability/task_store'
import { waitQueueMetrics, WaitQueueMetrics } from '../observability/metrics'

export interface TaskStateStore {
	claim(maxRunning: number): Promise<ClaimBatch>
	acknowledge(claim: TaskClaim): Promise<boolean>
	fail(claim: TaskClaim): Promise<FailureTransition>
	runningSnapshot(): Promise<Record<string, string>>
	release(taskSnapshot: Record<string, string>, taskIds: string[]): Promise<string[]>
}

export interface TaskManagerOptions {
	redis?: Redis
	taskStore?: TaskStateStore
	taskRunner?: TaskRun
	reliability?: ReliabilityConfig
	clock?: () => number
	tokenFactory?: () => string
	metrics?: WaitQueueMetrics
}

function acknowledgedSnapshot(taskSnapshot: Record<string, string>): Record<string, string> {
	return Object.fromEntries(
		Object.entries(taskSnapshot).filter(([, claimToken]) => !claimToken.startsWith('pending:'))
	)
}

export class TaskManager extends Service {
	private queueId: number
	private namespace: string
	private taskRunningCount: number
	private taskRunInstance: TaskRun
	private taskStore: TaskStateStore
	private metrics: WaitQueueMetrics

	constructor(
		ctx: Context,
		queueId: number,
		namespace: string,
		url: string,
		_runningKey: string,
		_waitingKey: string,
		taskRunningCount: number,
		hookUrlPolicy: HookUrlPolicy = new HookUrlPolicy(env.security.hookUrlAllowlist, {
			allowPrivate: env.security.allowPrivateHookUrls,
		}),
		options: TaskManagerOptions = {}
	) {
		super(ctx)
		this.queueId = queueId
		this.namespace = namespace
		this.taskRunningCount = taskRunningCount
		this.metrics = options.metrics ?? waitQueueMetrics
		this.taskStore =
			options.taskStore ??
			new RedisTaskStore(
				options.redis ?? redisCli.getInstance(),
				namespace,
				queueId,
				options.reliability ?? env.reliability,
				options.clock,
				options.tokenFactory
			)
		this.taskRunInstance =
			options.taskRunner ??
			new TaskRun(this.ctx, url, queueId, namespace, hookUrlPolicy, undefined, this.metrics)
	}

	private async dispatchTask(claim: TaskClaim): Promise<void> {
		try {
			await this.taskRunInstance.run(claim.taskId)
		} catch (error: any) {
			this.baseLogError('task trigger failed', error)
			try {
				const transition = await this.taskStore.fail(claim)
				if (transition.outcome === 'retry') {
					this.metrics.recordRetry(this.queueId, 'scheduled', 'callback_failed')
				} else if (transition.outcome === 'dead') {
					this.metrics.recordRetry(this.queueId, 'dead_lettered', 'callback_failed')
				} else {
					this.metrics.recordClaim(this.queueId, 'stale')
				}
				this.selfLog('task trigger failure transitioned', {
					outcome: transition.outcome,
					retryCount: transition.retryCount,
				})
			} catch (redisError) {
				this.baseLogError('failed to persist task trigger failure', redisError)
			}
			return
		}

		try {
			const acknowledged = await this.taskStore.acknowledge(claim)
			this.metrics.recordClaim(
				this.queueId,
				acknowledged ? 'acknowledged' : 'stale'
			)
			this.selfLog(acknowledged ? 'task trigger acknowledged' : 'stale task trigger acknowledgement ignored')
		} catch (redisError) {
			// The pending lease remains recoverable. The callback may be delivered more than once,
			// so callback handlers must remain idempotent.
			this.baseLogError('failed to acknowledge task trigger', redisError)
		}
	}

	async runTask(): Promise<void> {
		const taskRunningCount = Math.floor(Number(this.taskRunningCount))
		this.selfLog(`runTask: same time run task max number: ${taskRunningCount}`)
		if (!Number.isFinite(taskRunningCount) || taskRunningCount <= 0) {
			this.selfLog(`runTask: invalid max running task count: ${this.taskRunningCount}`)
			return
		}

		try {
			const batch = await this.taskStore.claim(taskRunningCount)
			this.metrics.recordClaim(this.queueId, 'claimed', batch.claims.length)
			this.metrics.recordClaim(this.queueId, 'recovered', batch.recovered)
			this.metrics.recordRetry(
				this.queueId,
				'scheduled',
				'lease_expired',
				Math.max(batch.recovered - batch.deadLettered, 0)
			)
			this.metrics.recordRetry(
				this.queueId,
				'dead_lettered',
				'lease_expired',
				batch.deadLettered
			)
			this.metrics.recordRetry(
				this.queueId,
				'promoted',
				'not_applicable',
				batch.promoted
			)
			this.selfLog('runTask: state transition summary', {
				claimed: batch.claims.length,
				recovered: batch.recovered,
				promoted: batch.promoted,
				deadLettered: batch.deadLettered,
			})
			await Promise.all(batch.claims.map((claim) => this.dispatchTask(claim)))
		} catch (err: any) {
			this.baseLogError('runTask: failed to claim or dispatch tasks', err)
		}
	}

	async checkTaskStatus(): Promise<void> {
		this.selfLog('CheckStatus: check task status start')
		const taskMap = acknowledgedSnapshot(await this.taskStore.runningSnapshot())
		const taskIds = Object.keys(taskMap)
		this.selfLog(`CheckStatus: acknowledged task count: ${taskIds.length}`)
		const completeIds = await this.taskRunInstance.checkTaskStatus(taskIds)
		const releasedIds = await this.taskStore.release(taskMap, completeIds)
		if (releasedIds.length) {
			this.selfLog(`CheckStatus: released completed task count: ${releasedIds.length}`)
		}
	}

	async expireTask(): Promise<void> {
		this.selfLog('ExpireTask: expire task status start')
		const taskMap = acknowledgedSnapshot(await this.taskStore.runningSnapshot())
		const expiredIds = await this.taskRunInstance.expireTasks()
		this.selfLog(`ExpireTask: expired task count: ${expiredIds.length}`)
		const releasedIds = await this.taskStore.release(taskMap, expiredIds)
		if (releasedIds.length) {
			this.selfLog(`ExpireTask: released expired task count: ${releasedIds.length}`)
		}
	}

	selfLog(message: string, context: Record<string, unknown> = {}): void {
		this.baseLogInfo(message, { queueId: this.queueId, namespace: this.namespace, ...context })
	}
}
