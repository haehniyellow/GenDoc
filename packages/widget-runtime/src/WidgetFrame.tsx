import { useEffect, useMemo, useRef, useState } from 'react'
import type { WidgetDataProvider } from '@doc/shared'
import { widgetBridge } from './bridge'
import { CompileError, compileWidget } from './compiler'
import { buildSrcdoc } from './sandbox/srcdoc'
import { loadVendorScripts } from './sandbox/vendor'

export interface WidgetFrameProps {
  code: string
  dataProvider: WidgetDataProvider
  /** 固定高度（px）。不传则跟随组件内容自适应 */
  height?: number
  className?: string
  onError?: (message: string) => void
}

type Status = { kind: 'compiling' } | { kind: 'ready' } | { kind: 'error'; title: string; detail: string }

function newNonce(): string {
  const a = new Uint8Array(16)
  crypto.getRandomValues(a)
  return Array.from(a, (b) => b.toString(16).padStart(2, '0')).join('')
}

/**
 * 在隔离 iframe 中渲染一个动态组件。
 * 流程：代码 → Worker 编译（带缓存）→ 拼 srcdoc → iframe 运行；数据读写经 postMessage 回到宿主，再由 dataProvider 转发后端。
 */
export function WidgetFrame({ code, dataProvider, height, className, onError }: WidgetFrameProps) {
  const iframeRef = useRef<HTMLIFrameElement>(null)
  const nonce = useMemo(newNonce, [])
  const [srcDoc, setSrcDoc] = useState<string>()
  const [status, setStatus] = useState<Status>({ kind: 'compiling' })
  const [autoHeight, setAutoHeight] = useState(120)

  // 用 ref 持有最新回调与 provider，避免它们变化时重新注册桥 / 重载 iframe
  const live = useRef({ dataProvider, onError })
  live.current = { dataProvider, onError }

  // 注册桥：必须早于 srcdoc 赋值，这样 iframe 一启动发出的 RPC 就能被识别
  useEffect(() => {
    const target = iframeRef.current?.contentWindow
    if (!target) return
    return widgetBridge.register({
      target,
      nonce,
      provider: {
        get: (k) => live.current.dataProvider.get(k),
        set: (k, v) => live.current.dataProvider.set(k, v),
        remove: (k) => live.current.dataProvider.remove(k),
        keys: () => live.current.dataProvider.keys(),
      },
      onResize: setAutoHeight,
      onError: (msg) => {
        setStatus({ kind: 'error', title: '组件运行出错', detail: msg })
        live.current.onError?.(msg)
      },
    })
  }, [nonce])

  useEffect(() => {
    let cancelled = false
    setStatus({ kind: 'compiling' })
    // 编译（Worker）与加载沙箱运行库（同源 fetch，全局只取一次）并行
    Promise.all([compileWidget(code), loadVendorScripts()]).then(
      ([js, vendorJs]) => {
        if (cancelled) return
        setSrcDoc(buildSrcdoc({ compiledJs: js, vendorJs, nonce, hostOrigin: location.origin }))
        setStatus({ kind: 'ready' })
      },
      (err: unknown) => {
        if (cancelled) return
        const title =
          err instanceof CompileError && err.kind === 'policy' ? '代码未通过安全检查' : '组件编译失败'
        const detail = err instanceof Error ? err.message : String(err)
        setStatus({ kind: 'error', title, detail })
        live.current.onError?.(detail)
      },
    )
    return () => {
      cancelled = true
    }
  }, [code, nonce])

  const h = height ?? autoHeight
  return (
    <div className={className} style={{ position: 'relative', width: '100%', height: h }}>
      <iframe
        ref={iframeRef}
        title="widget"
        // 不含 allow-same-origin：iframe 是 opaque origin，读不到宿主的 cookie / localStorage / DOM
        sandbox="allow-scripts"
        referrerPolicy="no-referrer"
        srcDoc={srcDoc}
        style={{ width: '100%', height: '100%', border: 0, display: 'block', background: 'transparent' }}
      />
      {status.kind === 'compiling' && <div style={overlay}>编译中…</div>}
      {status.kind === 'error' && (
        <div style={{ ...overlay, alignItems: 'flex-start', justifyContent: 'flex-start', padding: 12 }}>
          <div>
            <strong style={{ color: '#b42318' }}>{status.title}</strong>
            <pre style={{ margin: '6px 0 0', whiteSpace: 'pre-wrap', font: '12px/1.5 ui-monospace,monospace' }}>
              {status.detail}
            </pre>
          </div>
        </div>
      )}
    </div>
  )
}

const overlay: React.CSSProperties = {
  position: 'absolute',
  inset: 0,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  background: 'rgba(255,255,255,0.86)',
  color: '#57606a',
  fontSize: 13,
  overflow: 'auto',
}
