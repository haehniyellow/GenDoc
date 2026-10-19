import type {
  ChatSessionMeta,
  DocMeta,
  DocRecord,
  SendMessageInput,
  SendMessageResult,
  SessionDetail,
  User,
  WidgetDataProvider,
  WidgetRecord,
} from './protocol'
import { readSSE } from './sse'

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message)
  }
}

export interface ApiOptions {
  baseURL?: string
  getToken: () => string | null
  onUnauthorized?: () => void
}

export type Api = ReturnType<typeof createApi>

export function createApi(opts: ApiOptions) {
  const base = opts.baseURL ?? ''

  function headers(extra?: HeadersInit): Headers {
    const h = new Headers(extra)
    const token = opts.getToken()
    if (token) h.set('Authorization', `Bearer ${token}`)
    return h
  }

  async function request<T>(path: string, init: RequestInit & { json?: unknown } = {}): Promise<T> {
    const h = headers(init.headers)
    let body = init.body
    if (init.json !== undefined) {
      h.set('Content-Type', 'application/json')
      body = JSON.stringify(init.json)
    }
    const res = await fetch(base + path, { ...init, headers: h, body })
    if (res.status === 401) opts.onUnauthorized?.()
    if (!res.ok) {
      let msg = res.statusText
      // 代理连不上后端时返回的是 HTML 错误页 + "Bad Gateway"，对用户没有意义
      if (res.status === 502 || res.status === 503 || res.status === 504) {
        throw new ApiError(res.status, '后端服务暂时不可用（可能仍在启动），请稍后重试')
      }
      try {
        const j = (await res.json()) as { error?: string }
        if (j.error) msg = j.error
      } catch {
        /* 非 JSON 响应 */
      }
      throw new ApiError(res.status, msg)
    }
    if (res.status === 204) return undefined as T
    return (await res.json()) as T
  }

  const enc = encodeURIComponent

  return {
    // ── auth ──
    login: (username: string, password: string) =>
      request<{ token: string; user: User }>('/api/auth/login', { method: 'POST', json: { username, password } }),
    register: (username: string, password: string) =>
      request<{ token: string; user: User }>('/api/auth/register', { method: 'POST', json: { username, password } }),
    me: () => request<User>('/api/auth/me'),

    // ── docs ──
    listDocs: () => request<DocMeta[]>('/api/docs'),
    createDoc: (title: string) => request<DocRecord>('/api/docs', { method: 'POST', json: { title } }),
    getDoc: (id: string) => request<DocRecord>(`/api/docs/${enc(id)}`),
    saveDoc: (id: string, patch: { title?: string; content?: unknown; shared?: boolean }) =>
      request<DocMeta>(`/api/docs/${enc(id)}`, { method: 'PUT', json: patch }),
    deleteDoc: (id: string) => request<void>(`/api/docs/${enc(id)}`, { method: 'DELETE' }),

    // ── widgets ──
    getWidget: (uuid: string) => request<WidgetRecord>(`/api/widgets/${enc(uuid)}`),
    listWidgets: () => request<Omit<WidgetRecord, 'code'>[]>('/api/widgets'),
    widgetData: (uuid: string): WidgetDataProvider => ({
      async get(key) {
        const r = await request<{ value: unknown } | null>(`/api/widgets/${enc(uuid)}/data/${enc(key)}`)
        return r?.value ?? null
      },
      async set(key, value) {
        await request<void>(`/api/widgets/${enc(uuid)}/data/${enc(key)}`, { method: 'PUT', json: { value } })
      },
      async remove(key) {
        await request<void>(`/api/widgets/${enc(uuid)}/data/${enc(key)}`, { method: 'DELETE' })
      },
      async keys() {
        const r = await request<{ keys: string[] }>(`/api/widgets/${enc(uuid)}/data`)
        return r.keys
      },
    }),

    // ── AI 会话 ──
    listSessions: () => request<ChatSessionMeta[]>('/api/ai/sessions'),
    createSession: () => request<ChatSessionMeta>('/api/ai/sessions', { method: 'POST', json: {} }),
    getSession: (id: string) => request<SessionDetail>(`/api/ai/sessions/${enc(id)}`),
    deleteSession: (id: string) => request<void>(`/api/ai/sessions/${enc(id)}`, { method: 'DELETE' }),
    sendMessage: (sessionId: string, input: SendMessageInput) =>
      request<SendMessageResult>(`/api/ai/sessions/${enc(sessionId)}/messages`, { method: 'POST', json: input }),
    cancelRun: (runId: string) => request<void>(`/api/ai/runs/${enc(runId)}/cancel`, { method: 'POST' }),

    /** 连接 run 的 SSE 流；lastSeq 通过 Last-Event-ID 头传给服务端，服务端从 lastSeq+1 开始重放 */
    async openRunStream(runId: string, lastSeq: number, signal: AbortSignal): Promise<Response> {
      const h = headers({ Accept: 'text/event-stream', 'Last-Event-ID': String(lastSeq) })
      const res = await fetch(`${base}/api/ai/runs/${enc(runId)}/events`, { headers: h, signal })
      if (res.status === 401) opts.onUnauthorized?.()
      return res
    },

    /** 选中文本 AI 改写（一次性流，不做断线续传），逐段回调文本增量 */
    async rewrite(
      input: { text: string; instruction: string },
      onDelta: (chunk: string) => void,
      signal: AbortSignal,
    ): Promise<void> {
      const h = headers({ Accept: 'text/event-stream', 'Content-Type': 'application/json' })
      const res = await fetch(`${base}/api/ai/rewrite`, {
        method: 'POST',
        headers: h,
        body: JSON.stringify(input),
        signal,
      })
      if (!res.ok || !res.body) throw new ApiError(res.status, '改写请求失败')
      for await (const f of readSSE(res.body)) {
        const d = JSON.parse(f.data) as { text?: string; message?: string }
        if (f.event === 'error') throw new Error(d.message ?? '改写失败')
        if (f.event === 'delta' && d.text) onDelta(d.text)
        if (f.event === 'done') return
      }
    },
  }
}
