package main

import (
	"context"
	"errors"
	"log"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"doc-platform/server/internal/ai"
	"doc-platform/server/internal/api"
	"doc-platform/server/internal/config"
	"doc-platform/server/internal/runs"
	"doc-platform/server/internal/store"
)

func main() {
	cfg := config.Load()

	st, err := store.Open(cfg.DataDir)
	if err != nil {
		log.Fatalf("打开数据库失败: %v", err)
	}
	defer st.Close()

	ctx := context.Background()
	llm, err := ai.NewChatModel(ctx, cfg)
	if err != nil {
		log.Fatalf("初始化模型失败: %v", err)
	}
	agent, err := ai.NewAgent(ctx, llm, st)
	if err != nil {
		log.Fatalf("初始化 Agent 失败: %v", err)
	}

	srv := &http.Server{
		Addr:              cfg.Addr,
		Handler:           api.New(cfg, st, runs.NewManager(10*time.Minute), agent).Router(),
		ReadHeaderTimeout: 10 * time.Second,
		// 不设置 WriteTimeout：SSE 是长连接，写超时会把正常的流式响应截断
	}

	go func() {
		log.Printf("服务已启动 %s（数据目录 %s）", cfg.Addr, cfg.DataDir)
		if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			log.Fatalf("服务异常退出: %v", err)
		}
	}()

	stop := make(chan os.Signal, 1)
	signal.Notify(stop, os.Interrupt, syscall.SIGTERM)
	<-stop
	shutdownCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	_ = srv.Shutdown(shutdownCtx)
}
