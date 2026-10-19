/// <reference lib="webworker" />
import { compileCore } from './compile-core'
import type { WorkerRequest, WorkerResponse } from './compiler'

/**
 * JSX/TSX → CommonJS + 策略校验。放在 Worker 里是因为 sucrase 虽快，但对几十 KB 的代码仍会占用数十毫秒主线程，
 * 文档里嵌入多个组件时会明显掉帧。
 */
self.onmessage = (e: MessageEvent<WorkerRequest>) => {
  const { id, code } = e.data
  self.postMessage({ id, ...compileCore(code) } satisfies WorkerResponse)
}
