package api

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net/http"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/cloudwego/eino/schema"
	"github.com/gin-gonic/gin"

	"doc-platform/server/internal/ai"
	"doc-platform/server/internal/auth"
	"doc-platform/server/internal/runs"
	"doc-platform/server/internal/store"
)

const (
	maxMessageRunes = 8000
	maxRewriteRunes = 8000
	heartbeat       = 15 * time.Second
)

func (s *Server) ownedSession(c *gin.Context) (*store.Session, bool) {
	ss, err := s.st.GetSession(c.Param("id"))
	if err != nil || ss.UserID != auth.UserID(c) {
		fail(c, http.StatusNotFound, "会话不存在")
		return nil, false
	}
	return ss, true
}

func (s *Server) listSessions(c *gin.Context) {
	list, err := s.st.ListSessions(auth.UserID(c))
	if err != nil {
		storeErr(c, err)
		return
	}
	c.JSON(http.StatusOK, list)
}

func (s *Server) createSession(c *gin.Context) {
	ss, err := s.st.CreateSession(auth.UserID(c))
	if err != nil {
		storeErr(c, err)
		return
	}
	c.JSON(http.StatusOK, ss)
}

type messageOut struct {
	ID        string          `json:"id"`
	Role      string          `json:"role"`
	Content   string          `json:"content"`
	CreatedAt string          `json:"createdAt"`
	Meta      json.RawMessage `json:"meta,omitempty"`
}

// getSession 返回会话历史，以及仍在进行中的任务 id。
// 前端刷新页面或切换回该会话时，据此重新订阅事件流，把未完成的生成“接上”。
func (s *Server) getSession(c *gin.Context) {
	ss, ok := s.ownedSession(c)
	if !ok {
		return
	}
	msgs, err := s.st.Messages(ss.ID)
	if err != nil {
		storeErr(c, err)
		return
	}
	out := make([]messageOut, len(msgs))
	for i, m := range msgs {
		out[i] = messageOut{ID: m.ID, Role: m.Role, Content: m.Content, CreatedAt: m.CreatedAt}
		if m.Meta != "" {
			out[i].Meta = json.RawMessage(m.Meta)
		}
	}
	var active any
	if r := s.runs.Active(ss.ID); r != nil {
		active = gin.H{"id": r.ID}
	}
	c.JSON(http.StatusOK, gin.H{"session": ss, "messages": out, "activeRun": active})
}

func (s *Server) deleteSession(c *gin.Context) {
	ss, ok := s.ownedSession(c)
	if !ok {
		return
	}
	if r := s.runs.Active(ss.ID); r != nil {
		r.Cancel()
	}
	if err := s.st.DeleteSession(ss.ID, auth.UserID(c)); err != nil {
		storeErr(c, err)
		return
	}
	c.Status(http.StatusNoContent)
}

type sendMessageIn struct {
	ClientMessageID string `json:"clientMessageId"`
	Content         string `json:"content"`
	DocID           string `json:"docId"`
}

// sendMessage 只负责“登记并启动任务”，立即返回 runId；生成过程通过 events 接口以 SSE 订阅。
// 任务与本次 HTTP 请求解耦，因此页面刷新、断网都不会中断或重复执行。
func (s *Server) sendMessage(c *gin.Context) {
	ss, ok := s.ownedSession(c)
	if !ok {
		return
	}
	uid := auth.UserID(c)
	var in sendMessageIn
	if c.ShouldBindJSON(&in) != nil {
		fail(c, http.StatusBadRequest, "请求格式错误")
		return
	}
	in.Content = strings.TrimSpace(in.Content)
	if in.Content == "" || utf8.RuneCountInString(in.Content) > maxMessageRunes {
		fail(c, http.StatusBadRequest, fmt.Sprintf("消息不能为空且不超过 %d 字", maxMessageRunes))
		return
	}
	if l := len(in.ClientMessageID); l < 8 || l > 64 {
		fail(c, http.StatusBadRequest, "clientMessageId 需为 8-64 位")
		return
	}
	if in.DocID != "" {
		d, err := s.st.GetDoc(in.DocID)
		if err != nil || (d.OwnerID != uid && !d.Shared) {
			fail(c, http.StatusNotFound, "文档不存在")
			return
		}
	}

	s.startMu.Lock()
	defer s.startMu.Unlock()

	// 幂等：同一个 clientMessageId 重复提交（网络重试、连点、刷新后重发）不会再启动第二个任务
	if r := s.runs.ByClientMsg(ss.ID, in.ClientMessageID); r != nil {
		c.JSON(http.StatusOK, gin.H{"runId": r.ID, "deduplicated": true})
		return
	}
	if exists, _ := s.st.MessageExists(ss.ID, in.ClientMessageID); exists {
		c.JSON(http.StatusOK, gin.H{"runId": "", "deduplicated": true})
		return
	}
	if s.runs.Active(ss.ID) != nil {
		fail(c, http.StatusConflict, "上一条消息仍在生成中")
		return
	}

	history, err := s.st.Messages(ss.ID)
	if err != nil {
		storeErr(c, err)
		return
	}
	if _, err := s.st.AppendMessage(ss.ID, "user", in.Content, "", in.ClientMessageID); err != nil {
		storeErr(c, err)
		return
	}
	msgs := append(ai.BuildHistory(history), schema.UserMessage(in.Content))

	rc := &ai.RunCtx{UserID: uid, SessionID: ss.ID, DocID: in.DocID}
	run := s.runs.Start(ss.ID, uid, in.ClientMessageID, func(ctx context.Context, r *runs.Run) error {
		rc.Run = r
		return s.execute(ctx, rc, msgs)
	})
	c.JSON(http.StatusOK, gin.H{"runId": run.ID, "deduplicated": false})
}

// execute 运行 Agent 并持久化助手消息。必须在返回前完成持久化：run.done 事件在它返回之后才会发出，
// 客户端收到 run.done 再拉会话就一定能看到完整的助手消息。
func (s *Server) execute(ctx context.Context, rc *ai.RunCtx, msgs []*schema.Message) error {
	turn, err := s.agent.Run(ctx, rc, msgs)

	status, errMsg := "done", ""
	switch {
	case ctx.Err() != nil:
		status, err = "cancelled", nil
	case err != nil:
		log.Printf("[ai] run %s failed: %v", rc.Run.ID, err)
		status, errMsg = "error", truncateMsg(err.Error(), 300)
	}

	meta, _ := json.Marshal(ai.MessageMeta{Tools: turn.Tools, Status: status, Error: errMsg})
	if turn.Text != "" || len(turn.Tools) > 0 || status != "done" {
		if _, perr := s.st.AppendMessage(rc.SessionID, "assistant", turn.Text, string(meta), ""); perr != nil {
			log.Printf("[ai] persist assistant message: %v", perr)
			if err == nil {
				err = errors.New("保存回复失败")
			}
		}
	}
	if status == "error" {
		return errors.New(errMsg)
	}
	return err
}

func truncateMsg(s string, n int) string {
	if utf8.RuneCountInString(s) <= n {
		return s
	}
	return string([]rune(s)[:n]) + "…"
}

func lastEventID(c *gin.Context) int {
	v := c.GetHeader("Last-Event-ID")
	if v == "" {
		v = c.Query("after")
	}
	n, _ := strconv.Atoi(v)
	return max(n, 0)
}

func sseHeaders(c *gin.Context) {
	h := c.Writer.Header()
	h.Set("Content-Type", "text/event-stream")
	h.Set("Cache-Control", "no-cache, no-transform")
	h.Set("Connection", "keep-alive")
	h.Set("X-Accel-Buffering", "no") // 让 nginx 之类的反向代理不要缓冲
	c.Writer.WriteHeader(http.StatusOK)
	c.Writer.Flush()
}

// streamRun 订阅任务的事件日志：先从 Last-Event-ID 之后重放，再跟随实时事件，直到收到终止事件。
func (s *Server) streamRun(c *gin.Context) {
	run := s.runs.Get(c.Param("id"))
	if run == nil || run.UserID != auth.UserID(c) {
		// 日志已过期（服务重启或超过保留期）。客户端应改为重新拉取会话，以数据库里的消息为准。
		fail(c, http.StatusNotFound, "任务不存在或已过期")
		return
	}
	after := lastEventID(c)
	sseHeaders(c)

	w := c.Writer
	hb := time.NewTicker(heartbeat)
	defer hb.Stop()
	for {
		events, done, wait := run.Since(after)
		for _, e := range events {
			if _, err := fmt.Fprintf(w, "id: %d\nevent: %s\ndata: %s\n\n", e.Seq, e.Type, e.Data); err != nil {
				return
			}
			after = e.Seq
		}
		w.Flush()
		if done {
			return
		}
		select {
		case <-wait:
		case <-hb.C:
			if _, err := fmt.Fprint(w, ": ping\n\n"); err != nil {
				return
			}
			w.Flush()
		case <-c.Request.Context().Done():
			return // 客户端断开；任务继续在后台运行
		}
	}
}

func (s *Server) cancelRun(c *gin.Context) {
	run := s.runs.Get(c.Param("id"))
	if run == nil || run.UserID != auth.UserID(c) {
		fail(c, http.StatusNotFound, "任务不存在或已过期")
		return
	}
	run.Cancel()
	c.Status(http.StatusNoContent)
}

func writeSSE(c *gin.Context, event string, payload any) error {
	data, _ := json.Marshal(payload)
	if _, err := fmt.Fprintf(c.Writer, "event: %s\ndata: %s\n\n", event, data); err != nil {
		return err
	}
	c.Writer.Flush()
	return nil
}

// rewrite 是文档里“选中文字 → AI 改写”的一次性流式接口，不需要断线续传，改写结果由前端预览后再决定是否采纳。
func (s *Server) rewrite(c *gin.Context) {
	var in struct {
		Text        string `json:"text"`
		Instruction string `json:"instruction"`
	}
	if c.ShouldBindJSON(&in) != nil {
		fail(c, http.StatusBadRequest, "请求格式错误")
		return
	}
	in.Text, in.Instruction = strings.TrimSpace(in.Text), strings.TrimSpace(in.Instruction)
	if in.Text == "" || utf8.RuneCountInString(in.Text) > maxRewriteRunes {
		fail(c, http.StatusBadRequest, fmt.Sprintf("待改写文字不能为空且不超过 %d 字", maxRewriteRunes))
		return
	}
	if in.Instruction == "" || utf8.RuneCountInString(in.Instruction) > 500 {
		fail(c, http.StatusBadRequest, "改写要求不能为空且不超过 500 字")
		return
	}
	sseHeaders(c)
	err := s.agent.Rewrite(c.Request.Context(), in.Text, in.Instruction, func(chunk string) {
		_ = writeSSE(c, "delta", gin.H{"text": chunk})
	})
	if err != nil && c.Request.Context().Err() == nil {
		log.Printf("[ai] rewrite failed: %v", err)
		_ = writeSSE(c, "error", gin.H{"message": "改写失败，请稍后重试"})
		return
	}
	_ = writeSSE(c, "done", gin.H{})
}
