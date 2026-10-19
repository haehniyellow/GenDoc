package ai

import (
	"strings"
	"testing"
)

const sample = `// @title 计数器
import { useWidgetState } from '@sdk'

export default function Counter() {
  const [n, setN] = useWidgetState('count', 0)
  return <button onClick={() => setN(n + 1)}>点击 {n}</button>
}`

func TestApplyPatch(t *testing.T) {
	patch := "<<<<<<< SEARCH\n  return <button onClick={() => setN(n + 1)}>点击 {n}</button>\n=======\n  return <button onClick={() => setN(n + 2)}>+2 {n}</button>\n>>>>>>> REPLACE"
	got, err := ApplyPatch(sample, patch)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(got, "setN(n + 2)") || strings.Contains(got, "setN(n + 1)") {
		t.Fatalf("patch not applied:\n%s", got)
	}
	if !strings.Contains(got, "// @title 计数器") {
		t.Fatal("unrelated lines must be untouched")
	}
}

func TestApplyPatchTolerantToIndentation(t *testing.T) {
	// 模型常把缩进抄错：这里 SEARCH 用了 4 空格，原文是 2 空格，精确匹配失败后应按“去首尾空白的行”兜底匹配
	patch := "<<<<<<< SEARCH\n    const [n, setN] = useWidgetState('count', 0)\n    return <button onClick={() => setN(n + 1)}>点击 {n}</button>\n=======\n  const [n, setN] = useWidgetState('count', 10)\n  return <button>{n}</button>\n>>>>>>> REPLACE"
	if strings.Contains(sample, "    const [n, setN]") {
		t.Fatal("test precondition: sample must not contain the 4-space indented text")
	}
	got, err := ApplyPatch(sample, patch)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(got, "'count', 10") || strings.Contains(got, "setN(n + 1)") {
		t.Fatalf("fuzzy match failed:\n%s", got)
	}
}

func TestApplyPatchMultipleBlocks(t *testing.T) {
	patch := "<<<<<<< SEARCH\n// @title 计数器\n=======\n// @title 步进计数器\n>>>>>>> REPLACE\n<<<<<<< SEARCH\nuseWidgetState('count', 0)\n=======\nuseWidgetState('count', 5)\n>>>>>>> REPLACE"
	got, err := ApplyPatch(sample, patch)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(got, "步进计数器") || !strings.Contains(got, "'count', 5") {
		t.Fatalf("multi block failed:\n%s", got)
	}
}

func TestApplyPatchFailures(t *testing.T) {
	cases := map[string]string{
		"没有块":       "我觉得应该把按钮改大一点",
		"找不到":       "<<<<<<< SEARCH\nnot in code\n=======\nx\n>>>>>>> REPLACE",
		"SEARCH 为空": "<<<<<<< SEARCH\n\n=======\nx\n>>>>>>> REPLACE",
	}
	for name, p := range cases {
		if _, err := ApplyPatch(sample, p); err == nil {
			t.Errorf("%s: expected error", name)
		}
	}
	// 多处命中必须拒绝，不能猜位置
	dup := "a\nb\na\n"
	if _, err := ApplyPatch(dup, "<<<<<<< SEARCH\na\n=======\nX\n>>>>>>> REPLACE"); err == nil {
		t.Error("ambiguous search should fail")
	}
	// 任何一块失败，整体都不产生修改（不返回部分结果）
	partial := "<<<<<<< SEARCH\n// @title 计数器\n=======\n// @title X\n>>>>>>> REPLACE\n<<<<<<< SEARCH\nmissing\n=======\ny\n>>>>>>> REPLACE"
	if out, err := ApplyPatch(sample, partial); err == nil || out != "" {
		t.Error("partial application must not leak")
	}
}

func TestValidateCodeAccepts(t *testing.T) {
	if vs := ValidateCode(sample); len(vs) != 0 {
		t.Fatalf("unexpected violations: %v", vs)
	}
	// 文案里出现禁用词、注释里出现禁用调用，都不应误报
	ok := sample + "\n// fetch('x') 只是注释\n"
	ok = strings.Replace(ok, "点击 {n}", "Top 10 window document parent self", 1)
	if vs := ValidateCode(ok); len(vs) != 0 {
		t.Fatalf("false positive: %v", vs)
	}
}

func TestValidateCodeRejects(t *testing.T) {
	wrap := func(body string) string {
		return "import { useState } from 'react'\nexport default function W() {\n" + body + "\nreturn <div/>\n}"
	}
	bad := map[string]string{
		"网络":           wrap(`fetch('/api')`),
		"XHR":          wrap(`new XMLHttpRequest()`),
		"eval":         wrap(`eval('1')`),
		"Function":     wrap(`new Function('return 1')()`),
		"localStorage": wrap(`localStorage.getItem('a')`),
		"计算属性":         wrap(`window['fe'+'tch']('/a')`),
		"globalThis":   wrap(`globalThis.fetch('/a')`),
		"parent":       wrap(`window.parent.postMessage(1,'*')`),
		"innerHTML":    wrap(`el.innerHTML = 'x'`),
		"constructor":  wrap(`(()=>{}).constructor.constructor('return 1')()`),
		"第三方模块":        "import axios from 'axios'\nexport default () => <div/>",
		"动态导入":         wrap(`import('./x')`),
		"iframe":       "export default () => <iframe src=\"x\" />",
		"外链图片":         "export default () => <img src=\"https://evil.test/a.png\" />",
		"js 协议":        "export default () => <a href=\"javascript:alert(1)\">x</a>",
		"缺少入口":         "export function A() { return <div/> }",
	}
	for name, code := range bad {
		if vs := ValidateCode(code); len(vs) == 0 {
			t.Errorf("%s: expected violation", name)
		}
	}
}

func TestExtractCodeAndTitle(t *testing.T) {
	text := "好的\n```jsx\n" + sample + "\n```\n"
	code, ok := extractCode(text)
	if !ok || !strings.HasPrefix(code, "// @title") {
		t.Fatalf("extractCode: %q %v", code, ok)
	}
	if got := extractTitle(code, "fallback"); got != "计数器" {
		t.Fatalf("title = %q", got)
	}
	if got := extractTitle("export default () => null", "做一个很长很长很长很长很长很长很长很长的组件需求描述"); !strings.HasSuffix(got, "…") {
		t.Fatalf("fallback title should be truncated: %q", got)
	}
	if _, ok := extractCode("抱歉，我无法完成"); ok {
		t.Fatal("no code should be reported")
	}
}

func TestParseReview(t *testing.T) {
	rv, err := parseReview("好的，结果如下：\n{\"pass\": true, \"issues\": [{\"category\":\"contract\",\"severity\":\"low\",\"detail\":\"x\"}]}")
	if err != nil || !rv.Pass || len(rv.lowIssues()) != 1 {
		t.Fatalf("%v %+v", err, rv)
	}
	if _, err := parseReview("没有 json"); err == nil {
		t.Fatal("expected error")
	}
	if got := (Review{Pass: false}).highIssues(); len(got) != 1 {
		t.Fatal("a failed review without reasons must still yield feedback")
	}
}

func TestDocJSON(t *testing.T) {
	raw := `{"type":"doc","content":[
	  {"type":"heading","attrs":{"level":2},"content":[{"type":"text","text":"标题"}]},
	  {"type":"paragraph","content":[{"type":"text","text":"正文"}]},
	  {"type":"widget","attrs":{"uuid":"w-1","title":"计数器"}},
	  {"type":"bulletList","content":[{"type":"listItem","content":[{"type":"paragraph","content":[{"type":"text","text":"要点"}]}]}]},
	  {"type":"widget","attrs":{"uuid":"w-1"}},
	  {"type":"widget","attrs":{"uuid":"w-2"}}
	]}`
	ids := ExtractWidgetIDs(raw)
	if len(ids) != 2 || ids[0] != "w-1" || ids[1] != "w-2" {
		t.Fatalf("ids = %v", ids)
	}
	text := ExtractText(raw)
	for _, want := range []string{"## 标题", "正文", "[组件 id=w-1 标题=计数器]", "- 要点"} {
		if !strings.Contains(text, want) {
			t.Errorf("text missing %q:\n%s", want, text)
		}
	}
	if ExtractWidgetIDs("not json") != nil || ExtractText("not json") != "" {
		t.Fatal("invalid json should yield nothing")
	}
}

func TestLoadSkills(t *testing.T) {
	skills, err := LoadSkills()
	if err != nil {
		t.Fatal(err)
	}
	if len(skills) < 2 {
		t.Fatalf("skills = %d", len(skills))
	}
	for _, s := range skills {
		if s.Name == "" || s.Description == "" || s.Body == "" {
			t.Errorf("incomplete skill: %+v", s)
		}
	}
	if !strings.Contains(skillIndex(skills), "article-writer") {
		t.Fatal("index should list skills")
	}
}
