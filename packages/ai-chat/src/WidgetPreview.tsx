import { useEffect, useMemo, useState } from 'react'
import { WIDGET_UPDATED_EVENT, type WidgetRecord } from '@doc/shared'
import { WidgetFrame } from '@doc/widget-runtime'
import { useChatContext } from './ChatContext'

/** 聊天里的组件预览卡片：在沙箱 iframe 中真实运行，可查看代码、可插入文档 */
export function WidgetPreview({ uuid, fallbackTitle }: { uuid: string; fallbackTitle?: string }) {
  const { api, onInsertWidget } = useChatContext()
  const [rec, setRec] = useState<WidgetRecord | null>(null)
  const [error, setError] = useState('')
  const [showCode, setShowCode] = useState(false)
  const [reloadTick, setReloadTick] = useState(0)
  const dataProvider = useMemo(() => api.widgetData(uuid), [api, uuid])

  useEffect(() => {
    let alive = true
    api.getWidget(uuid).then(
      (r) => alive && setRec(r),
      (e: unknown) => alive && setError(e instanceof Error ? e.message : '加载失败'),
    )
    return () => {
      alive = false
    }
  }, [api, uuid, reloadTick])

  // 组件被 AI 修改后，重新拉取最新代码
  useEffect(() => {
    const onUpdated = (e: Event) => {
      if ((e as CustomEvent<{ uuid: string }>).detail.uuid === uuid) setReloadTick((n) => n + 1)
    }
    window.addEventListener(WIDGET_UPDATED_EVENT, onUpdated)
    return () => window.removeEventListener(WIDGET_UPDATED_EVENT, onUpdated)
  }, [uuid])

  const title = rec?.title ?? fallbackTitle ?? '组件'
  return (
    <div className="widget-card">
      <div className="widget-card-head">
        <strong>{title}</strong>
        {rec && <span className="muted">v{rec.version}</span>}
        <span style={{ flex: 1 }} />
        <button className="btn small ghost" onClick={() => setShowCode((v) => !v)}>
          {showCode ? '隐藏代码' : '查看代码'}
        </button>
        {onInsertWidget && (
          <button className="btn small primary" onClick={() => onInsertWidget({ uuid, title })}>
            插入文档
          </button>
        )}
      </div>
      {error && <div className="error-text" style={{ padding: 12 }}>{error}</div>}
      {rec && <WidgetFrame code={rec.code} dataProvider={dataProvider} height={220} />}
      {rec && showCode && <pre className="code-view">{rec.code}</pre>}
    </div>
  )
}
