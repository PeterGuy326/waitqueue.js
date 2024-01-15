export function getWaitingKey(namespace: string, queueKey: number): string {
    return `TaskQueue:${namespace}:${queueKey}:waitingQueue`
}

export function getRunningKey(namespace: string, queueKey: number): string {
    return `TaskQueue:${namespace}:${queueKey}:runningHashKv`
}