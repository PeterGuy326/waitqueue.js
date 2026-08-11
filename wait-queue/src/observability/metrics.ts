import { FailureReason } from '../reliability/task_store'
import { QueueRuntimeSnapshot } from './runtime_snapshot'

export const PROMETHEUS_CONTENT_TYPE = 'text/plain; version=0.0.4; charset=utf-8'

export type CallbackType = 'run' | 'check' | 'expire'
export type CallbackOutcome = 'success' | 'failure'
export type ClaimOutcome = 'claimed' | 'recovered' | 'acknowledged' | 'stale'
export type RetryOutcome = 'scheduled' | 'promoted' | 'dead_lettered'
export type RetryReason = FailureReason | 'not_applicable'

interface CounterSample {
	labels: Readonly<Record<string, string>>
	value: number
}

class CounterFamily {
	private readonly samples = new Map<string, CounterSample>()

	constructor(
		readonly name: string,
		readonly help: string,
		private readonly labelNames: readonly string[]
	) {}

	increment(labels: Readonly<Record<string, string>>, amount = 1): void {
		if (!Number.isSafeInteger(amount) || amount <= 0) return
		const normalized = Object.fromEntries(
			this.labelNames.map((labelName) => [labelName, labels[labelName] ?? ''])
		)
		const key = JSON.stringify(this.labelNames.map((labelName) => normalized[labelName]))
		const current = this.samples.get(key)
		this.samples.set(key, { labels: normalized, value: (current?.value ?? 0) + amount })
	}

	entries(): CounterSample[] {
		return [...this.samples.values()].sort((left, right) =>
			JSON.stringify(left.labels).localeCompare(JSON.stringify(right.labels))
		)
	}

	labelsFor(sample: CounterSample): readonly [string, string][] {
		return this.labelNames.map((labelName) => [labelName, sample.labels[labelName]])
	}

	sum(matcher: Readonly<Record<string, string>>): number {
		return [...this.samples.values()].reduce(
			(total, sample) =>
				Object.entries(matcher).every(([name, value]) => sample.labels[name] === value)
					? total + sample.value
					: total,
			0
		)
	}
}

function escapeHelp(value: string): string {
	return value.replace(/\\/g, '\\\\').replace(/\n/g, '\\n')
}

function escapeLabel(value: string): string {
	return value.replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/"/g, '\\"')
}

function formatLabels(labels: readonly (readonly [string, string])[]): string {
	if (!labels.length) return ''
	return `{${labels.map(([name, value]) => `${name}="${escapeLabel(value)}"`).join(',')}}`
}

function metricHeader(lines: string[], name: string, help: string, type: 'counter' | 'gauge'): void {
	lines.push(`# HELP ${name} ${escapeHelp(help)}`)
	lines.push(`# TYPE ${name} ${type}`)
}

/**
 * A deliberately small in-process Prometheus registry. Its public methods fix
 * every label name and enum value so task IDs, callback URLs, tokens, and raw
 * errors cannot accidentally become unbounded labels.
 */
export class WaitQueueMetrics {
	readonly startedAt: string
	private readonly callbacks = new CounterFamily(
		'waitqueue_callback_attempts_total',
		'Callback invocations by queue, callback type, and outcome.',
		['queue_id', 'type', 'outcome']
	)
	private readonly claims = new CounterFamily(
		'waitqueue_claim_transitions_total',
		'Claim state transitions by queue and outcome.',
		['queue_id', 'outcome']
	)
	private readonly retries = new CounterFamily(
		'waitqueue_retry_transitions_total',
		'Retry and dead-letter transitions by queue, outcome, and controlled reason.',
		['queue_id', 'outcome', 'reason']
	)

	constructor(clock: () => number = Date.now) {
		const startedAt = new Date(clock())
		if (Number.isNaN(startedAt.valueOf())) throw new Error('metrics clock returned an invalid timestamp')
		this.startedAt = startedAt.toISOString()
	}

	recordCallback(queueId: number, type: CallbackType, outcome: CallbackOutcome): void {
		this.callbacks.increment({ queue_id: String(queueId), type, outcome })
	}

	recordClaim(queueId: number, outcome: ClaimOutcome, amount = 1): void {
		this.claims.increment({ queue_id: String(queueId), outcome }, amount)
	}

	recordRetry(
		queueId: number,
		outcome: RetryOutcome,
		reason: RetryReason,
		amount = 1
	): void {
		this.retries.increment({ queue_id: String(queueId), outcome, reason }, amount)
	}

	queueSnapshot(queueId: number): {
		callbacks: { success: number; failure: number }
		claims: { claimed: number; recovered: number }
	} {
		const queue = { queue_id: String(queueId) }
		return {
			callbacks: {
				success: this.callbacks.sum({ ...queue, outcome: 'success' }),
				failure: this.callbacks.sum({ ...queue, outcome: 'failure' }),
			},
			claims: {
				claimed: this.claims.sum({ ...queue, outcome: 'claimed' }),
				recovered: this.claims.sum({ ...queue, outcome: 'recovered' }),
			},
		}
	}

	render(runtime: readonly QueueRuntimeSnapshot[]): string {
		const lines: string[] = []
		const gauges = [
			{
				name: 'waitqueue_queue_waiting_tasks',
				help: 'Tasks currently waiting to be claimed.',
				value: (queue: QueueRuntimeSnapshot): number | null => queue.waiting,
			},
			{
				name: 'waitqueue_queue_running_tasks',
				help: 'Tasks currently occupying a running slot.',
				value: (queue: QueueRuntimeSnapshot): number | null => queue.running,
			},
			{
				name: 'waitqueue_queue_retrying_tasks',
				help: 'Tasks currently delayed in the retry schedule.',
				value: (queue: QueueRuntimeSnapshot): number | null => queue.retrying,
			},
			{
				name: 'waitqueue_queue_dead_letter_tasks',
				help: 'Tasks currently retained in the dead-letter queue.',
				value: (queue: QueueRuntimeSnapshot): number | null => queue.deadLetters,
			},
			{
				name: 'waitqueue_queue_oldest_waiting_seconds',
				help: 'Age in seconds of the oldest waiting task; absent when empty or unknown.',
				value: (queue: QueueRuntimeSnapshot): number | null => queue.oldestWaitingAgeSeconds,
			},
		]
		for (const gauge of gauges) {
			metricHeader(lines, gauge.name, gauge.help, 'gauge')
			for (const queue of runtime) {
				const value = gauge.value(queue)
				if (value === null) continue
				lines.push(
					`${gauge.name}${formatLabels([['queue_id', String(queue.queueId)]])} ${value}`
				)
			}
		}

		for (const family of [this.callbacks, this.claims, this.retries]) {
			metricHeader(lines, family.name, family.help, 'counter')
			for (const sample of family.entries()) {
				lines.push(`${family.name}${formatLabels(family.labelsFor(sample))} ${sample.value}`)
			}
		}
		return `${lines.join('\n')}\n`
	}
}

export const waitQueueMetrics = new WaitQueueMetrics()
