type NewQueueKeyReq = {
	hookUrl: string
	namespace: string
	currMaxCount?: number
    crontab: {
        run: string
        check: string
        expire: string
    }
}

type NewQueueKeyRes = {
    isOk: boolean
}

export {
    NewQueueKeyReq,
    NewQueueKeyRes
}