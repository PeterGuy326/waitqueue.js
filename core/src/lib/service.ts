import { Context } from "koa";

export class Service {
    private ctx: Context
    constructor(ctx: Context) {
        this.ctx = ctx
    }
}