type AddTaskReq<T> = {
    url: string, // 完整回调路径
    data: T // 回调接口参数
}

type AddTaskResp = {
    taskId: string
}

export {
    AddTaskReq
}