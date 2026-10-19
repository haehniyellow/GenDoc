import { TERMINAL_EVENTS, readSSE, type Api, type RunEvent } from '@doc/shared'

export type ConnStatus = 'connecting' | 'live' | 'reconnecting'

/**
 * done   收到了终止事件（run.done / run.error），任务已结束
 * aborted 被调用方主动中止（如切换会话）
 * gone   服务端已不认识这个 run（重启或日志过期）——应改为重新拉会话，以数据库里的消息为准
 * failed 多次重连仍失败——任务可能还在服务端跑，交给用户手动重试
 */
export type FollowResult = 'done' | 'aborted' | 'gone' | 'failed'

export interface FollowOptions {
  api: Pick<Api, 'openRunStream'>
  runId: string
  /** 已经处理到的事件序号；服务端会从它之后开始重放 */
  afterSeq?: number
  signal: AbortSignal
  onEvent: (ev: RunEvent, seq: number) => void
  onStatus?: (s: ConnStatus) => void
  maxRetries?: number
  /** 超过这个时间没收到任何字节（含心跳）就判定连接已死并重连。服务端心跳间隔是 15s */
  idleTimeoutMs?: number
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>
}

const defaultSleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    const t = setTimeout(resolve, ms)
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(t)
        resolve()
      },
      { once: true },
    )
  })

export function backoffMs(attempt: number): number {
  return Math.min(500 * 2 ** (attempt - 1), 8000) + Math.random() * 250
}

/**
 * 订阅一个 run 的事件流，断线自动重连并从最后收到的 seq 之后续传。
 *
 * 为什么不用 EventSource：它无法带 Authorization 头，重连位点也不可控。
 * 这里用 fetch + 手动解析，重连时显式带上 Last-Event-ID，并且按 seq 去重，
 * 所以即使服务端重放了已经收到的事件，onEvent 也不会被重复调用。
 */
export async function followRun(opts: FollowOptions): Promise<FollowResult> {
  const { api, runId, signal, onEvent, onStatus } = opts
  const maxRetries = opts.maxRetries ?? 6
  const idleTimeoutMs = opts.idleTimeoutMs ?? 45_000
  const sleep = opts.sleep ?? defaultSleep

  let last = opts.afterSeq ?? 0
  let failures = 0

  while (!signal.aborted) {
    onStatus?.(failures === 0 ? 'connecting' : 'reconnecting')

    // idle 控制器：既响应外部中止，也用于“长时间无数据”的超时中断
    const idle = new AbortController()
    const onOuterAbort = () => idle.abort()
    signal.addEventListener('abort', onOuterAbort, { once: true })
    let timer: ReturnType<typeof setTimeout> | undefined
    const arm = () => {
      clearTimeout(timer)
      timer = setTimeout(() => idle.abort(), idleTimeoutMs)
    }

    try {
      arm()
      const res = await api.openRunStream(runId, last, idle.signal)
      if (res.status === 404) return 'gone'
      if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`)
      onStatus?.('live')

      for await (const frame of readSSE(res.body, arm)) {
        const seq = Number(frame.id)
        if (!Number.isFinite(seq) || seq <= last) continue // 重放的旧事件
        let ev: RunEvent
        try {
          ev = JSON.parse(frame.data) as RunEvent
        } catch {
          continue
        }
        last = seq
        failures = 0 // 有进展就清零，避免“每次都能收几条再断”的场景被误判为失败
        onEvent(ev, seq)
        if (TERMINAL_EVENTS.has(ev.type)) return 'done'
      }
      // 流被正常关闭却没有终止事件：当作断线，重连
    } catch {
      if (signal.aborted) return 'aborted'
    } finally {
      clearTimeout(timer)
      signal.removeEventListener('abort', onOuterAbort)
    }

    if (signal.aborted) return 'aborted'
    failures++
    if (failures > maxRetries) return 'failed'
    await sleep(backoffMs(failures), signal)
  }
  return 'aborted'
}
