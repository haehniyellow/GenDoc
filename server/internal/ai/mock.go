package ai

import (
	"context"
	"encoding/json"
	"regexp"
	"strings"
	"time"

	"github.com/cloudwego/eino/components/model"
	"github.com/cloudwego/eino/schema"
	"github.com/google/uuid"
)

// MockModel 是一个不联网的假模型：根据系统提示里的角色标记返回“看起来合理”的固定输出，
// 让 Agent → 工具 → 生成 → 审核 → 保存 的整条链路在没有 API key 时也能跑通。
type MockModel struct {
	tools []*schema.ToolInfo
}

var _ model.ToolCallingChatModel = (*MockModel)(nil)

func (m *MockModel) WithTools(tools []*schema.ToolInfo) (model.ToolCallingChatModel, error) {
	c := *m
	c.tools = tools
	return &c, nil
}

// availableTools 合并两种传入方式：WithTools() 方法绑定的，以及 Eino ADK 在每次调用时通过 model.WithTools 选项传入的
func (m *MockModel) availableTools(opts []model.Option) []*schema.ToolInfo {
	return model.GetCommonOptions(&model.Options{Tools: m.tools}, opts...).Tools
}

func hasTool(tools []*schema.ToolInfo, name string) bool {
	for _, t := range tools {
		if t.Name == name {
			return true
		}
	}
	return false
}

func (m *MockModel) Generate(_ context.Context, in []*schema.Message, opts ...model.Option) (*schema.Message, error) {
	return m.respond(in, m.availableTools(opts)), nil
}

func (m *MockModel) Stream(ctx context.Context, in []*schema.Message, opts ...model.Option) (*schema.StreamReader[*schema.Message], error) {
	msg := m.respond(in, m.availableTools(opts))
	sr, sw := schema.Pipe[*schema.Message](8)
	go func() {
		defer sw.Close()
		if len(msg.ToolCalls) > 0 || msg.Content == "" {
			sw.Send(msg, nil)
			return
		}
		// 每 6 个字符一块，间隔 25ms，模拟真实的流式输出，便于观察前端增量渲染与断线续传
		runes := []rune(msg.Content)
		for i := 0; i < len(runes); i += 6 {
			end := min(i+6, len(runes))
			select {
			case <-ctx.Done():
				return
			case <-time.After(25 * time.Millisecond):
			}
			if sw.Send(schema.AssistantMessage(string(runes[i:end]), nil), nil) {
				return
			}
		}
	}()
	return sr, nil
}

var widgetIDInHistory = regexp.MustCompile(`id=([0-9a-fA-F-]{36})`)

func (m *MockModel) respond(in []*schema.Message, tools []*schema.ToolInfo) *schema.Message {
	system, lastUser := "", ""
	var lastRole schema.RoleType
	for _, msg := range in {
		if msg.Role == schema.System && system == "" {
			system = msg.Content
		}
		if msg.Role == schema.User {
			lastUser = msg.Content
		}
	}
	if len(in) > 0 {
		lastRole = in[len(in)-1].Role
	}

	switch {
	case strings.HasPrefix(system, RoleReviewer):
		return schema.AssistantMessage(`{"pass":true,"issues":[]}`, nil)
	case strings.HasPrefix(system, RolePatcher):
		return schema.AssistantMessage(mockPatch(lastUser), nil)
	case strings.HasPrefix(system, RoleGenerator):
		return schema.AssistantMessage("```jsx\n"+mockWidget(lastUser)+"\n```", nil)
	case strings.HasPrefix(system, RoleRewriter):
		return schema.AssistantMessage("（Mock 改写）"+mockOriginalText(lastUser), nil)
	}

	// 主 Agent
	if lastRole == schema.Tool {
		// 技能正文以 Markdown 标题开头：说明刚加载的是写作技能，接下来输出一篇文章（较长，便于观察流式与断线续传）
		if last := in[len(in)-1]; strings.HasPrefix(last.Content, "# ") {
			return schema.AssistantMessage(mockArticle, nil)
		}
		return schema.AssistantMessage("组件已经处理好了，可以在上方卡片里直接试用，满意的话点「插入文档」。", nil)
	}
	wantWidget := containsAny(lastUser, "组件", "计数", "待办", "投票", "随心搭", "widget", "todo", "counter")
	if wantWidget && hasTool(tools, "create_widget") {
		history := ""
		for _, msg := range in {
			history += msg.Content + "\n"
		}
		ids := widgetIDInHistory.FindAllStringSubmatch(history, -1)
		if len(ids) > 0 && containsAny(lastUser, "修改", "改成", "改一下", "调整", "加一个", "换成") && hasTool(tools, "modify_widget") {
			args, _ := json.Marshal(map[string]string{"widgetId": ids[len(ids)-1][1], "instruction": lastUser})
			return toolCall("modify_widget", string(args))
		}
		args, _ := json.Marshal(map[string]string{"requirement": lastUser})
		return toolCall("create_widget", string(args))
	}
	if containsAny(lastUser, "文章", "提纲", "润色", "写一") && hasTool(tools, "load_skill") && !hasToolResult(in) {
		return toolCall("load_skill", `{"name":"article-writer"}`)
	}
	if hasToolResult(in) {
		return schema.AssistantMessage(mockArticle, nil)
	}
	return schema.AssistantMessage("你好！我是 Mock 模型。试试说“帮我做一个计数器组件”或“做一个待办清单”。", nil)
}

const mockArticle = "# Go 并发模型入门\n\n这是 Mock 模型生成的示例文章，配置 OPENAI_API_KEY 后将由真实模型生成。\n\n## 为什么是 goroutine\n\ngoroutine 是由 Go 运行时调度的轻量级线程，创建成本很低，一个程序里可以同时存在成千上万个。\n\n## 用 channel 通信\n\n不要通过共享内存来通信，而要通过通信来共享内存。channel 让多个 goroutine 之间安全地传递数据。\n\n- 无缓冲 channel 用于同步\n- 有缓冲 channel 用于解耦生产者与消费者\n- 关闭 channel 表示不会再有新数据"

func toolCall(name, args string) *schema.Message {
	return schema.AssistantMessage("", []schema.ToolCall{{
		ID: "call_" + strings.ReplaceAll(uuid.NewString(), "-", "")[:16], Type: "function",
		Function: schema.FunctionCall{Name: name, Arguments: args},
	}})
}

func hasToolResult(in []*schema.Message) bool {
	for _, m := range in {
		if m.Role == schema.Tool {
			return true
		}
	}
	return false
}

func containsAny(s string, subs ...string) bool {
	for _, sub := range subs {
		if strings.Contains(s, sub) {
			return true
		}
	}
	return false
}

func mockOriginalText(userMsg string) string {
	if _, after, ok := strings.Cut(userMsg, "原文：\n"); ok {
		return strings.TrimSpace(after)
	}
	return userMsg
}

func mockPatch(userMsg string) string {
	for _, line := range strings.Split(userMsg, "\n") {
		if strings.HasPrefix(strings.TrimSpace(line), "// @title ") {
			l := strings.TrimSpace(line)
			return "<<<<<<< SEARCH\n" + l + "\n=======\n" + l + "（已修改）\n>>>>>>> REPLACE"
		}
	}
	return "无法生成修改块"
}

func mockWidget(requirement string) string {
	switch {
	case containsAny(requirement, "待办", "todo", "清单"):
		return mockTodo
	case containsAny(requirement, "投票", "vote"):
		return mockVote
	default:
		return mockCounter
	}
}

const mockCounter = `// @title 计数器
import { useWidgetState } from '@sdk'

export default function Counter() {
  const [count, setCount, { loading }] = useWidgetState('count', 0)
  const btn = { padding: '8px 16px', borderRadius: 8, border: '1px solid #d0d7de', background: '#fff', cursor: 'pointer', fontSize: 16 }
  return (
    <div style={{ textAlign: 'center', padding: 16 }}>
      <div style={{ fontSize: 48, fontWeight: 700, opacity: loading ? 0.4 : 1 }}>{count}</div>
      <div style={{ display: 'flex', gap: 8, justifyContent: 'center', marginTop: 12 }}>
        <button style={btn} onClick={() => setCount((c) => c - 1)}>-1</button>
        <button style={{ ...btn, background: '#0969da', color: '#fff', borderColor: '#0969da' }} onClick={() => setCount((c) => c + 1)}>+1</button>
        <button style={btn} onClick={() => setCount(0)}>重置</button>
      </div>
      <p style={{ color: '#6e7781', fontSize: 12 }}>数据会自动保存，刷新页面后仍然保留</p>
    </div>
  )
}`

const mockTodo = `// @title 待办清单
import { useState } from 'react'
import { useWidgetState } from '@sdk'

export default function Todo() {
  const [items, setItems] = useWidgetState('items', [])
  const [text, setText] = useState('')
  const add = () => {
    const t = text.trim()
    if (!t) return
    setItems((list) => [...list, { id: Date.now(), text: t, done: false }])
    setText('')
  }
  const toggle = (id) => setItems((list) => list.map((i) => (i.id === id ? { ...i, done: !i.done } : i)))
  const remove = (id) => setItems((list) => list.filter((i) => i.id !== id))
  return (
    <div>
      <div style={{ display: 'flex', gap: 8 }}>
        <input value={text} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && add()}
          placeholder="添加待办，回车确认" style={{ flex: 1, padding: '6px 10px', borderRadius: 6, border: '1px solid #d0d7de' }} />
        <button onClick={add} style={{ padding: '6px 14px', borderRadius: 6, border: 0, background: '#0969da', color: '#fff', cursor: 'pointer' }}>添加</button>
      </div>
      {items.length === 0 && <p style={{ color: '#6e7781' }}>还没有待办事项</p>}
      <ul style={{ listStyle: 'none', padding: 0, margin: '12px 0 0' }}>
        {items.map((i) => (
          <li key={i.id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 0' }}>
            <input type="checkbox" checked={i.done} onChange={() => toggle(i.id)} />
            <span style={{ flex: 1, textDecoration: i.done ? 'line-through' : 'none', opacity: i.done ? 0.5 : 1 }}>{i.text}</span>
            <button onClick={() => remove(i.id)} style={{ border: 0, background: 'transparent', color: '#cf222e', cursor: 'pointer' }}>删除</button>
          </li>
        ))}
      </ul>
    </div>
  )
}`

const mockVote = `// @title 投票
import { useWidgetState } from '@sdk'

const OPTIONS = ['赞成', '反对', '弃权']

export default function Vote() {
  const [votes, setVotes] = useWidgetState('votes', { 赞成: 0, 反对: 0, 弃权: 0 })
  const total = OPTIONS.reduce((s, o) => s + (votes[o] || 0), 0)
  return (
    <div>
      {OPTIONS.map((o) => {
        const n = votes[o] || 0
        const pct = total ? Math.round((n / total) * 100) : 0
        return (
          <div key={o} style={{ margin: '8px 0' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between' }}>
              <button onClick={() => setVotes((v) => ({ ...v, [o]: (v[o] || 0) + 1 }))}
                style={{ padding: '4px 12px', borderRadius: 6, border: '1px solid #d0d7de', background: '#fff', cursor: 'pointer' }}>{o}</button>
              <span>{n} 票（{pct}%）</span>
            </div>
            <div style={{ height: 6, background: '#eaeef2', borderRadius: 3, marginTop: 4 }}>
              <div style={{ width: pct + '%', height: '100%', background: '#0969da', borderRadius: 3 }} />
            </div>
          </div>
        )
      })}
    </div>
  )
}`
