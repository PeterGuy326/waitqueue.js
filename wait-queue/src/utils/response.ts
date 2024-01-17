import { Context } from 'koa'

/**
 * @param {Context} ctx
 * @param {*} data 返回的数据
 * @param {string} msg 提示信息
 * @param {number} code 状态码
 * @return {*}
 */
function success(ctx: Context, data: any = [], msg: string = 'success', code: number = 0) {
	ctx.body = { code, msg, data }
}

/**
 * @param {Context} ctx
 * @param {string} msg 错误提示
 * @param {*} data 扩展提示
 * @param {number} code 状态码
 * @return {*}
 */
function error(ctx: Context, msg: string = 'error', data: any = [], code: number = 1) {
	ctx.body = { code, msg, data }
}

export default {
	success,
	error,
}
