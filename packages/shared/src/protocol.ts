/**
 * 前后端、宿主页面与 iframe 之间共用的协议定义。
 * 服务端 Go 代码（server/internal/runs, server/internal/ai）需与这里保持一致。
 */

// ───────────────────────── 领域模型 ─────────────────────────

export interface User {
  id: string
  username: string
}

export interface DocMeta {
  id: string
  title: string
  shared: boolean
  updatedAt: string
}

export interface DocRecord extends DocMeta {
  /** TipTap JSON */
  content: unknown
  canEdit: boolean
}

/** 文档 JSON 里组件节点的类型名与默认高度。服务端 server/internal/ai/docjson.go 中的 WidgetNodeType 需与之一致 */
export const WIDGET_NODE_NAME = 'widget'
export const DEFAULT_WIDGET_HEIGHT = 280

export interface WidgetRecord {
  uuid: string
  title: string
  code: string
  version: number
  updatedAt: string
}

export interface ChatSessionMeta {
  id: string
  title: string
  updatedAt: string
}

export interface ToolRun {
  callId: string
  name: string
  args: string
  /** 工具返回的 JSON 字符串；执行中为 undefined */
  result?: string
  error?: string
}

export interface ChatMessage {
  id: string
  role: 'user' | 'assistant'
  content: string
  createdAt: string
  meta?: {
    tools?: ToolRun[]
    status?: 'done' | 'error' | 'cancelled'
    error?: string
  }
}

export interface SessionDetail {
  session: ChatSessionMeta
  messages: ChatMessage[]
  /** 会话仍有进行中的生成任务时返回，客户端据此断线续传 */
  activeRun: { id: string } | null
}

// ───────────────────────── SSE 事件 ─────────────────────────
// 每一帧: id: <seq>\nevent: <type>\ndata: <json>\n\n ，seq 在同一个 run 内单调递增，从 1 开始

export type RunEvent =
  | { type: 'run.start'; runId: string }
  | { type: 'text.delta'; text: string }
  | { type: 'stage'; callId?: string; stage: string; message: string }
  | { type: 'tool.start'; callId: string; name: string; args: string }
  | { type: 'tool.end'; callId: string; name: string; result?: string; error?: string }
  | { type: 'run.done' }
  | { type: 'run.error'; message: string }

export type RunEventType = RunEvent['type']

export const TERMINAL_EVENTS: ReadonlySet<RunEventType> = new Set(['run.done', 'run.error'])

/** create_widget / modify_widget 工具的 result JSON 结构 */
export interface WidgetToolResult {
  ok: boolean
  widgetId?: string
  title?: string
  version?: number
  /** 审核未通过或重试耗尽时的说明 */
  issues?: string[]
}

export interface SendMessageInput {
  clientMessageId: string
  content: string
  /** 文档页面侧边栏调用时携带，供 read_document 等工具使用 */
  docId?: string
}

export interface SendMessageResult {
  runId: string
  /** 同一个 clientMessageId 重复提交时为 true，服务端不会重复执行 */
  deduplicated: boolean
}

// ───────────────────────── iframe RPC ─────────────────────────

export const RPC_NAMESPACE = 'doc-widget-rpc/1'

export type RpcMethod =
  | 'storage.get'
  | 'storage.set'
  | 'storage.remove'
  | 'storage.keys'
  | 'ui.resize'
  | 'log.error'

export interface RpcRequest {
  ns: typeof RPC_NAMESPACE
  kind: 'req'
  /** 宿主在生成 srcdoc 时注入的一次性随机串，用于把消息绑定到具体的 iframe 实例 */
  nonce: string
  id: number
  method: RpcMethod
  params?: Record<string, unknown>
}

export interface RpcResponse {
  ns: typeof RPC_NAMESPACE
  kind: 'res'
  id: number
  ok: boolean
  result?: unknown
  error?: string
}

/** 组件数据的存取接口。由应用层实现（对接后端），widget-runtime 不直接依赖网络。 */
export interface WidgetDataProvider {
  get(key: string): Promise<unknown>
  set(key: string, value: unknown): Promise<void>
  remove(key: string): Promise<void>
  keys(): Promise<string[]>
}

export const WIDGET_KEY_PATTERN = /^[A-Za-z0-9_.:-]{1,128}$/
/** 单个 value 序列化后的最大字节数，宿主与服务端都会校验 */
export const WIDGET_VALUE_MAX_BYTES = 64 * 1024
