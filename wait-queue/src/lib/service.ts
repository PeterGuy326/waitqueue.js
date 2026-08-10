import { Context } from 'koa'

export class Service {
	ctx: Context
	constructor(ctx: Context) {
		this.ctx = ctx
	}

    protected getTraceId(): string {
        return (this.ctx.zipkinTraceId || {}).traceId || ''
    }

	baseLogInfo(msg: string, ctx?: any): void {
		this.ctx.log.info({ traceId: this.getTraceId(), context: ctx }, msg)
	}

	baseLogError(msg: string, error: any, type = 'error'): void {
		this.ctx.log.error({ err: error, traceId: this.getTraceId(), type }, msg)
	}
}
