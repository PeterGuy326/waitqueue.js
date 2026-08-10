import { Context } from 'koa'
import createLogger from 'pino'

export const logger = createLogger({ name: 'waitqueue' })

export function createBackgroundContext(): Context {
	return {
		log: logger.child({ component: 'scheduler' }),
		zipkinTrace: '',
		zipkinTraceId: {},
	} as unknown as Context
}
