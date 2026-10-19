package store

import (
	"database/sql"
	"errors"
	"unicode/utf8"
)

type Session struct {
	ID        string `json:"id"`
	UserID    string `json:"-"`
	Title     string `json:"title"`
	UpdatedAt string `json:"updatedAt"`
}

type Message struct {
	ID          string `json:"id"`
	SessionID   string `json:"-"`
	Role        string `json:"role"`
	Content     string `json:"content"`
	Meta        string `json:"-"` // JSON，见 ai.MessageMeta
	ClientMsgID string `json:"-"`
	CreatedAt   string `json:"createdAt"`
}

func (s *Store) CreateSession(userID string) (*Session, error) {
	ss := &Session{ID: newID(), UserID: userID, Title: "新对话", UpdatedAt: now()}
	_, err := s.db.Exec(`INSERT INTO sessions(id, user_id, title, created_at, updated_at) VALUES(?,?,?,?,?)`,
		ss.ID, ss.UserID, ss.Title, ss.UpdatedAt, ss.UpdatedAt)
	return ss, err
}

func (s *Store) GetSession(id string) (*Session, error) {
	ss := &Session{}
	err := s.db.QueryRow(`SELECT id, user_id, title, updated_at FROM sessions WHERE id = ?`, id).
		Scan(&ss.ID, &ss.UserID, &ss.Title, &ss.UpdatedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrNotFound
	}
	return ss, err
}

func (s *Store) ListSessions(userID string) ([]Session, error) {
	rows, err := s.db.Query(`SELECT id, title, updated_at FROM sessions WHERE user_id = ? ORDER BY updated_at DESC LIMIT 100`, userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Session{}
	for rows.Next() {
		var ss Session
		if err := rows.Scan(&ss.ID, &ss.Title, &ss.UpdatedAt); err != nil {
			return nil, err
		}
		out = append(out, ss)
	}
	return out, rows.Err()
}

func (s *Store) DeleteSession(id, userID string) error {
	res, err := s.db.Exec(`DELETE FROM sessions WHERE id = ? AND user_id = ?`, id, userID)
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return ErrNotFound
	}
	_, err = s.db.Exec(`DELETE FROM messages WHERE session_id = ?`, id)
	return err
}

func (s *Store) Messages(sessionID string) ([]Message, error) {
	rows, err := s.db.Query(`SELECT id, role, content, meta, created_at FROM messages WHERE session_id = ? ORDER BY seq`, sessionID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Message{}
	for rows.Next() {
		var m Message
		if err := rows.Scan(&m.ID, &m.Role, &m.Content, &m.Meta, &m.CreatedAt); err != nil {
			return nil, err
		}
		m.SessionID = sessionID
		out = append(out, m)
	}
	return out, rows.Err()
}

// MessageExists 用于按 clientMsgID 做幂等判断
func (s *Store) MessageExists(sessionID, clientMsgID string) (bool, error) {
	var n int
	err := s.db.QueryRow(`SELECT COUNT(*) FROM messages WHERE session_id = ? AND client_msg_id = ?`, sessionID, clientMsgID).Scan(&n)
	return n > 0, err
}

// AppendMessage 追加一条消息并刷新会话时间；首条用户消息会顺便生成会话标题。
// clientMsgID 非空时受唯一索引保护，重复提交返回 ErrConflict。
func (s *Store) AppendMessage(sessionID, role, content, meta, clientMsgID string) (*Message, error) {
	m := &Message{ID: newID(), SessionID: sessionID, Role: role, Content: content, Meta: meta, ClientMsgID: clientMsgID, CreatedAt: now()}
	var cid any
	if clientMsgID != "" {
		cid = clientMsgID
	}
	tx, err := s.db.Begin()
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	if _, err := tx.Exec(`INSERT INTO messages(id, session_id, role, content, meta, client_msg_id, created_at) VALUES(?,?,?,?,?,?,?)`,
		m.ID, sessionID, role, content, meta, cid, m.CreatedAt); err != nil {
		if isUnique(err) {
			return nil, ErrConflict
		}
		return nil, err
	}
	if role == "user" {
		if _, err := tx.Exec(`UPDATE sessions SET title = ? WHERE id = ? AND title = '新对话'`, truncateRunes(content, 24), sessionID); err != nil {
			return nil, err
		}
	}
	if _, err := tx.Exec(`UPDATE sessions SET updated_at = ? WHERE id = ?`, m.CreatedAt, sessionID); err != nil {
		return nil, err
	}
	return m, tx.Commit()
}

func truncateRunes(s string, n int) string {
	if utf8.RuneCountInString(s) <= n {
		return s
	}
	r := []rune(s)
	return string(r[:n]) + "…"
}
