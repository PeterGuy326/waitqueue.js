/**
 * 睡眠函数
 * @param ms 
 * @returns 
 */
export function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms))
}
