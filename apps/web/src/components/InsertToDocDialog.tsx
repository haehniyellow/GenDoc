import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { DEFAULT_WIDGET_HEIGHT, WIDGET_NODE_NAME, type DocMeta } from '@doc/shared'
import { api } from '../api'

interface Props {
  widget: { uuid: string; title: string }
  onClose: () => void
}

/**
 * 在 AI 对话页里把生成的组件放进某篇文档：把 widget 节点追加到文档 JSON 末尾并保存，然后跳转到该文档。
 * 组件与文档的绑定关系由服务端在保存文档时从内容里推导，这里不需要额外调用。
 */
export default function InsertToDocDialog({ widget, onClose }: Props) {
  const navigate = useNavigate()
  const [docs, setDocs] = useState<DocMeta[] | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    api.listDocs().then(setDocs, (e: unknown) => setError(e instanceof Error ? e.message : '加载文档失败'))
  }, [])

  async function insertInto(docId: string) {
    setBusy(true)
    setError('')
    try {
      const doc = await api.getDoc(docId)
      const content = (doc.content ?? { type: 'doc', content: [] }) as { type: string; content?: unknown[] }
      content.content = [
        ...(content.content ?? []),
        { type: WIDGET_NODE_NAME, attrs: { uuid: widget.uuid, title: widget.title, height: DEFAULT_WIDGET_HEIGHT, width: null } },
        { type: 'paragraph' }, // 组件后留一个空段落，方便继续输入
      ]
      await api.saveDoc(docId, { content })
      navigate(`/doc/${docId}`)
    } catch (e) {
      setError(e instanceof Error ? e.message : '插入失败')
      setBusy(false)
    }
  }

  async function createAndInsert() {
    setBusy(true)
    setError('')
    try {
      const doc = await api.createDoc(widget.title || '新文档')
      await insertInto(doc.id)
    } catch (e) {
      setError(e instanceof Error ? e.message : '创建失败')
      setBusy(false)
    }
  }

  return (
    <div className="dialog-mask" onClick={onClose}>
      <div className="dialog" role="dialog" aria-label="插入到文档" onClick={(e) => e.stopPropagation()}>
        <div className="dialog-head">
          <strong>把「{widget.title}」插入到文档</strong>
          <button className="btn ghost small" onClick={onClose} aria-label="关闭">
            ✕
          </button>
        </div>
        <button className="btn primary" disabled={busy} onClick={() => void createAndInsert()}>
          ＋ 新建文档并插入
        </button>
        <div className="muted" style={{ margin: '12px 0 6px' }}>
          或选择已有文档（追加到末尾）
        </div>
        {docs === null && !error && <div className="muted">加载中…</div>}
        {docs?.length === 0 && <div className="muted">还没有文档</div>}
        <ul className="dialog-list">
          {docs?.map((d) => (
            <li key={d.id}>
              <button className="btn" disabled={busy} onClick={() => void insertInto(d.id)}>
                {d.title}
              </button>
            </li>
          ))}
        </ul>
        {error && <div className="error-text">{error}</div>}
      </div>
    </div>
  )
}
