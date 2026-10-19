package runs

import (
	"context"
	"errors"
	"testing"
	"time"
)

func waitDone(t *testing.T, r *Run) {
	t.Helper()
	deadline := time.After(2 * time.Second)
	for !r.IsDone() {
		select {
		case <-deadline:
			t.Fatal("run did not finish")
		case <-time.After(5 * time.Millisecond):
		}
	}
}

func TestReplayFromAnySeq(t *testing.T) {
	m := NewManager(time.Minute)
	r := m.Start("s1", "u1", "c1", func(ctx context.Context, r *Run) error {
		for i := 0; i < 3; i++ {
			r.Emit("text.delta", map[string]any{"text": "x"})
		}
		return nil
	})
	waitDone(t, r)

	all, done, _ := r.Since(0)
	if !done {
		t.Fatal("expected done")
	}
	// run.start + 3 deltas + run.done
	if len(all) != 5 || all[0].Type != TypeStart || all[4].Type != TypeDone {
		t.Fatalf("events = %+v", all)
	}
	for i, e := range all {
		if e.Seq != i+1 {
			t.Fatalf("seq must be contiguous from 1, got %d at %d", e.Seq, i)
		}
	}
	// 断线后从 seq=2 续传：只拿到之后的事件，不重复
	rest, _, _ := r.Since(2)
	if len(rest) != 3 || rest[0].Seq != 3 {
		t.Fatalf("resume from 2 = %+v", rest)
	}
	if none, _, _ := r.Since(5); len(none) != 0 {
		t.Fatal("nothing after the last seq")
	}
}

func TestSubscriberWokenByNewEvents(t *testing.T) {
	m := NewManager(time.Minute)
	release := make(chan struct{})
	r := m.Start("s1", "u1", "c1", func(ctx context.Context, r *Run) error {
		<-release
		r.Emit("text.delta", map[string]any{"text": "late"})
		return nil
	})
	_, _, wait := r.Since(1) // 只看到 run.start
	select {
	case <-wait:
		t.Fatal("must not wake before new event")
	case <-time.After(30 * time.Millisecond):
	}
	close(release)
	select {
	case <-wait:
	case <-time.After(time.Second):
		t.Fatal("subscriber was not woken")
	}
}

func TestErrorAndPanicBecomeRunError(t *testing.T) {
	m := NewManager(time.Minute)
	r := m.Start("s1", "u1", "c1", func(ctx context.Context, r *Run) error { return errors.New("boom") })
	waitDone(t, r)
	evs, _, _ := r.Since(0)
	if last := evs[len(evs)-1]; last.Type != TypeError {
		t.Fatalf("last = %s", last.Type)
	}

	r2 := m.Start("s2", "u1", "c2", func(ctx context.Context, r *Run) error { panic("x") })
	waitDone(t, r2)
	evs, _, _ = r2.Since(0)
	if evs[len(evs)-1].Type != TypeError {
		t.Fatal("panic must be reported as run.error, not crash the server")
	}
}

func TestActiveAndIdempotencyLookups(t *testing.T) {
	m := NewManager(20 * time.Millisecond)
	release := make(chan struct{})
	r := m.Start("s1", "u1", "client-1", func(ctx context.Context, r *Run) error { <-release; return nil })

	if m.Active("s1") != r || m.ByClientMsg("s1", "client-1") != r || m.Get(r.ID) != r {
		t.Fatal("lookups should find the running run")
	}
	close(release)
	waitDone(t, r)
	if m.Active("s1") != nil {
		t.Fatal("finished run must not be active")
	}
	if m.ByClientMsg("s1", "client-1") != r {
		t.Fatal("finished run stays available for dedupe during retention window")
	}
	time.Sleep(80 * time.Millisecond)
	if m.Get(r.ID) != nil || m.ByClientMsg("s1", "client-1") != nil {
		t.Fatal("run should be evicted after retention")
	}
}

func TestCancel(t *testing.T) {
	m := NewManager(time.Minute)
	r := m.Start("s1", "u1", "c1", func(ctx context.Context, r *Run) error {
		<-ctx.Done()
		return nil
	})
	r.Cancel()
	waitDone(t, r)
}

func TestEmitAfterFinishIgnored(t *testing.T) {
	m := NewManager(time.Minute)
	r := m.Start("s1", "u1", "c1", func(ctx context.Context, r *Run) error { return nil })
	waitDone(t, r)
	before, _, _ := r.Since(0)
	r.Emit("text.delta", map[string]any{"text": "late"})
	after, _, _ := r.Since(0)
	if len(before) != len(after) {
		t.Fatal("events after terminal event must be dropped")
	}
}
