import type { RunEvent } from '@doc/shared'
import type { ConnStatus } from './runClient'

export interface LiveTool {
  callId: string
  name: string
  args: string
  /** 工具内部的阶段进度，如“审核 Agent 正在检查…” */
  stage?: string
  result?: string
  error?: string
  done: boolean
}

/** 正在进行的生成任务的实时状态，由事件流逐步归约得到 */
export interface LiveState {
  runId: string
  text: string
  tools: LiveTool[]
  status: ConnStatus | 'failed'
  error?: string
}

export function initLive(runId: string): LiveState {
  return { runId, text: '', tools: [], status: 'connecting' }
}

/** 纯函数：把一个事件应用到实时状态上。重放全部事件即可重建出完整状态，这是“刷新后接上”的基础。 */
export function applyEvent(s: LiveState, ev: RunEvent): LiveState {
  switch (ev.type) {
    case 'text.delta':
      return { ...s, text: s.text + ev.text }
    case 'tool.start':
      if (s.tools.some((t) => t.callId === ev.callId)) return s
      return { ...s, tools: [...s.tools, { callId: ev.callId, name: ev.name, args: ev.args, done: false }] }
    case 'stage': {
      // 优先按 callId 关联；缺失时挂到最近一个未完成的工具上
      const idx = ev.callId
        ? s.tools.findIndex((t) => t.callId === ev.callId)
        : s.tools.findLastIndex((t) => !t.done)
      if (idx < 0) return s
      return { ...s, tools: s.tools.map((t, i) => (i === idx ? { ...t, stage: ev.message } : t)) }
    }
    case 'tool.end':
      return {
        ...s,
        tools: s.tools.map((t) =>
          t.callId === ev.callId ? { ...t, result: ev.result, error: ev.error, stage: undefined, done: true } : t,
        ),
      }
    case 'run.error':
      return { ...s, error: ev.message }
    default:
      return s
  }
}
