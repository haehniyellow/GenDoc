import {
  RPC_NAMESPACE,
  WIDGET_KEY_PATTERN,
  WIDGET_VALUE_MAX_BYTES,
  type RpcMethod,
  type RpcRequest,
  type RpcResponse,
  type WidgetDataProvider,
} from '@doc/shared'

export interface BridgeEntry {
  /** 该 iframe 的 contentWindow，宿主用它判断消息真正来自谁 */
  target: Window
  nonce: string
  /** 组件对应的后端数据接口。绑定在宿主侧，widgetId 永远不从消息里取 */
  provider: WidgetDataProvider
  onResize?: (height: number) => void
  onError?: (message: string) => void
}

const METHODS: ReadonlySet<string> = new Set<RpcMethod>([
  'storage.get',
  'storage.set',
  'storage.remove',
  'storage.keys',
  'ui.resize',
  'log.error',
])

/** 令牌桶：每个 iframe 每秒最多 30 次 RPC，突发上限 60，防止组件死循环打爆后端 */
class RateLimiter {
  private tokens = 60
  private last = Date.now()
  take(): boolean {
    const now = Date.now()
    this.tokens = Math.min(60, this.tokens + ((now - this.last) / 1000) * 30)
    this.last = now
    if (this.tokens < 1) return false
    this.tokens -= 1
    return true
  }
}

function isRpcRequest(m: unknown): m is RpcRequest {
  if (typeof m !== 'object' || m === null) return false
  const r = m as Record<string, unknown>
  return (
    r.ns === RPC_NAMESPACE &&
    r.kind === 'req' &&
    typeof r.nonce === 'string' &&
    typeof r.id === 'number' &&
    typeof r.method === 'string'
  )
}

function checkKey(params: Record<string, unknown> | undefined): string {
  const key = params?.key
  if (typeof key !== 'string' || !WIDGET_KEY_PATTERN.test(key)) throw new Error('key 不合法（仅限 1-128 位字母数字 _ . : -）')
  return key
}

/** 执行一次 RPC。独立导出以便单测；不涉及 postMessage。 */
export async function handleRpc(entry: BridgeEntry, req: RpcRequest): Promise<unknown> {
  const params = req.params
  switch (req.method) {
    case 'storage.get':
      return (await entry.provider.get(checkKey(params))) ?? null
    case 'storage.set': {
      const key = checkKey(params)
      const json = JSON.stringify(params?.value ?? null)
      if (new TextEncoder().encode(json).length > WIDGET_VALUE_MAX_BYTES) {
        throw new Error(`数据超过 ${WIDGET_VALUE_MAX_BYTES / 1024}KB 上限`)
      }
      await entry.provider.set(key, params?.value ?? null)
      return null
    }
    case 'storage.remove':
      await entry.provider.remove(checkKey(params))
      return null
    case 'storage.keys':
      return await entry.provider.keys()
    case 'ui.resize': {
      const h = Number(params?.height)
      if (Number.isFinite(h)) entry.onResize?.(Math.max(40, Math.min(2000, Math.round(h))))
      return null
    }
    case 'log.error':
      entry.onError?.(String(params?.message ?? '').slice(0, 2000))
      return null
    default:
      throw new Error('未知方法')
  }
}

/**
 * 宿主侧 RPC 桥。整个页面只挂一个 window message 监听器，按 e.source 路由到对应 iframe。
 *
 * 校验顺序（任何一步不通过都静默丢弃，不回复，避免被探测）：
 *   1. e.source 必须是已注册的 iframe.contentWindow —— sandbox 下 e.origin 恒为 "null"，无法靠 origin 区分，
 *      所以以 source 引用为准
 *   2. 消息符合 RPC 协议且 nonce 与该实例一致
 *   3. method 在白名单内，且未超过速率限制
 */
export class WidgetBridge {
  private entries = new Map<Window, { entry: BridgeEntry; limiter: RateLimiter }>()
  private listening = false

  register(entry: BridgeEntry): () => void {
    this.entries.set(entry.target, { entry, limiter: new RateLimiter() })
    if (!this.listening) {
      window.addEventListener('message', this.onMessage)
      this.listening = true
    }
    return () => {
      this.entries.delete(entry.target)
      if (this.entries.size === 0 && this.listening) {
        window.removeEventListener('message', this.onMessage)
        this.listening = false
      }
    }
  }

  private onMessage = (e: MessageEvent) => {
    const slot = e.source ? this.entries.get(e.source as Window) : undefined
    if (!slot) return
    const req: unknown = e.data
    if (!isRpcRequest(req) || req.nonce !== slot.entry.nonce || !METHODS.has(req.method)) return

    const respond = (r: Omit<RpcResponse, 'ns' | 'kind' | 'id'>) =>
      // 目标是 opaque origin 的 iframe，只能用 '*'；消息只投递给这个具体的 window 对象
      slot.entry.target.postMessage({ ns: RPC_NAMESPACE, kind: 'res', id: req.id, ...r } satisfies RpcResponse, '*')

    if (!slot.limiter.take()) {
      respond({ ok: false, error: '请求过于频繁' })
      return
    }
    handleRpc(slot.entry, req).then(
      (result) => respond({ ok: true, result }),
      (err: unknown) => respond({ ok: false, error: err instanceof Error ? err.message : String(err) }),
    )
  }
}

export const widgetBridge = new WidgetBridge()
