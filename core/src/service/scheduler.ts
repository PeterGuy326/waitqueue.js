import { Context } from "koa";
import { Service } from "../lib/service";

export class SchedulerService extends Service {
    constructor(ctx: Context) {
        super(ctx)
    }

    async addTask<T>(url: string, data: T) {
        
        return 
    }
}