import { Context, Next } from 'koa'
import response from '../utils/response'
import { HttpError } from '../utils/http_error'

export async function errorHandler(ctx: Context, next: Next): Promise<void> {
	try {
		await next()
	} catch (error: any) {
		const reportedStatus = error?.status ?? error?.statusCode
		const status =
			error instanceof HttpError
				? error.status
				: Number.isInteger(reportedStatus) && reportedStatus >= 400 && reportedStatus < 500
					? reportedStatus
					: 500
		const message = status < 500 ? error.message : 'internal server error'

		ctx.status = status
		response.error(ctx, message)
		if (status >= 500) ctx.log?.error({ err: error }, 'request failed')
	}
}
