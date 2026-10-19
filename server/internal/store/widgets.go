package store

import (
	"database/sql"
	"errors"
)

type Widget struct {
	UUID      string `json:"uuid"`
	OwnerID   string `json:"-"`
	DocID     string `json:"-"`
	Title     string `json:"title"`
	Code      string `json:"code,omitempty"`
	Version   int    `json:"version"`
	UpdatedAt string `json:"updatedAt"`
}

func (s *Store) CreateWidget(ownerID, title, code string) (*Widget, error) {
	w := &Widget{UUID: newID(), OwnerID: ownerID, Title: title, Code: code, Version: 1, UpdatedAt: now()}
	_, err := s.db.Exec(`INSERT INTO widgets(uuid, owner_id, title, code, version, created_at, updated_at) VALUES(?,?,?,?,1,?,?)`,
		w.UUID, w.OwnerID, w.Title, w.Code, w.UpdatedAt, w.UpdatedAt)
	return w, err
}

func (s *Store) GetWidget(uuid string) (*Widget, error) {
	w := &Widget{}
	err := s.db.QueryRow(`SELECT uuid, owner_id, doc_id, title, code, version, updated_at FROM widgets WHERE uuid = ?`, uuid).
		Scan(&w.UUID, &w.OwnerID, &w.DocID, &w.Title, &w.Code, &w.Version, &w.UpdatedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrNotFound
	}
	return w, err
}

func (s *Store) ListWidgets(ownerID string) ([]Widget, error) {
	rows, err := s.db.Query(`SELECT uuid, title, version, updated_at FROM widgets WHERE owner_id = ? ORDER BY updated_at DESC`, ownerID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Widget{}
	for rows.Next() {
		var w Widget
		if err := rows.Scan(&w.UUID, &w.Title, &w.Version, &w.UpdatedAt); err != nil {
			return nil, err
		}
		out = append(out, w)
	}
	return out, rows.Err()
}

// UpdateWidgetCode 覆盖代码并递增版本号；仅所有者可改
func (s *Store) UpdateWidgetCode(uuid, ownerID, title, code string) (*Widget, error) {
	w, err := s.GetWidget(uuid)
	if err != nil {
		return nil, err
	}
	if w.OwnerID != ownerID {
		return nil, ErrForbidden
	}
	if title != "" {
		w.Title = title
	}
	w.Code = code
	w.Version++
	w.UpdatedAt = now()
	_, err = s.db.Exec(`UPDATE widgets SET title=?, code=?, version=?, updated_at=? WHERE uuid=?`,
		w.Title, w.Code, w.Version, w.UpdatedAt, uuid)
	return w, err
}

// BindWidgets 把文档中引用到的组件绑定到该文档（只处理属于 ownerID 的组件）。
// 绑定关系由服务端根据文档内容推导，客户端无法伪造，用于“分享文档 ⇒ 访客可与其中的组件交互”的权限判断。
func (s *Store) BindWidgets(docID, ownerID string, uuids []string) error {
	tx, err := s.db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if _, err := tx.Exec(`UPDATE widgets SET doc_id = '' WHERE doc_id = ? AND owner_id = ?`, docID, ownerID); err != nil {
		return err
	}
	for _, id := range uuids {
		if _, err := tx.Exec(`UPDATE widgets SET doc_id = ? WHERE uuid = ? AND owner_id = ?`, docID, id, ownerID); err != nil {
			return err
		}
	}
	return tx.Commit()
}

// CanAccessWidget：所有者，或组件所在文档已分享给所有登录用户。
// 访客对已分享文档里的组件拥有读写数据的权限（例如投票、打卡），但不能修改组件代码。
func (s *Store) CanAccessWidget(w *Widget, userID string) bool {
	if w.OwnerID == userID {
		return true
	}
	if w.DocID == "" {
		return false
	}
	d, err := s.GetDoc(w.DocID)
	return err == nil && d.Shared
}

// ───────────────────────── widget data ─────────────────────────

func (s *Store) GetWidgetData(uuid, key string) (string, bool, error) {
	var v string
	err := s.db.QueryRow(`SELECT value FROM widget_data WHERE widget_uuid = ? AND key = ?`, uuid, key).Scan(&v)
	if errors.Is(err, sql.ErrNoRows) {
		return "", false, nil
	}
	return v, err == nil, err
}

func (s *Store) SetWidgetData(uuid, key, valueJSON string) error {
	var n int
	var exists int
	if err := s.db.QueryRow(`SELECT COUNT(*) FROM widget_data WHERE widget_uuid = ?`, uuid).Scan(&n); err != nil {
		return err
	}
	if err := s.db.QueryRow(`SELECT COUNT(*) FROM widget_data WHERE widget_uuid = ? AND key = ?`, uuid, key).Scan(&exists); err != nil {
		return err
	}
	if exists == 0 && n >= MaxKeysPerWidget {
		return ErrLimit
	}
	_, err := s.db.Exec(`INSERT INTO widget_data(widget_uuid, key, value, updated_at) VALUES(?,?,?,?)
		ON CONFLICT(widget_uuid, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
		uuid, key, valueJSON, now())
	return err
}

func (s *Store) DeleteWidgetData(uuid, key string) error {
	_, err := s.db.Exec(`DELETE FROM widget_data WHERE widget_uuid = ? AND key = ?`, uuid, key)
	return err
}

func (s *Store) ListWidgetKeys(uuid string) ([]string, error) {
	rows, err := s.db.Query(`SELECT key FROM widget_data WHERE widget_uuid = ? ORDER BY key`, uuid)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	keys := []string{}
	for rows.Next() {
		var k string
		if err := rows.Scan(&k); err != nil {
			return nil, err
		}
		keys = append(keys, k)
	}
	return keys, rows.Err()
}
