import Redis from 'ioredis'

import { env } from './env'

class RedisCli {
	private redis: Redis
	constructor() {
		const { port, host, password } = env.redis
		this.redis = new Redis(port, host, {
			password,
			lazyConnect: true,
			maxRetriesPerRequest: 2,
		})
	}

	getInstance() {
		return this.redis
	}
}

export const redisCli = new RedisCli()
