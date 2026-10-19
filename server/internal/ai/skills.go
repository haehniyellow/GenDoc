package ai

import (
	"embed"
	"fmt"
	"sort"
	"strings"
)

//go:embed skills/*.md
var skillFS embed.FS

// Skill 是一份按需加载的指引文档。Agent 的系统提示里只放名称和一句话说明，
// 需要时才通过 load_skill 拉取全文，避免每次对话都携带全部技能内容。
type Skill struct {
	Name        string
	Description string
	Body        string
}

func LoadSkills() ([]Skill, error) {
	entries, err := skillFS.ReadDir("skills")
	if err != nil {
		return nil, err
	}
	var out []Skill
	for _, e := range entries {
		raw, err := skillFS.ReadFile("skills/" + e.Name())
		if err != nil {
			return nil, err
		}
		s, err := parseSkill(string(raw))
		if err != nil {
			return nil, fmt.Errorf("%s: %w", e.Name(), err)
		}
		out = append(out, s)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Name < out[j].Name })
	return out, nil
}

func parseSkill(raw string) (Skill, error) {
	raw = strings.ReplaceAll(raw, "\r\n", "\n")
	rest, ok := strings.CutPrefix(raw, "---\n")
	if !ok {
		return Skill{}, fmt.Errorf("缺少 frontmatter")
	}
	head, body, ok := strings.Cut(rest, "\n---\n")
	if !ok {
		return Skill{}, fmt.Errorf("frontmatter 未闭合")
	}
	s := Skill{Body: strings.TrimSpace(body)}
	for _, line := range strings.Split(head, "\n") {
		k, v, _ := strings.Cut(line, ":")
		switch strings.TrimSpace(k) {
		case "name":
			s.Name = strings.TrimSpace(v)
		case "description":
			s.Description = strings.TrimSpace(v)
		}
	}
	if s.Name == "" {
		return Skill{}, fmt.Errorf("frontmatter 缺少 name")
	}
	return s, nil
}

func skillIndex(skills []Skill) string {
	var b strings.Builder
	for _, s := range skills {
		fmt.Fprintf(&b, "- %s：%s\n", s.Name, s.Description)
	}
	return strings.TrimRight(b.String(), "\n")
}
