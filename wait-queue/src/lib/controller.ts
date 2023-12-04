import { Context } from "koa";

export class Controller {
    private ctx: Context
    constructor(ctx: Context) {
        this.ctx = ctx
    }
}