import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import { NodeViewWrapper, type NodeViewProps } from '@tiptap/react'
import { WIDGET_UPDATED_EVENT, type Api, type WidgetRecord } from '@doc/shared'
import { WidgetFrame } from '@doc/widget-runtime'

const MIN_H = 120
const MAX_H = 1200
const MIN_W = 240

type Drag = { mode: 'h' | 'w' | 'both'; startX: number; startY: number; startW: number; startH: number }

/** 文档里的组件块：拉取代码 → 沙箱 iframe 运行；右下角与边缘可拖拽调整尺寸 */
export function WidgetNodeView({ node, updateAttributes, deleteNode, selected, editor, extension }: NodeViewProps) {
  const api = extension.options.api as Api
  const uuid = node.attrs.uuid as string
  const title = (node.attrs.title as string) || '组件'
  const editable = editor.isEditable

  const [rec, setRec] = useState<WidgetRecord | null>(null)
  const [error, setError] = useState('')
  const [tick, setTick] = useState(0)
  const dataProvider = useMemo(() => api.widgetData(uuid), [api, uuid])

  useEffect(() => {
    let alive = true
    setError('')
    api.getWidget(uuid).then(
      (r) => alive && setRec(r),
      (e: unknown) => alive && setError(e instanceof Error ? e.message : '组件加载失败'),
    )
    return () => {
      alive = false
    }
  }, [api, uuid, tick])

  // AI 在侧边栏里修改了这个组件 → 重新拉取最新代码
  useEffect(() => {
    const onUpdated = (e: Event) => {
      if ((e as CustomEvent<{ uuid: string }>).detail.uuid === uuid) setTick((n) => n + 1)
    }
    window.addEventListener(WIDGET_UPDATED_EVENT, onUpdated)
    return () => window.removeEventListener(WIDGET_UPDATED_EVENT, onUpdated)
  }, [uuid])

  // ── 拖拽调整尺寸 ──
  const wrapRef = useRef<HTMLDivElement>(null)
  const drag = useRef<Drag | null>(null)
  // 拖拽过程中只改本地状态，松手时才写入文档（一次事务，避免每个像素都触发保存）
  const [live, setLive] = useState<{ w: number | null; h: number } | null>(null)
  const height = live?.h ?? (node.attrs.height as number)
  const width = live ? live.w : (node.attrs.width as number | null)

  function onPointerDown(mode: Drag['mode']) {
    return (e: ReactPointerEvent<HTMLElement>) => {
      if (!editable || !wrapRef.current) return
      e.preventDefault()
      e.stopPropagation()
      e.currentTarget.setPointerCapture(e.pointerId)
      drag.current = {
        mode,
        startX: e.clientX,
        startY: e.clientY,
        startW: wrapRef.current.offsetWidth,
        startH: height,
      }
    }
  }

  function containerWidth(): number {
    return wrapRef.current?.parentElement?.clientWidth ?? 800
  }

  function onPointerMove(e: ReactPointerEvent<HTMLElement>) {
    const d = drag.current
    if (!d) return
    const h = d.mode === 'w' ? height : clamp(d.startH + (e.clientY - d.startY), MIN_H, MAX_H)
    let w: number | null = width
    if (d.mode !== 'h') w = clamp(d.startW + (e.clientX - d.startX), MIN_W, containerWidth())
    setLive({ w, h })
  }

  function onPointerUp() {
    if (!drag.current) return
    drag.current = null
    if (!live) return
    // 宽度接近容器时视为“占满”，存 null，这样窗口变化时能自适应
    const full = live.w === null || live.w >= containerWidth() - 4
    updateAttributes({ height: Math.round(live.h), width: full ? null : Math.round(live.w!) })
    setLive(null)
  }

  return (
    <NodeViewWrapper className="widget-node" data-selected={selected ? 'true' : 'false'} contentEditable={false}>
      <div ref={wrapRef} className="widget-box" style={{ width: width ? `${width}px` : '100%', maxWidth: '100%' }}>
        <div className="widget-head" data-drag-handle>
          <span className="widget-title">🧩 {rec?.title ?? title}</span>
          {rec && <span className="widget-ver">v{rec.version}</span>}
          <span style={{ flex: 1 }} />
          {editable && (
            <button className="widget-btn" title="移除组件（数据保留）" onClick={() => deleteNode()}>
              ✕
            </button>
          )}
        </div>
        <div className="widget-body" style={{ height }}>
          {error && <div className="widget-error">{error}</div>}
          {rec && <WidgetFrame code={rec.code} dataProvider={dataProvider} height={height} />}
          {!rec && !error && <div className="widget-loading">加载组件…</div>}
          {/* 拖拽时盖住 iframe，否则鼠标进入 iframe 后 pointermove 会丢失 */}
          {live && <div className="widget-shield" />}
        </div>
        {editable && (
          <>
            <div
              className="widget-resize h"
              onPointerDown={onPointerDown('h')}
              onPointerMove={onPointerMove}
              onPointerUp={onPointerUp}
              title="拖动调整高度"
            />
            <div
              className="widget-resize w"
              onPointerDown={onPointerDown('w')}
              onPointerMove={onPointerMove}
              onPointerUp={onPointerUp}
              onDoubleClick={() => updateAttributes({ width: null })}
              title="拖动调整宽度，双击恢复占满"
            />
            <div
              className="widget-resize corner"
              onPointerDown={onPointerDown('both')}
              onPointerMove={onPointerMove}
              onPointerUp={onPointerUp}
              title="拖动同时调整宽高"
            />
          </>
        )}
      </div>
    </NodeViewWrapper>
  )
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n))
}
