package ai

import (
	"fmt"
	"regexp"
	"strings"
)

// 服务端静态检查：在把代码交给审核 Agent 之前先做一遍确定性的快筛，命中时直接把具体问题反馈给生成器重试，
// 省掉一次审核调用。
//
// 这里不做 JSX 解析，所以比前端 widget-runtime/src/policy.ts（基于编译产物）更保守：
// 只匹配“几乎不可能出现在正常文案里”的形态（如 fetch( 、window[ ），宁可漏报交给审核 Agent 与前端兜底，也不误报。
// 前端策略与 iframe sandbox + CSP 才是最终防线。

const maxCodeChars = 60_000

var allowedModules = map[string]bool{"react": true, "@sdk": true}

type violation struct {
	Rule    string
	Message string
	Line    int
}

func (v violation) String() string { return fmt.Sprintf("第 %d 行：%s", v.Line, v.Message) }

var (
	reImportFrom   = regexp.MustCompile(`(?m)^\s*import\s+(?:[^'"\n;]*?\bfrom\s*)?['"]([^'"]+)['"]`)
	reDynamicImp   = regexp.MustCompile(`\bimport\s*\(`)
	reRequire      = regexp.MustCompile(`\brequire\s*\(`)
	reExportDef    = regexp.MustCompile(`\bexport\s+default\b`)
	reBlockComment = regexp.MustCompile(`(?s)/\*.*?\*/`)
	reLineComment  = regexp.MustCompile(`(?m)(^|[^:'"` + "`" + `])//[^\n]*`)

	bannedCalls = regexp.MustCompile(`(?:^|[^\w$.])(fetch|eval|importScripts|postMessage)\s*\(`)
	bannedNew   = regexp.MustCompile(`\bnew\s+(Function|XMLHttpRequest|WebSocket|EventSource|Worker|SharedWorker|BroadcastChannel)\b`)
	bannedProps = regexp.MustCompile(`\b(localStorage|sessionStorage|indexedDB|dangerouslySetInnerHTML|innerHTML|outerHTML|insertAdjacentHTML|WebAssembly|globalThis|__proto__)\b`)
	bannedWin   = regexp.MustCompile(`\b(window|document|self)\s*\[`)
	bannedFrame = regexp.MustCompile(`\b(window\s*\.\s*(?:parent|top|opener|frames|location)|document\s*\.\s*(?:cookie|write|domain|location))\b`)
	bannedCtor  = regexp.MustCompile(`constructor\s*\.\s*constructor`)
	bannedTag   = regexp.MustCompile(`(?i)<\s*(iframe|script|object|embed|link|meta|base|form|frame)[\s/>]`)
	extAttr     = regexp.MustCompile(`(?i)\b(?:href|src|action|poster|srcSet)\s*=\s*\{?\s*['"` + "`" + `]\s*(?:https?:)?//`)
	jsURL       = regexp.MustCompile(`(?i)javascript\s*:`)
	cssURL      = regexp.MustCompile(`(?i)url\(\s*['"]?\s*(?:https?:)?//`)
)

func stripComments(code string) string {
	code = reBlockComment.ReplaceAllStringFunc(code, func(s string) string {
		// 保留换行以维持行号
		return strings.Repeat("\n", strings.Count(s, "\n"))
	})
	return reLineComment.ReplaceAllString(code, "$1")
}

func lineOf(code string, idx int) int { return strings.Count(code[:idx], "\n") + 1 }

// ValidateCode 返回违规列表，空表示通过快筛。
func ValidateCode(code string) []violation {
	var out []violation
	if len([]rune(code)) > maxCodeChars {
		return []violation{{"size", fmt.Sprintf("代码超过 %d 字符上限", maxCodeChars), 1}}
	}
	src := stripComments(code)
	add := func(rule, msg string, idx int) { out = append(out, violation{rule, msg, lineOf(src, idx)}) }

	if !reExportDef.MatchString(src) {
		out = append(out, violation{"entry", "缺少 export default 的组件", 1})
	}
	for _, m := range reImportFrom.FindAllStringSubmatchIndex(src, -1) {
		mod := src[m[2]:m[3]]
		if !allowedModules[mod] {
			add("import", fmt.Sprintf("不允许导入模块 %q，只能使用 react 和 @sdk", mod), m[0])
		}
	}
	for _, m := range reDynamicImp.FindAllStringIndex(src, -1) {
		add("import", "不允许动态 import()", m[0])
	}
	for _, m := range reRequire.FindAllStringIndex(src, -1) {
		add("import", "不允许 require()", m[0])
	}
	for _, m := range bannedCalls.FindAllStringSubmatchIndex(src, -1) {
		add("api", fmt.Sprintf("禁止调用 %s()", src[m[2]:m[3]]), m[2])
	}
	for _, m := range bannedNew.FindAllStringSubmatchIndex(src, -1) {
		add("api", fmt.Sprintf("禁止使用 new %s", src[m[2]:m[3]]), m[0])
	}
	for _, m := range bannedProps.FindAllStringSubmatchIndex(src, -1) {
		add("api", fmt.Sprintf("禁止使用 %s", src[m[2]:m[3]]), m[0])
	}
	for _, m := range bannedWin.FindAllStringSubmatchIndex(src, -1) {
		add("global", fmt.Sprintf("禁止对 %s 使用计算属性访问", src[m[2]:m[3]]), m[0])
	}
	for _, m := range bannedFrame.FindAllStringIndex(src, -1) {
		add("global", fmt.Sprintf("禁止访问 %s", strings.Join(strings.Fields(src[m[0]:m[1]]), "")), m[0])
	}
	for _, m := range bannedCtor.FindAllStringIndex(src, -1) {
		add("api", "禁止 constructor.constructor", m[0])
	}
	for _, m := range bannedTag.FindAllStringSubmatchIndex(src, -1) {
		add("tag", fmt.Sprintf("禁止使用 <%s> 标签", src[m[2]:m[3]]), m[0])
	}
	for _, m := range extAttr.FindAllStringIndex(src, -1) {
		add("external", "禁止引用外部资源", m[0])
	}
	for _, m := range jsURL.FindAllStringIndex(src, -1) {
		add("external", "禁止 javascript: URL", m[0])
	}
	for _, m := range cssURL.FindAllStringIndex(src, -1) {
		add("external", "禁止 CSS 引用外部资源", m[0])
	}
	return out
}

func formatViolations(vs []violation) []string {
	out := make([]string, len(vs))
	for i, v := range vs {
		out[i] = v.String()
	}
	return out
}
