import { useEffect, useRef, useState } from 'react'
import type { Editor } from '@tiptap/react'
import type { Api } from '@doc/shared'

const QUICK = ['更简洁', '更正式', '润色语句', '扩写细节', '翻译成英文']

interface Target {
  from: number
  to: number
  text: string
}

/**
 * 选中文字 → AI 改写 → 预览 → 采纳/放弃。
 * 改写结果只存在于这个面板里，采纳之前不会动文档，所以随时可以放弃或重新生成。
 */
export function RewritePanel({ editor, api, onClose }: { editor: Editor; api: Api; onClose: () => void }) {
  // 打开面板时锁定选区。之后用户点输入框会让编辑器失焦，但不能因此丢失要改写的范围
  const [target] = useState<Target | null>(() => {
    const { from, to, empty } = editor.state.selection
    return empty ? null : { from, to, text: editor.state.doc.textBetween(from, to, '\n') }
  })
  const [instruction, setInstruction] = useState('')
  const [result, setResult] = useState('')
  const [status, setStatus] = useState<'idle' | 'streaming' | 'done' | 'error'>('idle')
  const [error, setError] = useState('')
  const ctrl = useRef<AbortController | null>(null)

  useEffect(() => () => ctrl.current?.abort(), [])

  async function run(ins: string) {
    if (!target || !ins.trim()) return
    ctrl.current?.abort()
    const c = new AbortController()
    ctrl.current = c
    setResult('')
    setError('')
    setStatus('streaming')
    try {
      await api.rewrite({ text: target.text, instruction: ins.trim() }, (d) => setResult((r) => r + d), c.signal)
      if (!c.signal.aborted) setStatus('done')
    } catch (e) {
      if (c.signal.aborted) return
      setStatus('error')
      setError(e instanceof Error ? e.message : '改写失败')
    }
  }

  function apply() {
    if (!target || !result.trim()) return
    // 流式期间文档可能被改动，位置已经不可信：内容对不上就拒绝，避免改错地方
    const current = editor.state.doc.textBetween(target.from, Math.min(target.to, editor.state.doc.content.size), '\n')
    if (current !== target.text) {
      setStatus('error')
      setError('选中的内容已经发生变化，请重新选择后再改写')
      return
    }
    const paragraphs = result.trim().split(/\n{2,}/)
    const content =
      paragraphs.length > 1 || result.includes('\n')
        ? paragraphs.map((p) => ({ type: 'paragraph', content: [{ type: 'text', text: p.replace(/\n/g, ' ') }] }))
        : result.trim()
    editor.chain().focus().insertContentAt({ from: target.from, to: target.to }, content).run()
    onClose()
  }

  if (!target) {
    return (
      <div className="rewrite-panel">
        <div className="rewrite-head">
          <strong>AI 改写</strong>
          <button className="btn ghost small" onClick={onClose}>✕</button>
        </div>
        <p className="muted">请先在文档中选中要改写的文字。</p>
      </div>
    )
  }

  return (
    <div className="rewrite-panel">
      <div className="rewrite-head">
        <strong>AI 改写</strong>
        <button className="btn ghost small" onClick={onClose} aria-label="关闭">✕</button>
      </div>
      <div className="rewrite-quote">{target.text}</div>
      <div className="rewrite-quick">
        {QUICK.map((q) => (
          <button key={q} className="btn small" disabled={status === 'streaming'} onClick={() => { setInstruction(q); void run(q) }}>
            {q}
          </button>
        ))}
      </div>
      <form
        className="rewrite-form"
        onSubmit={(e) => {
          e.preventDefault()
          void run(instruction)
        }}
      >
        <input
          className="input"
          value={instruction}
          onChange={(e) => setInstruction(e.target.value)}
          placeholder="或者描述你想怎么改，例如：改成更口语化的语气"
          maxLength={500}
        />
        <button className="btn primary" disabled={status === 'streaming' || !instruction.trim()}>
          {status === 'idle' ? '改写' : '重新生成'}
        </button>
      </form>

      {(result || status === 'streaming') && (
        <div className="rewrite-result">
          <div className="muted" style={{ fontSize: 12 }}>
            改写预览{status === 'streaming' && '（生成中…）'}
          </div>
          <div className="rewrite-preview">{result || '…'}</div>
          <div className="rewrite-actions">
            <button className="btn primary" disabled={status !== 'done'} onClick={apply}>
              替换选中内容
            </button>
            <button className="btn" onClick={onClose}>放弃</button>
          </div>
        </div>
      )}
      {error && <div className="error-text">{error}</div>}
    </div>
  )
}
