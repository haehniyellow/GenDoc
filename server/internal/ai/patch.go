package ai

import (
	"errors"
	"fmt"
	"regexp"
	"strings"
)

// 局部修改协议：模型输出若干 SEARCH/REPLACE 块，由程序精确应用到现有代码上。
// 相比让模型重写整份代码：token 更省，也不会误伤无关代码；匹配不到就明确失败，由上层回退到整段重写。

var patchBlock = regexp.MustCompile(`(?s)<<<<<<<[ \t]*SEARCH[ \t]*\r?\n(.*?)\r?\n=======[ \t]*\r?\n(.*?)\r?\n?>>>>>>>[ \t]*REPLACE`)

type patchOp struct{ search, replace string }

var ErrPatchNoBlocks = errors.New("未找到有效的修改块")

func parsePatch(text string) ([]patchOp, error) {
	ms := patchBlock.FindAllStringSubmatch(text, -1)
	if len(ms) == 0 {
		return nil, ErrPatchNoBlocks
	}
	ops := make([]patchOp, 0, len(ms))
	for _, m := range ms {
		ops = append(ops, patchOp{search: m[1], replace: m[2]})
	}
	return ops, nil
}

// ApplyPatch 依次应用所有块。每个 SEARCH 必须在（当前）代码中唯一命中，否则整体失败、不产生部分修改。
func ApplyPatch(code, patch string) (string, error) {
	ops, err := parsePatch(patch)
	if err != nil {
		return "", err
	}
	out := code
	for i, op := range ops {
		if strings.TrimSpace(op.search) == "" {
			return "", fmt.Errorf("第 %d 个修改块的 SEARCH 为空", i+1)
		}
		next, err := replaceOnce(out, op.search, op.replace)
		if err != nil {
			return "", fmt.Errorf("第 %d 个修改块：%w", i+1, err)
		}
		out = next
	}
	return out, nil
}

var (
	errNoMatch   = errors.New("在现有代码中找不到 SEARCH 内容")
	errMultiMatc = errors.New("SEARCH 内容在代码中出现多次，无法确定修改位置")
)

func replaceOnce(code, search, replace string) (string, error) {
	switch n := strings.Count(code, search); {
	case n == 1:
		return strings.Replace(code, search, replace, 1), nil
	case n > 1:
		return "", errMultiMatc
	}
	// 容忍模型在行尾空白 / 缩进上的细微偏差：按“去掉首尾空白的行序列”做匹配
	lines := strings.Split(code, "\n")
	want := strings.Split(strings.TrimSpace(search), "\n")
	for i := range want {
		want[i] = strings.TrimSpace(want[i])
	}
	var hits []int
	for i := 0; i+len(want) <= len(lines); i++ {
		ok := true
		for j := range want {
			if strings.TrimSpace(lines[i+j]) != want[j] {
				ok = false
				break
			}
		}
		if ok {
			hits = append(hits, i)
		}
	}
	switch len(hits) {
	case 0:
		return "", errNoMatch
	case 1:
		start := hits[0]
		repl := strings.Split(strings.TrimRight(replace, "\n"), "\n")
		merged := append(append(append([]string{}, lines[:start]...), repl...), lines[start+len(want):]...)
		return strings.Join(merged, "\n"), nil
	default:
		return "", errMultiMatc
	}
}
