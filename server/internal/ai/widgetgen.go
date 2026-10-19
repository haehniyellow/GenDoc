package ai

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/cloudwego/eino/components/model"
	"github.com/cloudwego/eino/schema"

	"doc-platform/server/internal/store"
)

// maxAttempts 是“生成 → 校验 → 审核”的最大轮数（首轮 + 2 次带反馈的重试）
const maxAttempts = 3

const modelCallTimeout = 3 * time.Minute

// WidgetResult 是 create_widget / modify_widget 工具返回给 Agent（以及前端）的结果，
// 对应前端 protocol.ts 里的 WidgetToolResult。
type WidgetResult struct {
	OK       bool     `json:"ok"`
	WidgetID string   `json:"widgetId,omitempty"`
	Title    string   `json:"title,omitempty"`
	Version  int      `json:"version,omitempty"`
	Issues   []string `json:"issues,omitempty"`
}

type WidgetService struct {
	model model.BaseChatModel
	store *store.Store
}

func NewWidgetService(m model.BaseChatModel, s *store.Store) *WidgetService {
	return &WidgetService{model: m, store: s}
}

// ───────────────────────── 对外入口 ─────────────────────────

func (w *WidgetService) Create(ctx context.Context, userID, callID, requirement string) (*WidgetResult, error) {
	produce := func(attempt int, prev string, feedback []string) (string, error) {
		user := "需求：\n" + requirement
		if attempt > 0 {
			user += retryPrompt(prev, feedback)
		}
		return w.generate(ctx, GeneratorSystem, user)
	}
	code, issues, ok, err := w.refine(ctx, callID, requirement, produce)
	if err != nil {
		return nil, err
	}
	if !ok {
		return &WidgetResult{OK: false, Issues: issues}, nil
	}
	title := extractTitle(code, requirement)
	rec, err := w.store.CreateWidget(userID, title, code)
	if err != nil {
		return nil, fmt.Errorf("保存组件失败: %w", err)
	}
	return &WidgetResult{OK: true, WidgetID: rec.UUID, Title: rec.Title, Version: rec.Version, Issues: issues}, nil
}

func (w *WidgetService) Modify(ctx context.Context, userID, callID, widgetID, instruction string) (*WidgetResult, error) {
	rec, err := w.store.GetWidget(widgetID)
	if errors.Is(err, store.ErrNotFound) {
		return &WidgetResult{OK: false, Issues: []string{"找不到该组件：" + widgetID}}, nil
	}
	if err != nil {
		return nil, err
	}
	if rec.OwnerID != userID {
		return &WidgetResult{OK: false, Issues: []string{"无权修改该组件"}}, nil
	}

	produce := func(attempt int, prev string, feedback []string) (string, error) {
		if attempt == 0 {
			// 首轮走局部修改：SEARCH/REPLACE 块精确应用
			patch, err := w.callModel(ctx, PatcherSystem, patchUserPrompt(rec.Code, instruction))
			if err != nil {
				return "", err
			}
			if patched, perr := ApplyPatch(rec.Code, patch); perr == nil {
				return patched, nil
			} else {
				Stage(ctx, callID, "patch-fallback", "局部修改未能精确应用（"+perr.Error()+"），改为整段重写")
			}
			return w.generate(ctx, PatcherFullSystem, patchUserPrompt(rec.Code, instruction))
		}
		// 之后的重试：在上一版候选代码基础上，带着审核意见整段重写
		return w.generate(ctx, PatcherFullSystem, patchUserPrompt(rec.Code, instruction)+retryPrompt(prev, feedback))
	}
	requirement := fmt.Sprintf("对已有组件「%s」做如下修改（其余功能应保持不变）：%s", rec.Title, instruction)
	code, issues, ok, err := w.refine(ctx, callID, requirement, produce)
	if err != nil {
		return nil, err
	}
	if !ok {
		return &WidgetResult{OK: false, WidgetID: widgetID, Issues: issues}, nil
	}
	updated, err := w.store.UpdateWidgetCode(widgetID, userID, extractTitle(code, rec.Title), code)
	if err != nil {
		return nil, fmt.Errorf("保存组件失败: %w", err)
	}
	return &WidgetResult{OK: true, WidgetID: updated.UUID, Title: updated.Title, Version: updated.Version, Issues: issues}, nil
}

// ───────────────────────── 生成 → 校验 → 审核 循环 ─────────────────────────

type producer func(attempt int, prevCode string, feedback []string) (string, error)

// refine 反复调用 produce 直到代码通过“静态快筛 + 独立审核 Agent”，或用尽重试次数。
// 返回值 issues：通过时是审核给出的低级别建议，未通过时是最后一轮的问题清单。
func (w *WidgetService) refine(ctx context.Context, callID, requirement string, produce producer) (code string, issues []string, ok bool, err error) {
	var feedback []string
	for attempt := 0; attempt < maxAttempts; attempt++ {
		if attempt == 0 {
			Stage(ctx, callID, "generate", "正在生成代码")
		} else {
			Stage(ctx, callID, "retry", fmt.Sprintf("未通过检查，正在按反馈重新生成（第 %d 次重试）", attempt))
		}
		next, perr := produce(attempt, code, feedback)
		if perr != nil {
			return "", nil, false, perr
		}
		code = next

		Stage(ctx, callID, "static-check", "正在做静态安全检查")
		if vs := ValidateCode(code); len(vs) > 0 {
			feedback = formatViolations(vs)
			continue
		}

		Stage(ctx, callID, "review", "审核 Agent 正在检查语义、安全与需求符合度")
		rv, rerr := w.review(ctx, requirement, code)
		if rerr != nil {
			return "", nil, false, rerr
		}
		if rv.Pass {
			return code, rv.lowIssues(), true, nil
		}
		feedback = rv.highIssues()
	}
	return code, feedback, false, nil
}

// ───────────────────────── 审核 Agent ─────────────────────────

type ReviewIssue struct {
	Category string `json:"category"`
	Severity string `json:"severity"`
	Detail   string `json:"detail"`
}

type Review struct {
	Pass   bool          `json:"pass"`
	Issues []ReviewIssue `json:"issues"`
}

func (r Review) highIssues() []string {
	var out []string
	for _, i := range r.Issues {
		if i.Severity == "high" || i.Severity == "" {
			out = append(out, fmt.Sprintf("[%s] %s", i.Category, i.Detail))
		}
	}
	if len(out) == 0 {
		out = []string{"审核未通过，但没有给出具体原因"}
	}
	return out
}

func (r Review) lowIssues() []string {
	var out []string
	for _, i := range r.Issues {
		if i.Severity == "low" {
			out = append(out, fmt.Sprintf("[%s] %s", i.Category, i.Detail))
		}
	}
	return out
}

// review 用一个独立的模型调用（不同的系统提示、看不到生成过程）做把关。
// 对输出格式“失败即关闭”：解析不出合法 JSON 时重问一次，仍失败则视为未通过，绝不默认放行。
func (w *WidgetService) review(ctx context.Context, requirement, code string) (Review, error) {
	user := "## 用户需求\n" + requirement +
		"\n\n## 静态检查\n代码已通过确定性的快速检查（模块白名单、常见禁用 API 关键字）。这不代表安全，请你独立判断。" +
		"\n\n## 待审核代码\n```jsx\n" + code + "\n```"
	var lastErr error
	for i := 0; i < 2; i++ {
		text, err := w.callModel(ctx, ReviewerSystem, user)
		if err != nil {
			return Review{}, err
		}
		rv, perr := parseReview(text)
		if perr == nil {
			// 有 high 级别问题时无论模型说什么都不通过
			for _, is := range rv.Issues {
				if is.Severity == "high" {
					rv.Pass = false
				}
			}
			return rv, nil
		}
		lastErr = perr
		user += "\n\n（上一次输出不是合法 JSON，请只输出 JSON 对象。）"
	}
	return Review{Pass: false, Issues: []ReviewIssue{{Category: "semantic", Severity: "high", Detail: "审核结果无法解析：" + lastErr.Error()}}}, nil
}

func parseReview(text string) (Review, error) {
	start, end := strings.Index(text, "{"), strings.LastIndex(text, "}")
	if start < 0 || end <= start {
		return Review{}, errors.New("未找到 JSON 对象")
	}
	var rv Review
	if err := json.Unmarshal([]byte(text[start:end+1]), &rv); err != nil {
		return Review{}, err
	}
	return rv, nil
}

// ───────────────────────── 模型调用与文本处理 ─────────────────────────

func (w *WidgetService) callModel(ctx context.Context, system, user string) (string, error) {
	ctx, cancel := context.WithTimeout(ctx, modelCallTimeout)
	defer cancel()
	msg, err := w.model.Generate(ctx, []*schema.Message{schema.SystemMessage(system), schema.UserMessage(user)})
	if err != nil {
		return "", fmt.Errorf("模型调用失败: %w", err)
	}
	return msg.Content, nil
}

func (w *WidgetService) generate(ctx context.Context, system, user string) (string, error) {
	text, err := w.callModel(ctx, system, user)
	if err != nil {
		return "", err
	}
	code, ok := extractCode(text)
	if !ok {
		return "", errors.New("模型输出中没有找到代码块")
	}
	return code, nil
}

func patchUserPrompt(code, instruction string) string {
	return "## 现有代码\n```jsx\n" + code + "\n```\n\n## 修改要求\n" + instruction
}

func retryPrompt(prev string, feedback []string) string {
	var b strings.Builder
	b.WriteString("\n\n## 上一版候选代码\n```jsx\n" + prev + "\n```\n\n## 上一版存在以下问题，请全部修正后重新输出完整代码\n")
	for _, f := range feedback {
		b.WriteString("- " + f + "\n")
	}
	return b.String()
}

var (
	codeFence = regexp.MustCompile("(?s)```(?:jsx|tsx|js|javascript|typescript|ts)?[ \\t]*\\r?\\n(.*?)```")
	titleLine = regexp.MustCompile(`(?m)^\s*//\s*@title\s+(.+?)\s*$`)
)

func extractCode(text string) (string, bool) {
	if m := codeFence.FindStringSubmatch(text); m != nil {
		return strings.TrimSpace(m[1]), true
	}
	// 模型没有用代码块包裹，但内容本身像代码
	if strings.Contains(text, "export default") {
		return strings.TrimSpace(text), true
	}
	return "", false
}

func extractTitle(code, fallback string) string {
	if m := titleLine.FindStringSubmatch(code); m != nil {
		return truncate(m[1], 24)
	}
	return truncate(strings.Join(strings.Fields(fallback), " "), 24)
}

func truncate(s string, n int) string {
	if utf8.RuneCountInString(s) <= n {
		return s
	}
	return string([]rune(s)[:n]) + "…"
}
