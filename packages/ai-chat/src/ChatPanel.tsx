import { Suspense, lazy, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import type { Api, ChatMessage } from '@doc/shared'
import { ChatContext, useChat, useChatContext } from './ChatContext'
import { ToolCard } from './ToolCard'
import { createChatStore } from './store'
import './chat.css'

const Markdown = lazy(() => import('./Markdown'))

function Text({ text }: { text: string }) {
  if (!text) return null
  return (
    <Suspense fallback={<div className="md plain">{text}</div>}>
      <Markdown text={text} />
    </Suspense>
  )
}

export interface ChatPanelProps {
  api: Api
  /** 文档页面侧边栏使用：让 Agent 能读取当前文档 */
  docId?: string
  showSessions?: boolean
  onInsertWidget?: (w: { uuid: string; title: string }) => void
  placeholder?: string
}

export function ChatPanel({ api, docId, showSessions = true, onInsertWidget, placeholder }: ChatPanelProps) {
  const store = useMemo(() => createChatStore(api), [api])
  const ctx = useMemo(() => ({ api, store, onInsertWidget }), [api, store, onInsertWidget])

  useEffect(() => {
    void store.getState().init()
    // 卸载时中止事件流订阅；服务端任务不受影响，下次进入会话会自动接上
    return () => store.getState().dispose()
  }, [store])

  return (
    <ChatContext.Provider value={ctx}>
      <div className="chat">
        {showSessions && <SessionList />}
        <section className="chat-main">
          <MessageList />
          <ErrorBar />
          <Composer docId={docId} placeholder={placeholder} />
        </section>
      </div>
    </ChatContext.Provider>
  )
}

function SessionList() {
  const sessions = useChat((s) => s.sessions)
  const currentId = useChat((s) => s.currentId)
  const { store } = useChatContext()
  const { newSession, selectSession, deleteSession } = store.getState()
  return (
    <aside className="chat-sessions">
      <button className="btn primary" onClick={() => void newSession()}>
        ＋ 新对话
      </button>
      <ul>
        {sessions.map((s) => (
          <li key={s.id} className={s.id === currentId ? 'active' : ''}>
            <button className="session-title" onClick={() => void selectSession(s.id)} title={s.title}>
              {s.title}
            </button>
            <button
              className="btn ghost small danger"
              aria-label="删除会话"
              onClick={() => {
                if (confirm(`删除会话「${s.title}」？`)) void deleteSession(s.id)
              }}
            >
              ✕
            </button>
          </li>
        ))}
        {sessions.length === 0 && <li className="muted empty">还没有对话</li>}
      </ul>
    </aside>
  )
}

function MessageList() {
  const messages = useChat((s) => s.messages)
  const live = useChat((s) => s.live)
  const loading = useChat((s) => s.loading)
  const ref = useRef<HTMLDivElement>(null)
  const stick = useRef(true)

  // 只有用户本来就停在底部附近时才自动跟随，避免打断向上翻阅历史
  useLayoutEffect(() => {
    const el = ref.current
    if (el && stick.current) el.scrollTop = el.scrollHeight
  })

  return (
    <div
      className="chat-scroll"
      ref={ref}
      onScroll={(e) => {
        const el = e.currentTarget
        stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80
      }}
    >
      {loading && <div className="muted center">加载中…</div>}
      {!loading && messages.length === 0 && !live && (
        <div className="empty-hint">
          <p>
            试试说：<code>做一个待办清单组件</code>
          </p>
          <p className="muted">或者：写一篇关于 Go 并发模型的入门文章</p>
        </div>
      )}
      {messages.map((m) => (
        <MessageView key={m.id} m={m} />
      ))}
      {live && <LiveMessage />}
    </div>
  )
}

function MessageView({ m }: { m: ChatMessage }) {
  if (m.role === 'user') {
    return (
      <div className="msg user">
        <div className="bubble">{m.content}</div>
      </div>
    )
  }
  return (
    <div className="msg assistant">
      {m.meta?.tools?.map((t) => <ToolCard key={t.callId} tool={t} />)}
      <Text text={m.content} />
      {m.meta?.status === 'cancelled' && <div className="muted">（已停止生成）</div>}
      {m.meta?.status === 'error' && <div className="error-text">生成失败：{m.meta.error}</div>}
    </div>
  )
}

function LiveMessage() {
  const live = useChat((s) => s.live)!
  const { store } = useChatContext()
  return (
    <div className="msg assistant">
      {live.tools.map((t) => (
        <ToolCard key={t.callId} tool={t} />
      ))}
      <Text text={live.text} />
      {live.status === 'reconnecting' && <div className="conn-note">连接中断，正在重连…</div>}
      {live.status === 'failed' && (
        <div className="conn-note failed">
          连接已断开，任务可能仍在后台运行。
          <button className="btn small" onClick={() => store.getState().resume()}>
            重新连接
          </button>
        </div>
      )}
      {live.error && <div className="error-text">生成失败：{live.error}</div>}
      {!live.text && live.tools.length === 0 && live.status !== 'failed' && (
        <div className="tool-chip running">
          <span className="spinner" />
          思考中…
        </div>
      )}
    </div>
  )
}

function ErrorBar() {
  const error = useChat((s) => s.error)
  const { store } = useChatContext()
  if (!error) return null
  return (
    <div className="chat-error">
      <span>{error}</span>
      <button className="btn ghost small" onClick={() => store.getState().dismissError()}>
        ✕
      </button>
    </div>
  )
}

function Composer({ docId, placeholder }: { docId?: string; placeholder?: string }) {
  const [text, setText] = useState('')
  const busy = useChat((s) => s.live !== null)
  const { store } = useChatContext()

  function submit() {
    const t = text.trim()
    if (!t || busy) return
    setText('')
    void store.getState().send(t, { docId })
  }
  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    // isComposing：中文输入法选词时的回车不应发送
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault()
      submit()
    }
  }

  return (
    <div className="composer">
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={onKeyDown}
        rows={2}
        placeholder={placeholder ?? '描述你想要的文章或组件，Enter 发送，Shift+Enter 换行'}
      />
      {busy ? (
        <button className="btn" onClick={() => void store.getState().stop()}>
          停止
        </button>
      ) : (
        <button className="btn primary" disabled={!text.trim()} onClick={submit}>
          发送
        </button>
      )}
    </div>
  )
}
