package api

import (
	"errors"
	"net/http"
	"sync"

	"github.com/gin-gonic/gin"

	"doc-platform/server/internal/ai"
	"doc-platform/server/internal/auth"
	"doc-platform/server/internal/config"
	"doc-platform/server/internal/runs"
	"doc-platform/server/internal/store"
)

type Server struct {
	cfg   config.Config
	st    *store.Store
	runs  *runs.Manager
	agent *ai.Agent

	// 串行化“检查会话是否有进行中的任务 → 写入用户消息 → 启动任务”，避免同一会话并发启动两个任务
	startMu sync.Mutex
}

func New(cfg config.Config, st *store.Store, rm *runs.Manager, agent *ai.Agent) *Server {
	return &Server{cfg: cfg, st: st, runs: rm, agent: agent}
}

const maxBodyBytes = 3 << 20

func (s *Server) Router() *gin.Engine {
	gin.SetMode(gin.ReleaseMode)
	r := gin.New()
	r.Use(gin.Recovery(), gin.Logger(), func(c *gin.Context) {
		c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, maxBodyBytes)
		c.Next()
	})

	r.GET("/healthz", func(c *gin.Context) { c.JSON(http.StatusOK, gin.H{"ok": true, "mockLLM": s.cfg.UseMock()}) })

	api := r.Group("/api")
	api.POST("/auth/register", s.register)
	api.POST("/auth/login", s.login)

	authed := api.Group("", auth.Middleware(s.cfg.JWTSecret))
	authed.GET("/auth/me", s.me)

	authed.GET("/docs", s.listDocs)
	authed.POST("/docs", s.createDoc)
	authed.GET("/docs/:id", s.getDoc)
	authed.PUT("/docs/:id", s.updateDoc)
	authed.DELETE("/docs/:id", s.deleteDoc)

	authed.GET("/widgets", s.listWidgets)
	authed.GET("/widgets/:uuid", s.getWidget)
	authed.GET("/widgets/:uuid/data", s.listWidgetKeys)
	authed.GET("/widgets/:uuid/data/:key", s.getWidgetData)
	authed.PUT("/widgets/:uuid/data/:key", s.putWidgetData)
	authed.DELETE("/widgets/:uuid/data/:key", s.deleteWidgetData)

	authed.GET("/ai/sessions", s.listSessions)
	authed.POST("/ai/sessions", s.createSession)
	authed.GET("/ai/sessions/:id", s.getSession)
	authed.DELETE("/ai/sessions/:id", s.deleteSession)
	authed.POST("/ai/sessions/:id/messages", s.sendMessage)
	authed.GET("/ai/runs/:id/events", s.streamRun)
	authed.POST("/ai/runs/:id/cancel", s.cancelRun)
	authed.POST("/ai/rewrite", s.rewrite)
	return r
}

func fail(c *gin.Context, status int, msg string) {
	c.AbortWithStatusJSON(status, gin.H{"error": msg})
}

// storeErr 把存储层的哨兵错误映射成 HTTP 状态码。找不到与无权访问统一返回 404，避免泄露资源是否存在。
func storeErr(c *gin.Context, err error) {
	switch {
	case errors.Is(err, store.ErrNotFound), errors.Is(err, store.ErrForbidden):
		fail(c, http.StatusNotFound, "资源不存在")
	case errors.Is(err, store.ErrConflict):
		fail(c, http.StatusConflict, "资源冲突")
	case errors.Is(err, store.ErrLimit):
		fail(c, http.StatusRequestEntityTooLarge, "超出数量上限")
	default:
		c.Error(err) //nolint:errcheck
		fail(c, http.StatusInternalServerError, "服务器内部错误")
	}
}
