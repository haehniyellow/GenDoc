package ai

import (
	"context"

	"doc-platform/server/internal/runs"
)

// RunCtx 随 context 传入 Agent 与工具，携带“这次任务是谁、在哪个会话、正在编辑哪篇文档”，
// 工具据此做权限判断，并把阶段进度写进 SSE 事件日志。
type RunCtx struct {
	UserID    string
	SessionID string
	DocID     string
	Run       *runs.Run
}

type runCtxKey struct{}

func WithRunCtx(ctx context.Context, rc *RunCtx) context.Context {
	return context.WithValue(ctx, runCtxKey{}, rc)
}

func RunCtxFrom(ctx context.Context) *RunCtx {
	rc, _ := ctx.Value(runCtxKey{}).(*RunCtx)
	return rc
}

// Stage 向前端推送一个阶段进度（如“正在审核代码”）；没有 RunCtx 时（如单测）静默忽略。
func Stage(ctx context.Context, callID, stage, message string) {
	if rc := RunCtxFrom(ctx); rc != nil && rc.Run != nil {
		rc.Run.Emit("stage", map[string]any{"callId": callID, "stage": stage, "message": message})
	}
}
