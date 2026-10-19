import type { ToolRun, WidgetToolResult } from '@doc/shared'
import { WidgetPreview } from './WidgetPreview'
import type { LiveTool } from './live'

type ToolLike = Pick<ToolRun, 'callId' | 'name' | 'args' | 'result' | 'error'> & Partial<Pick<LiveTool, 'stage' | 'done'>>

function parseJSON<T>(s?: string): T | null {
  if (!s) return null
  try {
    return JSON.parse(s) as T
  } catch {
    return null
  }
}

const LABELS: Record<string, string> = {
  create_widget: '生成组件',
  modify_widget: '修改组件',
  load_skill: '加载技能',
  read_document: '读取文档',
}

export function ToolCard({ tool }: { tool: ToolLike }) {
  // 已持久化的历史消息没有 done 字段：有 result 或 error 就算结束
  const done = tool.done ?? (tool.result !== undefined || tool.error !== undefined)
  const label = LABELS[tool.name] ?? tool.name
  const isWidgetTool = tool.name === 'create_widget' || tool.name === 'modify_widget'
  const result = isWidgetTool ? parseJSON<WidgetToolResult>(tool.result) : null

  if (!done) {
    return (
      <div className="tool-chip running">
        <span className="spinner" />
        <span>
          {label}
          {tool.stage ? ` · ${tool.stage}` : '…'}
        </span>
      </div>
    )
  }

  if (isWidgetTool) {
    if (result?.ok && result.widgetId) {
      return <WidgetPreview uuid={result.widgetId} fallbackTitle={result.title} />
    }
    const issues = result?.issues ?? [tool.error ?? '未知错误']
    return (
      <div className="tool-chip failed">
        <div>
          <strong>{label}未成功</strong>
          <ul>
            {issues.map((i, k) => (
              <li key={k}>{i}</li>
            ))}
          </ul>
        </div>
      </div>
    )
  }

  const arg = parseJSON<{ name?: string }>(tool.args)
  return (
    <div className="tool-chip">
      ✓ {label}
      {arg?.name ? `：${arg.name}` : ''}
    </div>
  )
}
