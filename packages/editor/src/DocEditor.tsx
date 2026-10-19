import { useEffect, useState } from 'react'
import { EditorContent, useEditor, type Editor, type JSONContent } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import { Placeholder } from '@tiptap/extensions'
import type { Api } from '@doc/shared'
import { DEFAULT_WIDGET_HEIGHT, WIDGET_NODE_NAME, WidgetNode } from './WidgetNode'
import { RewritePanel } from './RewritePanel'
import './editor.css'

export interface DocEditorProps {
  api: Api
  /** 初始内容（TipTap JSON）。只在挂载时读取；文档切换请用 key 重新挂载 */
  content: JSONContent | undefined
  editable: boolean
  onChange?: (json: JSONContent) => void
  onReady?: (editor: Editor) => void
}

/** 把一个已生成的组件插入到当前光标位置 */
export function insertWidget(editor: Editor, w: { uuid: string; title: string }): void {
  editor
    .chain()
    .focus()
    .insertContent({ type: WIDGET_NODE_NAME, attrs: { uuid: w.uuid, title: w.title, height: DEFAULT_WIDGET_HEIGHT, width: null } })
    .run()
}

export function DocEditor({ api, content, editable, onChange, onReady }: DocEditorProps) {
  const [rewriteOpen, setRewriteOpen] = useState(false)

  const editor = useEditor({
    extensions: [
      StarterKit,
      Placeholder.configure({ placeholder: '开始写作，或在右侧让 AI 帮你生成文章与交互组件…' }),
      WidgetNode.configure({ api }),
    ],
    content,
    editable,
    immediatelyRender: false,
    // 工具栏的激活态（加粗/标题等）依赖每次事务后重新渲染
    shouldRerenderOnTransaction: true,
    onUpdate: ({ editor }) => onChange?.(editor.getJSON()),
  })

  useEffect(() => {
    if (editor) onReady?.(editor)
  }, [editor, onReady])

  useEffect(() => {
    editor?.setEditable(editable)
  }, [editor, editable])

  if (!editor) return null

  const btn = (label: string, title: string, active: boolean, run: () => void) => (
    <button
      type="button"
      className={`tb${active ? ' on' : ''}`}
      title={title}
      // mousedown 里阻止默认行为，避免点击工具栏时编辑器失焦、选区丢失
      onMouseDown={(e) => e.preventDefault()}
      onClick={run}
    >
      {label}
    </button>
  )
  const c = () => editor.chain().focus()

  return (
    <div className="doc-editor">
      {editable && (
        <div className="doc-toolbar">
          {btn('B', '加粗', editor.isActive('bold'), () => c().toggleBold().run())}
          {btn('I', '斜体', editor.isActive('italic'), () => c().toggleItalic().run())}
          {btn('S', '删除线', editor.isActive('strike'), () => c().toggleStrike().run())}
          <span className="sep" />
          {btn('H1', '一级标题', editor.isActive('heading', { level: 1 }), () => c().toggleHeading({ level: 1 }).run())}
          {btn('H2', '二级标题', editor.isActive('heading', { level: 2 }), () => c().toggleHeading({ level: 2 }).run())}
          {btn('H3', '三级标题', editor.isActive('heading', { level: 3 }), () => c().toggleHeading({ level: 3 }).run())}
          <span className="sep" />
          {btn('•', '无序列表', editor.isActive('bulletList'), () => c().toggleBulletList().run())}
          {btn('1.', '有序列表', editor.isActive('orderedList'), () => c().toggleOrderedList().run())}
          {btn('❝', '引用', editor.isActive('blockquote'), () => c().toggleBlockquote().run())}
          {btn('</>', '代码块', editor.isActive('codeBlock'), () => c().toggleCodeBlock().run())}
          <span className="sep" />
          <button
            type="button"
            className="tb wide"
            title="选中文字后让 AI 改写"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => setRewriteOpen(true)}
          >
            ✨ AI 改写
          </button>
        </div>
      )}
      {rewriteOpen && <RewritePanel editor={editor} api={api} onClose={() => setRewriteOpen(false)} />}
      <EditorContent editor={editor} className="doc-content" />
    </div>
  )
}
