import { useEffect, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import type { DocMeta } from '@doc/shared'
import { api } from '../api'

export default function DocList() {
  const navigate = useNavigate()
  const [docs, setDocs] = useState<DocMeta[] | null>(null)
  const [error, setError] = useState('')

  useEffect(() => {
    api.listDocs().then(setDocs, (e: unknown) => setError(e instanceof Error ? e.message : '加载失败'))
  }, [])

  async function create() {
    try {
      const d = await api.createDoc('无标题文档')
      navigate(`/doc/${d.id}`)
    } catch (e) {
      setError(e instanceof Error ? e.message : '创建失败')
    }
  }

  async function remove(d: DocMeta) {
    if (!confirm(`删除文档「${d.title}」？此操作不可恢复。`)) return
    try {
      await api.deleteDoc(d.id)
      setDocs((list) => list?.filter((x) => x.id !== d.id) ?? null)
    } catch (e) {
      setError(e instanceof Error ? e.message : '删除失败')
    }
  }

  return (
    <main className="list-main">
      <div className="list-head">
        <h2>全部文档</h2>
        <button className="btn primary" onClick={() => void create()}>＋ 新建文档</button>
      </div>
      {error && <div className="error-text">{error}</div>}
      {docs === null && !error && <div className="muted">加载中…</div>}
      {docs?.length === 0 && <div className="muted">还没有文档，点击右上角新建一个，或者去「AI 对话」让 AI 帮你写。</div>}
      <ul className="doc-list">
        {docs?.map((d) => (
          <li key={d.id}>
            <Link to={`/doc/${d.id}`} className="doc-link">
              <span className="doc-title">{d.title}</span>
              {d.shared && <span className="tag">已分享</span>}
              <span className="muted">{new Date(d.updatedAt).toLocaleString()}</span>
            </Link>
            <button className="btn small ghost danger" onClick={() => void remove(d)}>删除</button>
          </li>
        ))}
      </ul>
    </main>
  )
}
