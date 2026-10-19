// Package runs 管理“后台 AI 生成任务”。
//
// 设计要点（对应前端的断线续传 / 刷新不中断 / 不重复执行）：
//   - 任务在独立 goroutine 中运行，生命周期与发起它的 HTTP 请求无关，刷新页面不会取消任务
//   - 每个任务维护一份带序号（seq）的事件日志；SSE 连接只是这份日志的“订阅者”，
//     可以从任意 seq 之后重放，因此断线重连、多标签页同时观看都不会漏事件
//   - 任务结束后日志再保留一段时间，覆盖“刚结束就重连”的窗口；之后以数据库里的消息为准
//   - 同一会话同一时刻只允许一个进行中的任务；同一个 clientMessageId 重复提交返回同一个 run
//
// 思路参考 vercel/resumable-stream（stream id + 偏移量续传），这里因为是单进程服务，
// 用内存日志代替 Redis pub/sub。多实例部署时需要把日志换成 Redis Stream 等共享存储。
package runs

import (
	"context"
	"encoding/json"
	"sync"
	"time"

	"github.com/google/uuid"
)

const (
	TypeStart = "run.start"
	TypeDone  = "run.done"
	TypeError = "run.error"
)

type Event struct {
	Seq  int
	Type string
	Data []byte // 完整 JSON，含 type 字段
}

type Run struct {
	ID          string
	SessionID   string
	UserID      string
	ClientMsgID string

	mu     sync.Mutex
	events []Event
	done   bool
	notify chan struct{} // 每次有新事件时关闭并重建，订阅者据此被唤醒
	cancel context.CancelFunc
}

// Emit 追加一个事件。payload 中的键会与 type 一起序列化。
func (r *Run) Emit(typ string, payload map[string]any) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.done {
		return
	}
	r.append(typ, payload)
}

func (r *Run) append(typ string, payload map[string]any) {
	if payload == nil {
		payload = map[string]any{}
	}
	payload["type"] = typ
	data, _ := json.Marshal(payload)
	r.events = append(r.events, Event{Seq: len(r.events) + 1, Type: typ, Data: data})
	close(r.notify)
	r.notify = make(chan struct{})
}

// Finish 写入终止事件并关闭任务。errMsg 非空时为 run.error。
func (r *Run) Finish(errMsg string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.done {
		return
	}
	if errMsg != "" {
		r.append(TypeError, map[string]any{"message": errMsg})
	} else {
		r.append(TypeDone, nil)
	}
	r.done = true
}

// Since 返回 seq 大于 after 的事件，任务是否已结束，以及一个在有新事件时被关闭的 channel。
func (r *Run) Since(after int) (events []Event, done bool, wait <-chan struct{}) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if after < 0 {
		after = 0
	}
	if after < len(r.events) {
		events = append(events, r.events[after:]...)
	}
	return events, r.done, r.notify
}

func (r *Run) IsDone() bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.done
}

func (r *Run) Cancel() {
	if r.cancel != nil {
		r.cancel()
	}
}

type Manager struct {
	mu        sync.Mutex
	runs      map[string]*Run
	bySession map[string]*Run // 会话当前进行中的任务
	byClient  map[string]*Run // sessionID + "\x00" + clientMsgID
	retain    time.Duration
}

func NewManager(retain time.Duration) *Manager {
	return &Manager{
		runs:      map[string]*Run{},
		bySession: map[string]*Run{},
		byClient:  map[string]*Run{},
		retain:    retain,
	}
}

func clientKey(sessionID, clientMsgID string) string { return sessionID + "\x00" + clientMsgID }

func (m *Manager) Get(id string) *Run {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.runs[id]
}

// Active 返回会话中仍在运行的任务
func (m *Manager) Active(sessionID string) *Run {
	m.mu.Lock()
	defer m.mu.Unlock()
	r := m.bySession[sessionID]
	if r != nil && r.IsDone() {
		return nil
	}
	return r
}

func (m *Manager) ByClientMsg(sessionID, clientMsgID string) *Run {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.byClient[clientKey(sessionID, clientMsgID)]
}

// Start 注册并异步启动任务。fn 返回 error 或 panic 都会转成 run.error；正常返回则 run.done。
// fn 自己负责在返回前完成持久化，这样客户端收到 run.done 后立刻拉会话就能看到完整消息。
func (m *Manager) Start(sessionID, userID, clientMsgID string, fn func(ctx context.Context, r *Run) error) *Run {
	ctx, cancel := context.WithCancel(context.Background())
	r := &Run{
		ID: uuid.NewString(), SessionID: sessionID, UserID: userID, ClientMsgID: clientMsgID,
		notify: make(chan struct{}), cancel: cancel,
	}
	m.mu.Lock()
	m.runs[r.ID] = r
	m.bySession[sessionID] = r
	if clientMsgID != "" {
		m.byClient[clientKey(sessionID, clientMsgID)] = r
	}
	m.mu.Unlock()

	r.Emit(TypeStart, map[string]any{"runId": r.ID})

	go func() {
		defer cancel()
		defer func() {
			if p := recover(); p != nil {
				r.Finish("内部错误")
			}
			m.scheduleCleanup(r)
		}()
		if err := fn(ctx, r); err != nil {
			r.Finish(err.Error())
			return
		}
		r.Finish("")
	}()
	return r
}

func (m *Manager) scheduleCleanup(r *Run) {
	time.AfterFunc(m.retain, func() {
		m.mu.Lock()
		defer m.mu.Unlock()
		delete(m.runs, r.ID)
		if m.bySession[r.SessionID] == r {
			delete(m.bySession, r.SessionID)
		}
		delete(m.byClient, clientKey(r.SessionID, r.ClientMsgID))
	})
}
