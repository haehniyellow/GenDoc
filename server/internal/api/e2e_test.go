package api_test

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"
	"time"

	"doc-platform/server/internal/ai"
	"doc-platform/server/internal/api"
	"doc-platform/server/internal/config"
	"doc-platform/server/internal/runs"
	"doc-platform/server/internal/store"
)

// 端到端：真实的 store（临时 SQLite）+ 真实路由 + 真实 Eino Agent，只有 LLM 换成 Mock。

type client struct {
	t     *testing.T
	base  string
	token string
}

func newServer(t *testing.T) *httptest.Server {
	t.Helper()
	st, err := store.Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { st.Close() })
	cfg := config.Config{JWTSecret: "test-secret", AllowRegister: true, ForceMock: true}
	llm, err := ai.NewChatModel(context.Background(), cfg)
	if err != nil {
		t.Fatal(err)
	}
	agent, err := ai.NewAgent(context.Background(), llm, st)
	if err != nil {
		t.Fatal(err)
	}
	ts := httptest.NewServer(api.New(cfg, st, runs.NewManager(time.Minute), agent).Router())
	t.Cleanup(ts.Close)
	return ts
}

func (c *client) do(method, path string, body any) (int, map[string]any) {
	c.t.Helper()
	var rd io.Reader
	if body != nil {
		b, _ := json.Marshal(body)
		rd = bytes.NewReader(b)
	}
	req, _ := http.NewRequest(method, c.base+path, rd)
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	if c.token != "" {
		req.Header.Set("Authorization", "Bearer "+c.token)
	}
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		c.t.Fatal(err)
	}
	defer res.Body.Close()
	raw, _ := io.ReadAll(res.Body)
	var out map[string]any
	_ = json.Unmarshal(raw, &out)
	return res.StatusCode, out
}

func (c *client) mustOK(method, path string, body any) map[string]any {
	c.t.Helper()
	status, out := c.do(method, path, body)
	if status != 200 && status != 204 {
		c.t.Fatalf("%s %s -> %d %v", method, path, status, out)
	}
	return out
}

func register(t *testing.T, base, name string) *client {
	t.Helper()
	c := &client{t: t, base: base}
	out := c.mustOK("POST", "/api/auth/register", map[string]string{"username": name, "password": "password123"})
	c.token = out["token"].(string)
	return c
}

type sseEvent struct {
	Seq  int
	Type string
	Data map[string]any
}

// streamEvents 订阅 run 的事件流，读到终止事件或读满 max 条后返回（max<=0 表示读到结束）。
func (c *client) streamEvents(runID string, lastEventID, max int) []sseEvent {
	c.t.Helper()
	req, _ := http.NewRequest("GET", c.base+"/api/ai/runs/"+runID+"/events", nil)
	req.Header.Set("Authorization", "Bearer "+c.token)
	req.Header.Set("Last-Event-ID", strconv.Itoa(lastEventID))
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	res, err := http.DefaultClient.Do(req.WithContext(ctx))
	if err != nil {
		c.t.Fatal(err)
	}
	defer res.Body.Close()
	if res.StatusCode != 200 {
		c.t.Fatalf("events status %d", res.StatusCode)
	}
	if ct := res.Header.Get("Content-Type"); ct != "text/event-stream" {
		c.t.Fatalf("content-type = %q", ct)
	}
	var out []sseEvent
	var cur sseEvent
	sc := bufio.NewScanner(res.Body)
	sc.Buffer(make([]byte, 1<<20), 1<<20)
	for sc.Scan() {
		line := sc.Text()
		switch {
		case strings.HasPrefix(line, "id: "):
			cur.Seq, _ = strconv.Atoi(line[4:])
		case strings.HasPrefix(line, "event: "):
			cur.Type = line[7:]
		case strings.HasPrefix(line, "data: "):
			_ = json.Unmarshal([]byte(line[6:]), &cur.Data)
		case line == "" && cur.Type != "":
			out = append(out, cur)
			if cur.Type == "run.done" || cur.Type == "run.error" || (max > 0 && len(out) >= max) {
				return out
			}
			cur = sseEvent{}
		}
	}
	return out
}

func (c *client) send(sessionID, clientID, text, docID string) map[string]any {
	return c.mustOK("POST", "/api/ai/sessions/"+sessionID+"/messages",
		map[string]string{"clientMessageId": clientID, "content": text, "docId": docID})
}

func types(evs []sseEvent) []string {
	out := make([]string, len(evs))
	for i, e := range evs {
		out[i] = e.Type
	}
	return out
}

func TestUnauthenticatedRejected(t *testing.T) {
	ts := newServer(t)
	c := &client{t: t, base: ts.URL}
	for _, p := range []string{"/api/docs", "/api/ai/sessions", "/api/widgets", "/api/auth/me"} {
		if status, _ := c.do("GET", p, nil); status != 401 {
			t.Errorf("%s -> %d, want 401", p, status)
		}
	}
	c.token = "not-a-jwt"
	if status, _ := c.do("GET", "/api/docs", nil); status != 401 {
		t.Errorf("garbage token -> %d, want 401", status)
	}
}

func TestAuthFlow(t *testing.T) {
	ts := newServer(t)
	c := &client{t: t, base: ts.URL}
	if status, _ := c.do("POST", "/api/auth/register", map[string]string{"username": "a!", "password": "password123"}); status != 400 {
		t.Errorf("bad username -> %d", status)
	}
	if status, _ := c.do("POST", "/api/auth/register", map[string]string{"username": "alice", "password": "short"}); status != 400 {
		t.Errorf("short password -> %d", status)
	}
	c.mustOK("POST", "/api/auth/register", map[string]string{"username": "alice", "password": "password123"})
	if status, _ := c.do("POST", "/api/auth/register", map[string]string{"username": "alice", "password": "password123"}); status != 409 {
		t.Errorf("duplicate -> %d", status)
	}
	if status, _ := c.do("POST", "/api/auth/login", map[string]string{"username": "alice", "password": "wrong-password"}); status != 401 {
		t.Errorf("wrong password -> %d", status)
	}
	if status, _ := c.do("POST", "/api/auth/login", map[string]string{"username": "nobody", "password": "password123"}); status != 401 {
		t.Errorf("unknown user -> %d", status)
	}
	out := c.mustOK("POST", "/api/auth/login", map[string]string{"username": "alice", "password": "password123"})
	c.token = out["token"].(string)
	if me := c.mustOK("GET", "/api/auth/me", nil); me["username"] != "alice" {
		t.Errorf("me = %v", me)
	}
}

// 整条主链路：Agent 调工具 → 生成 → 静态检查 → 审核 → 保存组件 → SSE 推送 → 断线续传 → 幂等 → 持久化
func TestChatCreateWidgetStreamResumeAndDedupe(t *testing.T) {
	ts := newServer(t)
	alice := register(t, ts.URL, "alice")
	sess := alice.mustOK("POST", "/api/ai/sessions", map[string]any{})
	sid := sess["id"].(string)

	first := alice.send(sid, "client-msg-0001", "帮我做一个计数器组件", "")
	runID := first["runId"].(string)
	if first["deduplicated"] != false || runID == "" {
		t.Fatalf("first = %v", first)
	}

	// 幂等：同一个 clientMessageId 重复提交，返回同一个 run，不会再启动任务
	again := alice.send(sid, "client-msg-0001", "帮我做一个计数器组件", "")
	if again["deduplicated"] != true || again["runId"] != runID {
		t.Fatalf("dedupe = %v", again)
	}

	all := alice.streamEvents(runID, 0, 0)
	got := types(all)
	if got[0] != "run.start" || got[len(got)-1] != "run.done" {
		t.Fatalf("events = %v", got)
	}
	for i, e := range all {
		if e.Seq != i+1 {
			t.Fatalf("seq not contiguous: %v", got)
		}
	}
	need := map[string]bool{"tool.start": false, "stage": false, "tool.end": false, "text.delta": false}
	var widgetID string
	var stages []string
	for _, e := range all {
		if _, ok := need[e.Type]; ok {
			need[e.Type] = true
		}
		if e.Type == "stage" {
			stages = append(stages, e.Data["stage"].(string))
			if e.Data["callId"] == "" {
				t.Errorf("stage event should carry the tool callId")
			}
		}
		if e.Type == "tool.end" {
			var res struct {
				OK       bool   `json:"ok"`
				WidgetID string `json:"widgetId"`
			}
			if err := json.Unmarshal([]byte(e.Data["result"].(string)), &res); err != nil || !res.OK {
				t.Fatalf("tool.end result = %v (%v)", e.Data["result"], err)
			}
			widgetID = res.WidgetID
		}
	}
	for k, seen := range need {
		if !seen {
			t.Errorf("missing %s event in %v", k, got)
		}
	}
	if joined := fmt.Sprint(stages); !strings.Contains(joined, "generate") || !strings.Contains(joined, "review") {
		t.Errorf("stages = %v, want generate and review", stages)
	}

	// 断线续传：从任意 seq 之后重连，拿到的恰好是完整日志的后缀
	for _, from := range []int{0, 2, len(all) - 1, len(all)} {
		resumed := alice.streamEvents(runID, from, 0)
		if from == len(all) {
			// 已经结束的任务从末尾续传：不会有新事件，连接立即关闭
			if len(resumed) != 0 {
				t.Errorf("resume from end = %v", types(resumed))
			}
			continue
		}
		if len(resumed) != len(all)-from || resumed[0].Seq != from+1 {
			t.Errorf("resume from %d: got %v", from, types(resumed))
		}
	}

	// 持久化：刷新页面（重新拉会话）能看到完整消息，且没有进行中的任务
	detail := alice.mustOK("GET", "/api/ai/sessions/"+sid, nil)
	if detail["activeRun"] != nil {
		t.Errorf("activeRun should be nil, got %v", detail["activeRun"])
	}
	msgs := detail["messages"].([]any)
	if len(msgs) != 2 {
		t.Fatalf("messages = %d, want user + assistant", len(msgs))
	}
	assistant := msgs[1].(map[string]any)
	meta := assistant["meta"].(map[string]any)
	tools := meta["tools"].([]any)
	if meta["status"] != "done" || len(tools) != 1 || tools[0].(map[string]any)["name"] != "create_widget" {
		t.Errorf("assistant meta = %v", meta)
	}
	if list := alice.mustOK("GET", "/api/ai/sessions", nil); list == nil {
		t.Log("sessions listed as array (decoded as nil map is fine)")
	}

	// 生成的组件已入库且带 export default
	w := alice.mustOK("GET", "/api/widgets/"+widgetID, nil)
	if !strings.Contains(w["code"].(string), "export default") || w["version"].(float64) != 1 || w["title"] != "计数器" {
		t.Errorf("widget = %v", w)
	}

	// 局部修改：走 modify_widget，版本号 +1
	second := alice.send(sid, "client-msg-0002", "把这个组件的标题修改一下", "")
	evs := alice.streamEvents(second["runId"].(string), 0, 0)
	var sawModify bool
	for _, e := range evs {
		if e.Type == "tool.start" && e.Data["name"] == "modify_widget" {
			sawModify = true
		}
	}
	if !sawModify {
		t.Fatalf("expected modify_widget, got %v", types(evs))
	}
	w2 := alice.mustOK("GET", "/api/widgets/"+widgetID, nil)
	if w2["version"].(float64) != 2 || !strings.Contains(w2["title"].(string), "已修改") {
		t.Errorf("after modify: %v", w2)
	}
}

// 页面刷新 / 网络断开时，SSE 连接被关闭，但任务必须继续跑完并落库，且不会重复执行
func TestRunSurvivesClientDisconnect(t *testing.T) {
	ts := newServer(t)
	alice := register(t, ts.URL, "alice")
	sid := alice.mustOK("POST", "/api/ai/sessions", map[string]any{})["id"].(string)

	runID := alice.send(sid, "client-msg-0001", "写一篇文章", "")["runId"].(string)
	// 只读两个事件就断开，模拟刷新页面
	partial := alice.streamEvents(runID, 0, 2)
	if len(partial) != 2 {
		t.Fatalf("partial = %v", types(partial))
	}

	// 刷新后：会话详情应告知仍有进行中的任务（或已经完成），据此重新订阅
	deadline := time.Now().Add(8 * time.Second)
	for {
		d := alice.mustOK("GET", "/api/ai/sessions/"+sid, nil)
		if d["activeRun"] == nil {
			if n := len(d["messages"].([]any)); n != 2 {
				t.Fatalf("messages after completion = %d, want exactly 2 (no duplicate execution)", n)
			}
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("run never finished after client disconnect")
		}
		time.Sleep(50 * time.Millisecond)
	}
	rest := alice.streamEvents(runID, partial[len(partial)-1].Seq, 0)
	if rest[len(rest)-1].Type != "run.done" {
		t.Fatalf("resumed tail = %v", types(rest))
	}
}

func TestSessionIsolationAndConflict(t *testing.T) {
	ts := newServer(t)
	alice := register(t, ts.URL, "alice")
	bob := register(t, ts.URL, "bobby")
	sid := alice.mustOK("POST", "/api/ai/sessions", map[string]any{})["id"].(string)
	runID := alice.send(sid, "client-msg-0001", "写一篇文章", "")["runId"].(string)

	if status, _ := bob.do("GET", "/api/ai/sessions/"+sid, nil); status != 404 {
		t.Errorf("bob reads alice session -> %d", status)
	}
	if status, _ := bob.do("POST", "/api/ai/sessions/"+sid+"/messages", map[string]string{"clientMessageId": "bob-msg-0001", "content": "hi"}); status != 404 {
		t.Errorf("bob posts to alice session -> %d", status)
	}
	if status, _ := bob.do("GET", "/api/ai/runs/"+runID+"/events", nil); status != 404 {
		t.Errorf("bob subscribes alice run -> %d", status)
	}
	if status, _ := bob.do("POST", "/api/ai/runs/"+runID+"/cancel", nil); status != 404 {
		t.Errorf("bob cancels alice run -> %d", status)
	}
	alice.streamEvents(runID, 0, 0)

	// 输入校验
	if status, _ := alice.do("POST", "/api/ai/sessions/"+sid+"/messages", map[string]string{"clientMessageId": "x", "content": "hi"}); status != 400 {
		t.Errorf("short clientMessageId -> %d", status)
	}
	if status, _ := alice.do("POST", "/api/ai/sessions/"+sid+"/messages", map[string]string{"clientMessageId": "client-msg-0009", "content": "   "}); status != 400 {
		t.Errorf("blank content -> %d", status)
	}
}

func TestWidgetDataPermissions(t *testing.T) {
	ts := newServer(t)
	alice := register(t, ts.URL, "alice")
	bob := register(t, ts.URL, "bobby")

	sid := alice.mustOK("POST", "/api/ai/sessions", map[string]any{})["id"].(string)
	runID := alice.send(sid, "client-msg-0001", "做一个投票组件", "")["runId"].(string)
	var widgetID string
	for _, e := range alice.streamEvents(runID, 0, 0) {
		if e.Type == "tool.end" {
			var r struct {
				WidgetID string `json:"widgetId"`
			}
			_ = json.Unmarshal([]byte(e.Data["result"].(string)), &r)
			widgetID = r.WidgetID
		}
	}
	if widgetID == "" {
		t.Fatal("no widget created")
	}
	dataPath := "/api/widgets/" + widgetID + "/data/votes"

	// 所有者读写
	alice.mustOK("PUT", dataPath, map[string]any{"value": map[string]any{"赞成": 3}})
	got := alice.mustOK("GET", dataPath, nil)
	if got["value"].(map[string]any)["赞成"].(float64) != 3 {
		t.Errorf("value = %v", got)
	}
	if keys := alice.mustOK("GET", "/api/widgets/"+widgetID+"/data", nil)["keys"].([]any); len(keys) != 1 || keys[0] != "votes" {
		t.Errorf("keys = %v", keys)
	}
	alice.mustOK("PUT", "/api/widgets/"+widgetID+"/data/gone", map[string]any{"value": 1})
	alice.mustOK("DELETE", "/api/widgets/"+widgetID+"/data/gone", nil)
	if v := alice.mustOK("GET", "/api/widgets/"+widgetID+"/data/gone", nil); v["value"] != nil {
		t.Errorf("deleted key still has value: %v", v)
	}

	// 输入校验：不合法 key、超大 value
	if status, _ := alice.do("PUT", "/api/widgets/"+widgetID+"/data/bad key!", map[string]any{"value": 1}); status != 400 && status != 404 {
		t.Errorf("bad key -> %d", status)
	}
	if status, _ := alice.do("PUT", "/api/widgets/"+widgetID+"/data/"+strings.Repeat("k", 129), map[string]any{"value": 1}); status != 400 {
		t.Errorf("long key -> %d", status)
	}
	if status, _ := alice.do("PUT", dataPath, map[string]any{"value": strings.Repeat("x", 70*1024)}); status != 413 {
		t.Errorf("oversize -> %d", status)
	}
	if status, _ := alice.do("PUT", dataPath, map[string]any{}); status != 400 {
		t.Errorf("missing value -> %d", status)
	}

	// 未分享、也没放进任何文档：他人不可读写，且看不出该组件是否存在
	for _, m := range []string{"GET", "PUT", "DELETE"} {
		var body any
		if m == "PUT" {
			body = map[string]any{"value": 1}
		}
		if status, _ := bob.do(m, dataPath, body); status != 404 {
			t.Errorf("bob %s private widget data -> %d, want 404", m, status)
		}
	}
	if status, _ := bob.do("GET", "/api/widgets/"+widgetID, nil); status != 404 {
		t.Errorf("bob reads private widget -> %d", status)
	}

	// 把组件放进文档：绑定关系由服务端根据文档内容推导；文档未分享时 bob 仍然不能访问
	doc := alice.mustOK("POST", "/api/docs", map[string]string{"title": "投票文档"})
	docID := doc["id"].(string)
	content := map[string]any{"type": "doc", "content": []any{
		map[string]any{"type": "paragraph", "content": []any{map[string]any{"type": "text", "text": "请投票"}}},
		map[string]any{"type": "widget", "attrs": map[string]any{"uuid": widgetID, "title": "投票", "height": 280}},
	}}
	alice.mustOK("PUT", "/api/docs/"+docID, map[string]any{"content": content})
	if status, _ := bob.do("GET", "/api/docs/"+docID, nil); status != 404 {
		t.Errorf("bob reads unshared doc -> %d", status)
	}
	if status, _ := bob.do("GET", dataPath, nil); status != 404 {
		t.Errorf("bob reads widget data of unshared doc -> %d", status)
	}

	// 分享文档：bob 可读文档、可与组件交互（读写数据），但不能改文档，也不能改组件代码
	alice.mustOK("PUT", "/api/docs/"+docID, map[string]any{"shared": true})
	bd := bob.mustOK("GET", "/api/docs/"+docID, nil)
	if bd["canEdit"] != false || alice.mustOK("GET", "/api/docs/"+docID, nil)["canEdit"] != true {
		t.Errorf("canEdit flags wrong: bob=%v", bd["canEdit"])
	}
	if status, _ := bob.do("PUT", "/api/docs/"+docID, map[string]any{"title": "被篡改"}); status != 404 {
		t.Errorf("bob edits alice doc -> %d", status)
	}
	if status, _ := bob.do("DELETE", "/api/docs/"+docID, nil); status != 404 {
		t.Errorf("bob deletes alice doc -> %d", status)
	}
	bob.mustOK("GET", "/api/widgets/"+widgetID, nil)
	bob.mustOK("PUT", dataPath, map[string]any{"value": map[string]any{"赞成": 4}})
	if v := alice.mustOK("GET", dataPath, nil)["value"].(map[string]any)["赞成"].(float64); v != 4 {
		t.Errorf("shared write not visible to owner: %v", v)
	}

	// 从文档中移除组件后，绑定随之解除，bob 再次失去访问权
	empty := map[string]any{"type": "doc", "content": []any{map[string]any{"type": "paragraph"}}}
	alice.mustOK("PUT", "/api/docs/"+docID, map[string]any{"content": empty})
	if status, _ := bob.do("GET", dataPath, nil); status != 404 {
		t.Errorf("bob still reads widget removed from doc -> %d", status)
	}

	// 非法文档内容被拒绝
	if status, _ := alice.do("PUT", "/api/docs/"+docID, map[string]any{"content": map[string]any{"type": "not-doc"}}); status != 400 {
		t.Errorf("invalid doc content -> %d", status)
	}
}

func TestRewriteStream(t *testing.T) {
	ts := newServer(t)
	alice := register(t, ts.URL, "alice")
	body, _ := json.Marshal(map[string]string{"text": "这是一段原文。", "instruction": "更简洁"})
	req, _ := http.NewRequest("POST", ts.URL+"/api/ai/rewrite", bytes.NewReader(body))
	req.Header.Set("Authorization", "Bearer "+alice.token)
	req.Header.Set("Content-Type", "application/json")
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	raw, _ := io.ReadAll(res.Body)
	s := string(raw)
	// 文本会被切成多个 delta，需要先拼接再断言
	var joined strings.Builder
	for _, line := range strings.Split(s, "\n") {
		if rest, ok := strings.CutPrefix(line, "data: "); ok {
			var d struct {
				Text string `json:"text"`
			}
			_ = json.Unmarshal([]byte(rest), &d)
			joined.WriteString(d.Text)
		}
	}
	if !strings.Contains(s, "event: delta") || !strings.HasSuffix(strings.TrimSpace(s), "data: {}") || !strings.Contains(joined.String(), "这是一段原文。") {
		t.Fatalf("rewrite stream = %q (joined %q)", s, joined.String())
	}

	if status, _ := alice.do("POST", "/api/ai/rewrite", map[string]string{"text": "", "instruction": "x"}); status != 400 {
		t.Errorf("empty text -> %d", status)
	}
}
