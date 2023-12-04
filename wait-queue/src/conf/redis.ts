import Redis from 'ioredis'

interface RedisConf {
	host: string
	port: number
	password: string
}

class RedisCli {
	private redis: Redis
	constructor(params: RedisConf) {
		const { port, host, password } = params
		this.redis = new Redis(port, host, {
			password,
		})
	}

	getInstance() {
        return this.redis
    }
}

export const redisCli = new RedisCli({
	host: process.env.REDIS_HOST || '127.0.0.1',
	port: +(process.env.REDIS_PORT || 6379),
	password: process.env.REDIS_PASSWORD || '123456'
})
