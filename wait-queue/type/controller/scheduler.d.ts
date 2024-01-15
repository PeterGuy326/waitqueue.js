type AddTaskReq = {
	hookUrl: string // 完整回调路径
	taskId: string
	namespace: string
}

type AddTaskResp = {
	isOk: boolean
}

export { AddTaskReq, AddTaskResp }
