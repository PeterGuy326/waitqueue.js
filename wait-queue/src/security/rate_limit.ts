export interface RateLimitDecision {
	allowed: boolean
	retryAfterSeconds: number
}

interface WindowEntry {
	count: number
	resetAt: number
}

export const MAX_RATE_LIMIT_CLIENTS = 10_000

export class FixedWindowRateLimiter {
	private readonly entries = new Map<string, WindowEntry>()

	constructor(
		private readonly maxRequests: number,
		private readonly windowMs: number,
		private readonly now: () => number = Date.now,
		private readonly maxClients: number = MAX_RATE_LIMIT_CLIENTS
	) {
		if (!Number.isInteger(maxRequests) || maxRequests < 0) throw new Error('maxRequests must be a non-negative integer')
		if (!Number.isInteger(windowMs) || windowMs <= 0) throw new Error('windowMs must be a positive integer')
		if (!Number.isInteger(maxClients) || maxClients <= 0 || maxClients > MAX_RATE_LIMIT_CLIENTS) {
			throw new Error(`maxClients must be an integer between 1 and ${MAX_RATE_LIMIT_CLIENTS}`)
		}
	}

	get size(): number {
		return this.entries.size
	}

	consume(key: string): RateLimitDecision {
		if (this.maxRequests === 0) return { allowed: true, retryAfterSeconds: 0 }

		const now = this.now()
		let entry = this.entries.get(key)
		if (entry && now >= entry.resetAt) {
			this.entries.delete(key)
			entry = undefined
		}

		if (!entry) {
			this.ensureCapacity(now)
			entry = { count: 0, resetAt: now + this.windowMs }
			this.entries.set(key, entry)
		}

		entry.count += 1
		const allowed = entry.count <= this.maxRequests
		return {
			allowed,
			retryAfterSeconds: allowed ? 0 : Math.max(1, Math.ceil((entry.resetAt - now) / 1000)),
		}
	}

	private ensureCapacity(now: number): void {
		if (this.entries.size < this.maxClients) return
		for (const [key, entry] of this.entries) {
			if (now >= entry.resetAt) this.entries.delete(key)
		}
		while (this.entries.size >= this.maxClients) {
			const oldestKey = this.entries.keys().next().value as string | undefined
			if (oldestKey === undefined) break
			this.entries.delete(oldestKey)
		}
	}
}
