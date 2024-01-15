import { Context } from 'koa'
import moment from 'moment'

export class Service {
	ctx: Context
	constructor(ctx: Context) {
		this.ctx = ctx
	}

    protected getTraceId(): string {
        return (this.ctx.zipkinTraceId || {}).traceId || ''
    }

    baseLogInfo(msg: string, ctx?: any): void {
        typeof ctx !== 'string' && (ctx = JSON.stringify(ctx))
        this.ctx.log.info(`${moment().utc().format('YYYY-MM-DDTHH:mm:ss.SSS')}|${this.getTraceId()}|msg: ${msg}|ctx: ${ctx}`)
    }

	baseLogError(msg: string, error: any, type = 'error'): void {
        let errMsg = ''
        const err = {} as Error
        Error.captureStackTrace(err, this.baseLogError)
        try {
            errMsg = error.stack ? error.stack.split('\n').join(' ') : JSON.stringify(error)
        } catch (error) { }
        this.ctx.log.error(`${moment().utc().format('YYYY-MM-DDTHH:mm:ss.SSS')}|${this.getTraceId()}|${type}|${err.stack?.split('\n')[1].trim()}|msg: ${msg}|error: ${errMsg}`)
    }
}
