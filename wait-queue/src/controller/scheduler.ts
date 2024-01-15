import { Context } from "koa";
import * as SchedulerControllerType from "../../type/controller/scheduler";
import { Controller } from "../lib/controller";
import { SchedulerService } from "../service/scheduler";

export class SchedulerController extends Controller {
    private schedulerService: SchedulerService
    constructor(ctx: Context) {
        super(ctx)
        this.schedulerService = new SchedulerService(ctx)
    }

    async addTask(params: SchedulerControllerType.AddTaskReq) {
        return await this.schedulerService.addTask(params)
    }
}