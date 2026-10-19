package ai

import (
	"context"
	"fmt"
	"strings"
	"unicode/utf8"

	"github.com/cloudwego/eino/components/tool"
	"github.com/cloudwego/eino/components/tool/utils"
	"github.com/cloudwego/eino/compose"

	"doc-platform/server/internal/store"
)

type createWidgetArgs struct {
	Requirement string `json:"requirement" jsonschema:"description=对组件功能的完整描述。包含用户提到的所有细节：需要哪些交互、展示什么、数据要不要保存"`
}

type modifyWidgetArgs struct {
	WidgetID    string `json:"widgetId" jsonschema:"description=要修改的组件 id，取自对话历史中的 [组件 id=…] 记录"`
	Instruction string `json:"instruction" jsonschema:"description=具体的修改要求，只描述要变化的部分"`
}

type loadSkillArgs struct {
	Name string `json:"name" jsonschema:"description=技能名称，必须是系统提示里列出的名称之一"`
}

type noArgs struct{}

type docContent struct {
	OK      bool   `json:"ok"`
	Title   string `json:"title,omitempty"`
	Content string `json:"content,omitempty"`
	Error   string `json:"error,omitempty"`
}

const maxToolText = 4000

// 基础设施类错误（数据库、模型超时等）不作为工具的 error 返回，否则会让整个 ReAct 循环中断；
// 而是包装成 ok=false 的结果交给模型，让它如实告诉用户。
func infraFailure(ctx context.Context, err error) (*WidgetResult, error) {
	if ctx.Err() != nil {
		return nil, ctx.Err() // 用户主动取消，向上传递以终止任务
	}
	return &WidgetResult{OK: false, Issues: []string{err.Error()}}, nil
}

func buildTools(widgets *WidgetService, st *store.Store, skills []Skill) ([]tool.BaseTool, error) {
	create, err := utils.InferTool("create_widget",
		"根据自然语言需求生成一个可以嵌入文档的交互式组件（具备状态、交互与数据持久化）。内部会自动完成代码生成、安全检查与独立审核，耗时约十几秒。成功时返回 widgetId。",
		func(ctx context.Context, in createWidgetArgs) (*WidgetResult, error) {
			rc := RunCtxFrom(ctx)
			req := strings.TrimSpace(in.Requirement)
			if rc == nil || req == "" {
				return &WidgetResult{OK: false, Issues: []string{"需求描述不能为空"}}, nil
			}
			if utf8.RuneCountInString(req) > maxToolText {
				return &WidgetResult{OK: false, Issues: []string{"需求描述过长"}}, nil
			}
			res, err := widgets.Create(ctx, rc.UserID, compose.GetToolCallID(ctx), req)
			if err != nil {
				return infraFailure(ctx, err)
			}
			return res, nil
		})
	if err != nil {
		return nil, err
	}

	modify, err := utils.InferTool("modify_widget",
		"对已有组件做局部修改。修改后会重新做安全检查与审核，成功时组件版本号加一。",
		func(ctx context.Context, in modifyWidgetArgs) (*WidgetResult, error) {
			rc := RunCtxFrom(ctx)
			ins := strings.TrimSpace(in.Instruction)
			if rc == nil || in.WidgetID == "" || ins == "" {
				return &WidgetResult{OK: false, Issues: []string{"widgetId 与 instruction 都不能为空"}}, nil
			}
			if utf8.RuneCountInString(ins) > maxToolText {
				return &WidgetResult{OK: false, Issues: []string{"修改说明过长"}}, nil
			}
			res, err := widgets.Modify(ctx, rc.UserID, compose.GetToolCallID(ctx), in.WidgetID, ins)
			if err != nil {
				return infraFailure(ctx, err)
			}
			return res, nil
		})
	if err != nil {
		return nil, err
	}

	byName := map[string]Skill{}
	for _, s := range skills {
		byName[s.Name] = s
	}
	loadSkill, err := utils.InferTool("load_skill",
		"加载一个写作技能的详细指引。写作或修改文章前先调用。",
		func(_ context.Context, in loadSkillArgs) (string, error) {
			if s, ok := byName[in.Name]; ok {
				return s.Body, nil
			}
			names := make([]string, 0, len(byName))
			for n := range byName {
				names = append(names, n)
			}
			return fmt.Sprintf("没有名为 %q 的技能，可用技能：%s", in.Name, strings.Join(names, "、")), nil
		})
	if err != nil {
		return nil, err
	}

	readDoc, err := utils.InferTool("read_document",
		"读取用户当前正在编辑的文档全文（Markdown 风格纯文本；文档里嵌入的组件显示为 [组件 id=… 标题=…]）。",
		func(ctx context.Context, _ noArgs) (*docContent, error) {
			rc := RunCtxFrom(ctx)
			if rc == nil || rc.DocID == "" {
				return &docContent{Error: "当前对话没有关联文档"}, nil
			}
			d, err := st.GetDoc(rc.DocID)
			if err != nil || (d.OwnerID != rc.UserID && !d.Shared) {
				return &docContent{Error: "文档不存在或无权访问"}, nil
			}
			text := ExtractText(d.Content)
			if utf8.RuneCountInString(text) > 20000 {
				text = string([]rune(text)[:20000]) + "\n…（内容过长，已截断）"
			}
			return &docContent{OK: true, Title: d.Title, Content: text}, nil
		})
	if err != nil {
		return nil, err
	}

	return []tool.BaseTool{create, modify, loadSkill, readDoc}, nil
}
