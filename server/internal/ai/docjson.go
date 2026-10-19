package ai

import (
	"encoding/json"
	"strings"
)

// TipTap / ProseMirror 文档 JSON 的轻量遍历：只关心纯文本与 widget 节点，不依赖前端 schema。

type docNode struct {
	Type    string         `json:"type"`
	Text    string         `json:"text"`
	Attrs   map[string]any `json:"attrs"`
	Content []docNode      `json:"content"`
}

const WidgetNodeType = "widget"

func parseDoc(raw string) (docNode, error) {
	var n docNode
	err := json.Unmarshal([]byte(raw), &n)
	return n, err
}

// ExtractWidgetIDs 收集文档里所有 widget 节点的 uuid（去重，保持出现顺序）
func ExtractWidgetIDs(raw string) []string {
	root, err := parseDoc(raw)
	if err != nil {
		return nil
	}
	seen := map[string]bool{}
	var ids []string
	var walk func(n docNode)
	walk = func(n docNode) {
		if n.Type == WidgetNodeType {
			if id, _ := n.Attrs["uuid"].(string); id != "" && !seen[id] {
				seen[id] = true
				ids = append(ids, id)
			}
		}
		for _, c := range n.Content {
			walk(c)
		}
	}
	walk(root)
	return ids
}

// ExtractText 把文档转成给模型阅读的 Markdown 风格纯文本
func ExtractText(raw string) string {
	root, err := parseDoc(raw)
	if err != nil {
		return ""
	}
	var b strings.Builder
	var walk func(n docNode)
	walk = func(n docNode) {
		switch n.Type {
		case "text":
			b.WriteString(n.Text)
			return
		case "hardBreak":
			b.WriteString("\n")
			return
		case WidgetNodeType:
			title, _ := n.Attrs["title"].(string)
			id, _ := n.Attrs["uuid"].(string)
			b.WriteString("[组件 id=" + id + " 标题=" + title + "]\n\n")
			return
		case "heading":
			level := 1
			if f, ok := n.Attrs["level"].(float64); ok {
				level = int(f)
			}
			b.WriteString(strings.Repeat("#", level) + " ")
		case "listItem":
			b.WriteString("- ")
		case "blockquote":
			b.WriteString("> ")
		case "codeBlock":
			b.WriteString("```\n")
		}
		for _, c := range n.Content {
			walk(c)
		}
		switch n.Type {
		case "codeBlock":
			b.WriteString("\n```\n\n")
		case "paragraph", "heading":
			b.WriteString("\n\n")
		case "listItem":
			// 列表项内的段落已经输出了空行，这里不再追加
		}
	}
	walk(root)
	return strings.TrimSpace(b.String())
}
