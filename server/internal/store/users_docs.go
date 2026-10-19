package store

import (
	"database/sql"
	"errors"
)

type User struct {
	ID           string `json:"id"`
	Username     string `json:"username"`
	PasswordHash string `json:"-"`
}

func (s *Store) CreateUser(username, passwordHash string) (*User, error) {
	u := &User{ID: newID(), Username: username, PasswordHash: passwordHash}
	_, err := s.db.Exec(`INSERT INTO users(id, username, password_hash, created_at) VALUES(?,?,?,?)`,
		u.ID, u.Username, u.PasswordHash, now())
	if isUnique(err) {
		return nil, ErrConflict
	}
	return u, err
}

func (s *Store) UserByName(username string) (*User, error) {
	u := &User{}
	err := s.db.QueryRow(`SELECT id, username, password_hash FROM users WHERE username = ?`, username).
		Scan(&u.ID, &u.Username, &u.PasswordHash)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrNotFound
	}
	return u, err
}

func (s *Store) UserByID(id string) (*User, error) {
	u := &User{}
	err := s.db.QueryRow(`SELECT id, username, password_hash FROM users WHERE id = ?`, id).
		Scan(&u.ID, &u.Username, &u.PasswordHash)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrNotFound
	}
	return u, err
}

// ───────────────────────── docs ─────────────────────────

type Doc struct {
	ID        string `json:"id"`
	OwnerID   string `json:"-"`
	Title     string `json:"title"`
	Content   string `json:"-"` // TipTap JSON 原文
	Shared    bool   `json:"shared"`
	UpdatedAt string `json:"updatedAt"`
}

const EmptyDoc = `{"type":"doc","content":[{"type":"paragraph"}]}`

func (s *Store) CreateDoc(ownerID, title string) (*Doc, error) {
	d := &Doc{ID: newID(), OwnerID: ownerID, Title: title, Content: EmptyDoc, UpdatedAt: now()}
	_, err := s.db.Exec(`INSERT INTO docs(id, owner_id, title, content, shared, created_at, updated_at) VALUES(?,?,?,?,0,?,?)`,
		d.ID, d.OwnerID, d.Title, d.Content, d.UpdatedAt, d.UpdatedAt)
	return d, err
}

func (s *Store) GetDoc(id string) (*Doc, error) {
	d := &Doc{}
	var shared int
	err := s.db.QueryRow(`SELECT id, owner_id, title, content, shared, updated_at FROM docs WHERE id = ?`, id).
		Scan(&d.ID, &d.OwnerID, &d.Title, &d.Content, &shared, &d.UpdatedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrNotFound
	}
	d.Shared = shared == 1
	return d, err
}

// ListDocs 只返回元数据，不带正文
func (s *Store) ListDocs(ownerID string) ([]Doc, error) {
	rows, err := s.db.Query(`SELECT id, title, shared, updated_at FROM docs WHERE owner_id = ? ORDER BY updated_at DESC`, ownerID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Doc{}
	for rows.Next() {
		var d Doc
		var shared int
		if err := rows.Scan(&d.ID, &d.Title, &shared, &d.UpdatedAt); err != nil {
			return nil, err
		}
		d.Shared = shared == 1
		out = append(out, d)
	}
	return out, rows.Err()
}

type DocPatch struct {
	Title   *string
	Content *string
	Shared  *bool
}

func (s *Store) UpdateDoc(id, ownerID string, p DocPatch) (*Doc, error) {
	d, err := s.GetDoc(id)
	if err != nil {
		return nil, err
	}
	if d.OwnerID != ownerID {
		return nil, ErrForbidden
	}
	if p.Title != nil {
		d.Title = *p.Title
	}
	if p.Content != nil {
		d.Content = *p.Content
	}
	if p.Shared != nil {
		d.Shared = *p.Shared
	}
	d.UpdatedAt = now()
	shared := 0
	if d.Shared {
		shared = 1
	}
	_, err = s.db.Exec(`UPDATE docs SET title=?, content=?, shared=?, updated_at=? WHERE id=?`,
		d.Title, d.Content, shared, d.UpdatedAt, id)
	return d, err
}

func (s *Store) DeleteDoc(id, ownerID string) error {
	res, err := s.db.Exec(`DELETE FROM docs WHERE id = ? AND owner_id = ?`, id, ownerID)
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return ErrNotFound
	}
	// 文档下的组件解除绑定，但保留组件及其数据（它们仍属于该用户）
	_, err = s.db.Exec(`UPDATE widgets SET doc_id = '' WHERE doc_id = ?`, id)
	return err
}
