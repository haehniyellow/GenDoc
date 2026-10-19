package ai

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"strings"

	"github.com/cloudwego/eino/adk"
	"github.com/cloudwego/eino/components/model"
	"github.com/cloudwego/eino/compose"
	"github.com/cloudwego/eino/schema"

	"doc-platform/server/internal/store"
)

// ToolRun 记录一次工具调用，随助手消息持久化到 messages.meta，并原样返回给前端展示。
type ToolRun struct {
	CallID string `json:"callId"`
	Name   string `json:"name"`
	Args   string `json:"args"`
	Result string `json:"result,omitempty"`
	Error  string `json:"error,omitempty"`
}

type MessageMeta struct {
	Tools  []ToolRun `json:"tools,omitempty"`
	Status string    `json:"status,omitempty"` // done | error | cancelled
	Error  string    `json:"error,omitempty"`
}

// Turn 是一次 Agent 运行的产物（即使中途出错或被取消，也会带回已经产生的部分）
type Turn struct {
	Text  string
	Tools []ToolRun
}

type Agent struct {
	model   model.ToolCallingChatModel
	runner  *adk.Runner
	widgets *WidgetService
}

func NewAgent(ctx context.Context, m model.ToolCallingChatModel, st *store.Store) (*Agent, error) {
	skills, err := LoadSkills()
	if err != nil {
		return nil, fmt.Errorf("加载技能失败: %w", err)
	}
	widgets := NewWidgetService(m, st)
	tools, err := buildTools(widgets, st, skills)
	if err != nil {
		return nil, fmt.Errorf("创建工具失败: %w", err)
	}
	chat, err := adk.NewChatModelAgent(ctx, &adk.ChatModelAgentConfig{
		Name:        "assistant",
		Description: "知识管理与写作助手，可生成文章并创建、修改可嵌入文档的交互组件",
		Instruction: fmt.Sprintf(AgentSystemTmpl, skillIndex(skills)),
		Model:       m,
		ToolsConfig: adk.ToolsConfig{ToolsNodeConfig: compose.ToolsNodeConfig{Tools: tools}},
		// 一轮对话里的工具调用不会很深：加载技能 → 创建/修改组件 → 总结
		MaxIterations: 8,
	})
	if err != nil {
		return nil, fmt.Errorf("创建 Agent 失败: %w", err)
	}
	return &Agent{model: m, runner: adk.NewRunner(ctx, adk.RunnerConfig{Agent: chat, EnableStreaming: true}), widgets: widgets}, nil
}

// Run 执行一轮对话，并把 ADK 的事件流翻译成前端协议里的 SSE 事件写入 rc.Run。
// history 已包含最新一条用户消息。
func (a *Agent) Run(ctx context.Context, rc *RunCtx, history []*schema.Message) (Turn, error) {
	ctx = WithRunCtx(ctx, rc)
	var turn Turn
	var text strings.Builder
	toolIdx := map[string]int{} // callID → turn.Tools 下标

	iter := a.runner.Run(ctx, history)
	for {
		ev, ok := iter.Next()
		if !ok {
			break
		}
		if ev.Err != nil {
			turn.Text = text.String()
			return turn, ev.Err
		}
		if ev.Output == nil || ev.Output.MessageOutput == nil {
			continue
		}
		mo := ev.Output.MessageOutput

		var msg *schema.Message
		if mo.IsStreaming {
			var chunks []*schema.Message
			for {
				chunk, err := mo.MessageStream.Recv()
				if errors.Is(err, io.EOF) {
					break
				}
				if err != nil {
					turn.Text = text.String()
					return turn, err
				}
				chunks = append(chunks, chunk)
				if isAssistant(mo.Role, chunk) && chunk.Content != "" {
					text.WriteString(chunk.Content)
					rc.Run.Emit("text.delta", map[string]any{"text": chunk.Content})
				}
			}
			if len(chunks) == 0 {
				continue
			}
			merged, err := schema.ConcatMessages(chunks)
			if err != nil {
				turn.Text = text.String()
				return turn, err
			}
			msg = merged
		} else {
			msg = mo.Message
			if msg == nil {
				continue
			}
			if isAssistant(mo.Role, msg) && msg.Content != "" {
				text.WriteString(msg.Content)
				rc.Run.Emit("text.delta", map[string]any{"text": msg.Content})
			}
		}

		switch {
		case isAssistant(mo.Role, msg):
			for _, tc := range msg.ToolCalls {
				toolIdx[tc.ID] = len(turn.Tools)
				turn.Tools = append(turn.Tools, ToolRun{CallID: tc.ID, Name: tc.Function.Name, Args: tc.Function.Arguments})
				rc.Run.Emit("tool.start", map[string]any{"callId": tc.ID, "name": tc.Function.Name, "args": tc.Function.Arguments})
			}
		case mo.Role == schema.Tool || msg.Role == schema.Tool:
			name := mo.ToolName
			if name == "" {
				name = msg.ToolName
			}
			if i, ok := toolIdx[msg.ToolCallID]; ok {
				turn.Tools[i].Result = msg.Content
			}
			rc.Run.Emit("tool.end", map[string]any{"callId": msg.ToolCallID, "name": name, "result": msg.Content})
		}
	}
	turn.Text = text.String()
	return turn, nil
}

func isAssistant(role schema.RoleType, m *schema.Message) bool {
	return role == schema.Assistant || (role == "" && m != nil && m.Role == schema.Assistant)
}

// BuildHistory 把数据库里的消息还原成模型输入。
// 工具调用细节不回放（避免残缺的 tool_calls 序列被模型接口拒绝），但会把创建/修改过的组件以
// “[组件 id=… 标题=…]” 的形式附在助手消息末尾，让模型后续能通过 modify_widget 引用它们。
func BuildHistory(msgs []store.Message) []*schema.Message {
	out := make([]*schema.Message, 0, len(msgs))
	for _, m := range msgs {
		if m.Role == "user" {
			out = append(out, schema.UserMessage(m.Content))
			continue
		}
		content := m.Content
		var meta MessageMeta
		if m.Meta != "" && json.Unmarshal([]byte(m.Meta), &meta) == nil {
			for _, t := range meta.Tools {
				if t.Name != "create_widget" && t.Name != "modify_widget" {
					continue
				}
				var res WidgetResult
				if json.Unmarshal([]byte(t.Result), &res) == nil && res.OK {
					content += fmt.Sprintf("\n[组件 id=%s 标题=%s]", res.WidgetID, res.Title)
				}
			}
		}
		if strings.TrimSpace(content) == "" {
			continue
		}
		out = append(out, schema.AssistantMessage(content, nil))
	}
	return out
}

// Rewrite 对选中文字做一次性流式改写，逐块回调
func (a *Agent) Rewrite(ctx context.Context, text, instruction string, onDelta func(string)) error {
	sr, err := a.model.Stream(ctx, []*schema.Message{
		schema.SystemMessage(RewriterSystem),
		schema.UserMessage("改写要求：" + instruction + "\n\n原文：\n" + text),
	})
	if err != nil {
		return err
	}
	defer sr.Close()
	for {
		chunk, err := sr.Recv()
		if errors.Is(err, io.EOF) {
			return nil
		}
		if err != nil {
			return err
		}
		if chunk.Content != "" {
			onDelta(chunk.Content)
		}
	}
}
