// types.d.ts
import { Context } from 'koa'
import { QueueController } from '../../src/controller/queue'
import { SchedulerController } from '../../src/controller/scheduler'

export interface ContextExtensional extends Context {
	queueController: QueueController,
    schedulerController: SchedulerController
}
