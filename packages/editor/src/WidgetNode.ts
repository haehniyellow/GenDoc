import { Node, ReactNodeViewRenderer, mergeAttributes } from '@tiptap/react'
import { DEFAULT_WIDGET_HEIGHT, WIDGET_NODE_NAME, type Api } from '@doc/shared'
import { WidgetNodeView } from './WidgetNodeView'

export interface WidgetNodeOptions {
  api: Api
}

export { DEFAULT_WIDGET_HEIGHT, WIDGET_NODE_NAME }

/**
 * 「随心搭」组件节点。
 *
 * 文档 JSON 里只保存引用与展示尺寸，不保存组件代码：
 *   { "type": "widget", "attrs": { "uuid": "…", "title": "…", "height": 280, "width": null } }
 * 代码与数据都在服务端按 uuid 存取，所以 AI 修改组件后，文档里所有引用它的地方都会自动更新；
 * 服务端保存文档时也从这个结构里推导“文档引用了哪些组件”，用于权限判断（server/internal/ai/docjson.go）。
 * 节点名与属性名需与服务端保持一致。
 */
export const WidgetNode = Node.create<WidgetNodeOptions>({
  name: WIDGET_NODE_NAME,
  group: 'block',
  atom: true, // 叶子节点，光标不会进入内部
  selectable: true,
  draggable: true,

  addOptions() {
    return { api: undefined as unknown as Api }
  },

  addAttributes() {
    return {
      uuid: {
        default: null,
        parseHTML: (el) => el.getAttribute('data-uuid'),
        renderHTML: (attrs) => ({ 'data-uuid': attrs.uuid as string }),
      },
      title: {
        default: '',
        parseHTML: (el) => el.getAttribute('data-title') ?? '',
        renderHTML: (attrs) => ({ 'data-title': attrs.title as string }),
      },
      height: {
        default: DEFAULT_WIDGET_HEIGHT,
        parseHTML: (el) => Number(el.getAttribute('data-height')) || DEFAULT_WIDGET_HEIGHT,
        renderHTML: (attrs) => ({ 'data-height': String(attrs.height) }),
      },
      /** px 宽度；null 表示占满容器 */
      width: {
        default: null,
        parseHTML: (el) => {
          const w = Number(el.getAttribute('data-width'))
          return w > 0 ? w : null
        },
        renderHTML: (attrs) => (attrs.width ? { 'data-width': String(attrs.width) } : {}),
      },
    }
  },

  parseHTML() {
    return [{ tag: 'div[data-widget]' }]
  },

  renderHTML({ HTMLAttributes }) {
    return ['div', mergeAttributes({ 'data-widget': '' }, HTMLAttributes)]
  },

  addNodeView() {
    return ReactNodeViewRenderer(WidgetNodeView)
  },
})
