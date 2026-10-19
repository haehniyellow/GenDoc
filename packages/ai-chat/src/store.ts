import { createStore, type StoreApi } from 'zustand/vanilla'
import {
  ApiError,
  notifyWidgetUpdated,
  type Api,
  type ChatMessage,
  type ChatSessionMeta,
  type WidgetToolResult,
} from '@doc/shared'
import { applyEvent, initLive, type LiveState } from './live'
import { followRun } from './runClient'

export interface ChatState {
  sessions: ChatSessionMeta[]
  currentId: string | null
  messages: ChatMessage[]
  /** 进行中的生成任务；为 null 表示当前会话空闲 */
  live: LiveState | null
  loading: boolean
  error: string | null

  init: () => Promise<void>
  selectSession: (id: string) => Promise<void>
  newSession: () => Promise<void>
  deleteSession: (id: string) => Promise<void>
  send: (text: string, opts?: { docId?: string }) => Promise<void>
  stop: () => Promise<void>
  /** 断线重连多次失败后，由用户手动重新订阅 */
  resume: () => void
  dismissError: () => void
  /** 卸载时调用：中止事件流订阅（服务端任务不受影响） */
  dispose: () => void
}

export type ChatStore = StoreApi<ChatState>

export function newId(): string {
  if (typeof globalThis.crypto?.randomUUID === 'function') return crypto.randomUUID()
  // 非安全上下文（局域网 http）没有 randomUUID
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`
}

const errMsg = (e: unknown) => (e instanceof ApiError || e instanceof Error ? e.message : '未知错误')

/** 对幂等请求做有限重试（服务端用 clientMessageId 去重，重试不会导致重复执行） */
async function retry<T>(fn: () => Promise<T>, times = 3): Promise<T> {
  let lastErr: unknown
  for (let i = 0; i < times; i++) {
    try {
      return await fn()
    } catch (e) {
      // 4xx 是确定性错误，重试没有意义
      if (e instanceof ApiError && e.status >= 400 && e.status < 500) throw e
      lastErr = e
      await new Promise((r) => setTimeout(r, 400 * (i + 1)))
    }
  }
  throw lastErr
}

export function createChatStore(api: Api): ChatStore {
  // 当前正在订阅的事件流；切换会话时中止它（服务端任务不受影响，回来后可以重新接上）
  let follower: AbortController | null = null
  // 会话切换的“版本号”，用来丢弃过期的异步结果（快速连点切换时，慢的请求后返回不应覆盖新会话）
  let selectSeq = 0

  return createStore<ChatState>()((set, get) => {
    const abortFollow = () => {
      follower?.abort()
      follower = null
    }

    async function refreshSessions() {
      try {
        set({ sessions: await api.listSessions() })
      } catch {
        /* 列表刷新失败不影响主流程 */
      }
    }

    /** 从服务端重新加载当前会话（以数据库为准），必要时接上仍在进行的任务 */
    async function reload(sessionId: string, opts: { keepLiveOnFailure?: boolean; finishedRunId?: string } = {}) {
      const token = selectSeq
      try {
        const detail = await api.getSession(sessionId)
        if (token !== selectSeq || get().currentId !== sessionId) return
        set({ messages: detail.messages, loading: false })
        // finishedRunId：刚刚已经收到终止事件的任务，即使服务端还报告它进行中也不再重复订阅，避免死循环
        if (detail.activeRun && detail.activeRun.id !== opts.finishedRunId) follow(sessionId, detail.activeRun.id)
        else set({ live: null })
      } catch (e) {
        if (token !== selectSeq) return
        set({ loading: false, error: errMsg(e), live: opts.keepLiveOnFailure ? get().live : null })
      }
    }

    function follow(sessionId: string, runId: string) {
      abortFollow()
      const ctrl = new AbortController()
      follower = ctrl
      set({ live: initLive(runId) })

      void (async () => {
        const result = await followRun({
          api,
          runId,
          signal: ctrl.signal,
          onStatus: (status) => set((s) => (s.live?.runId === runId ? { live: { ...s.live, status } } : {})),
          onEvent: (ev) => {
            set((s) => (s.live?.runId === runId ? { live: applyEvent(s.live, ev) } : {}))
            // AI 修改了某个组件：通知文档里已渲染的同一组件重新拉取代码
            if (ev.type === 'tool.end' && ev.name === 'modify_widget' && ev.result) {
              try {
                const r = JSON.parse(ev.result) as WidgetToolResult
                if (r.ok && r.widgetId) notifyWidgetUpdated(r.widgetId)
              } catch {
                /* 结果不是合法 JSON，忽略 */
              }
            }
          },
        })
        if (ctrl.signal.aborted || follower !== ctrl) return // 已经切走
        follower = null

        if (result === 'failed') {
          set((s) => (s.live ? { live: { ...s.live, status: 'failed' } } : {}))
          return // 保留实时状态，让用户点“重新连接”
        }
        // done / gone：任务已结束（或日志已过期），以数据库里的完整消息为准
        await reload(sessionId, { finishedRunId: runId })
        void refreshSessions()
      })()
    }

    return {
      sessions: [],
      currentId: null,
      messages: [],
      live: null,
      loading: false,
      error: null,

      async init() {
        set({ loading: true, error: null })
        try {
          const sessions = await api.listSessions()
          set({ sessions })
          const first = sessions[0]
          if (first) await get().selectSession(first.id)
          else set({ loading: false })
        } catch (e) {
          set({ loading: false, error: errMsg(e) })
        }
      },

      async selectSession(id) {
        const token = ++selectSeq
        abortFollow()
        set({ currentId: id, messages: [], live: null, loading: true, error: null })
        try {
          const detail = await api.getSession(id)
          if (token !== selectSeq) return
          set({ messages: detail.messages, loading: false })
          // 刷新页面 / 切回来时任务还在跑：重放全部事件重建流式状态，然后继续跟随
          if (detail.activeRun) follow(id, detail.activeRun.id)
        } catch (e) {
          if (token === selectSeq) set({ loading: false, error: errMsg(e) })
        }
      },

      async newSession() {
        ++selectSeq
        abortFollow()
        try {
          const s = await api.createSession()
          set((st) => ({ sessions: [s, ...st.sessions], currentId: s.id, messages: [], live: null, error: null }))
        } catch (e) {
          set({ error: errMsg(e) })
        }
      },

      async deleteSession(id) {
        try {
          await api.deleteSession(id)
        } catch (e) {
          set({ error: errMsg(e) })
          return
        }
        const rest = get().sessions.filter((s) => s.id !== id)
        set({ sessions: rest })
        if (get().currentId === id) {
          const next = rest[0]
          if (next) await get().selectSession(next.id)
          else {
            ++selectSeq
            abortFollow()
            set({ currentId: null, messages: [], live: null })
          }
        }
      },

      async send(raw, opts) {
        const text = raw.trim()
        if (!text || get().live) return
        set({ error: null })

        let sessionId = get().currentId
        if (!sessionId) {
          try {
            const s = await api.createSession()
            sessionId = s.id
            set((st) => ({ sessions: [s, ...st.sessions], currentId: s.id }))
          } catch (e) {
            set({ error: errMsg(e) })
            return
          }
        }

        const clientMessageId = newId()
        const optimistic: ChatMessage = {
          id: `local-${clientMessageId}`,
          role: 'user',
          content: text,
          createdAt: new Date().toISOString(),
        }
        set((s) => ({ messages: [...s.messages, optimistic] }))

        try {
          const res = await retry(() => api.sendMessage(sessionId!, { clientMessageId, content: text, docId: opts?.docId }))
          if (get().currentId !== sessionId) return // 发送期间用户切走了，任务在服务端继续，回来时会接上
          if (res.runId) follow(sessionId, res.runId)
          else await reload(sessionId)
        } catch (e) {
          // 发送失败：撤回乐观消息，并把文字还给用户由 UI 决定是否回填
          set((s) => ({ messages: s.messages.filter((m) => m.id !== optimistic.id), error: errMsg(e) }))
        }
      },

      async stop() {
        const live = get().live
        if (!live) return
        try {
          await api.cancelRun(live.runId)
        } catch (e) {
          set({ error: errMsg(e) })
        }
      },

      resume() {
        const { currentId } = get()
        if (currentId) void reload(currentId, { keepLiveOnFailure: true })
      },

      dismissError: () => set({ error: null }),

      dispose() {
        ++selectSeq
        abortFollow()
      },
    }
  })
}
