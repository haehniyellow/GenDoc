import { Suspense, lazy, useCallback, useEffect, useRef, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { DocEditor, insertWidget, type Editor, type JSONContent } from '@doc/editor'
import { useAuth } from '@doc/ui'
import type { DocRecord } from '@doc/shared'
import { api } from '../api'

// AI 面板只在打开时才加载
const ChatPanel = lazy(() => import('@doc/ai-chat').then((m) => ({ default: m.ChatPanel })))

type SaveState = 'saved' | 'saving' | 'error'
const AUTOSAVE_MS = 1000

export default function DocPage() {
  const { id = '' } = useParams()
  const [doc, setDoc] = useState<DocRecord | null>(null)
  const [error, setError] = useState('')

  useEffect(() => {
    setDoc(null)
    setError('')
    let alive = true
    api.getDoc(id).then(
      (d) => alive && setDoc(d),
      (e: unknown) => alive && setError(e instanceof Error ? e.message : '文档加载失败'),
    )
    return () => {
      alive = false
    }
  }, [id])

  if (error) {
    return (
      <div className="center-fill" style={{ display: 'grid', gap: 12, alignContent: 'center' }}>
        <div className="error-text">{error}</div>
        <Link to="/">返回文档列表</Link>
      </div>
    )
  }
  if (!doc) return <div className="center-fill">加载中…</div>
  // 以文档 id 为 key：切换文档时整体重新挂载，避免编辑器残留上一篇的状态
  return <DocView key={doc.id} doc={doc} />
}

function DocView({ doc }: { doc: DocRecord }) {
  const { user, logout } = useAuth()
  const [title, setTitle] = useState(doc.title)
  const [shared, setShared] = useState(doc.shared)
  const [save, setSave] = useState<SaveState>('saved')
  const [aiOpen, setAiOpen] = useState(doc.canEdit)
  const editorRef = useRef<Editor | null>(null)

  // ── 自动保存：编辑后 1 秒无操作再写入；离开页面前强制写入 ──
  const pending = useRef<{ content?: JSONContent; title?: string }>({})
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined)
  const inflight = useRef<Promise<void>>(Promise.resolve())

  const flush = useCallback(() => {
    clearTimeout(timer.current)
    const patch = pending.current
    if (patch.content === undefined && patch.title === undefined) return inflight.current
    pending.current = {}
    setSave('saving')
    // 串行化：上一次请求未完成时排队，避免旧内容晚于新内容到达而覆盖
    inflight.current = inflight.current
      .then(() => api.saveDoc(doc.id, patch))
      .then(
        () => setSave(Object.keys(pending.current).length ? 'saving' : 'saved'),
        () => {
          // 失败时把内容放回待保存队列，下次编辑或手动重试时再发
          pending.current = { ...patch, ...pending.current }
          setSave('error')
        },
      )
    return inflight.current
  }, [doc.id])

  const schedule = useCallback(() => {
    setSave('saving')
    clearTimeout(timer.current)
    timer.current = setTimeout(() => void flush(), AUTOSAVE_MS)
  }, [flush])

  const onChange = useCallback(
    (content: JSONContent) => {
      pending.current.content = content
      schedule()
    },
    [schedule],
  )

  useEffect(() => {
    const beforeUnload = (e: BeforeUnloadEvent) => {
      if (Object.keys(pending.current).length) {
        void flush()
        e.preventDefault() // 提示用户还有未保存的内容
      }
    }
    window.addEventListener('beforeunload', beforeUnload)
    return () => {
      window.removeEventListener('beforeunload', beforeUnload)
      void flush() // 路由切换离开时也要保存
    }
  }, [flush])

  const onReady = useCallback((e: Editor) => {
    editorRef.current = e
  }, [])
  const onInsertWidget = useCallback((w: { uuid: string; title: string }) => {
    if (editorRef.current) insertWidget(editorRef.current, w)
  }, [])

  async function toggleShare(next: boolean) {
    setShared(next)
    try {
      await api.saveDoc(doc.id, { shared: next })
    } catch {
      setShared(!next)
    }
  }

  const canEdit = doc.canEdit
  return (
    <div className="page">
      <header className="topbar">
        <Link to="/" className="btn small ghost">← 返回</Link>
        <input
          className="title-input"
          value={title}
          readOnly={!canEdit}
          onChange={(e) => {
            setTitle(e.target.value)
            pending.current.title = e.target.value.trim() || '无标题文档'
            schedule()
          }}
          maxLength={100}
          aria-label="文档标题"
        />
        <span className={`save-state ${save}`}>
          {!canEdit ? '只读' : save === 'saved' ? '已保存' : save === 'saving' ? '保存中…' : '保存失败，点击重试'}
        </span>
        {save === 'error' && (
          <button className="btn small" onClick={() => void flush()}>重试</button>
        )}
        <span style={{ flex: 1 }} />
        {canEdit && (
          <label className="share" title="分享后，其他登录用户可以查看文档并与其中的组件交互">
            <input type="checkbox" checked={shared} onChange={(e) => void toggleShare(e.target.checked)} /> 分享
          </label>
        )}
        {canEdit && (
          <button className={`btn small${aiOpen ? ' primary' : ''}`} onClick={() => setAiOpen((v) => !v)}>
            ✨ AI 助手
          </button>
        )}
        <span className="muted">{user.username}</span>
        <button className="btn small ghost" onClick={logout}>退出</button>
      </header>

      <div className="doc-layout">
        <main className="doc-main">
          <div className="doc-paper">
            <DocEditor
              api={api}
              content={doc.content as JSONContent | undefined}
              editable={canEdit}
              onChange={onChange}
              onReady={onReady}
            />
          </div>
        </main>
        {canEdit && aiOpen && (
          <aside className="ai-side">
            <Suspense fallback={<div className="center-fill">加载 AI 助手…</div>}>
              <ChatPanel
                api={api}
                docId={doc.id}
                showSessions={false}
                onInsertWidget={onInsertWidget}
                placeholder="让 AI 写文章，或描述你想要的交互组件（如：做一个待办清单）"
              />
            </Suspense>
          </aside>
        )}
      </div>
    </div>
  )
}
