package api

import (
	"encoding/json"
	"net/http"
	"strings"
	"unicode/utf8"

	"github.com/gin-gonic/gin"

	"doc-platform/server/internal/ai"
	"doc-platform/server/internal/auth"
	"doc-platform/server/internal/store"
)

type docOut struct {
	ID        string          `json:"id"`
	Title     string          `json:"title"`
	Shared    bool            `json:"shared"`
	UpdatedAt string          `json:"updatedAt"`
	Content   json.RawMessage `json:"content,omitempty"`
	CanEdit   bool            `json:"canEdit"`
}

func toDocOut(d *store.Doc, userID string, withContent bool) docOut {
	out := docOut{ID: d.ID, Title: d.Title, Shared: d.Shared, UpdatedAt: d.UpdatedAt, CanEdit: d.OwnerID == userID}
	if withContent {
		out.Content = json.RawMessage(d.Content)
	}
	return out
}

func (s *Server) listDocs(c *gin.Context) {
	docs, err := s.st.ListDocs(auth.UserID(c))
	if err != nil {
		storeErr(c, err)
		return
	}
	out := make([]docOut, len(docs))
	for i := range docs {
		out[i] = toDocOut(&docs[i], auth.UserID(c), false)
	}
	c.JSON(http.StatusOK, out)
}

func (s *Server) createDoc(c *gin.Context) {
	var in struct {
		Title string `json:"title"`
	}
	_ = c.ShouldBindJSON(&in)
	title := strings.TrimSpace(in.Title)
	if title == "" {
		title = "无标题文档"
	}
	if utf8.RuneCountInString(title) > 100 {
		fail(c, http.StatusBadRequest, "标题过长")
		return
	}
	d, err := s.st.CreateDoc(auth.UserID(c), title)
	if err != nil {
		storeErr(c, err)
		return
	}
	c.JSON(http.StatusOK, toDocOut(d, auth.UserID(c), true))
}

// 文档对所有者可见；已分享（shared）的文档对所有登录用户只读可见
func (s *Server) getDoc(c *gin.Context) {
	uid := auth.UserID(c)
	d, err := s.st.GetDoc(c.Param("id"))
	if err != nil || (d.OwnerID != uid && !d.Shared) {
		fail(c, http.StatusNotFound, "文档不存在")
		return
	}
	c.JSON(http.StatusOK, toDocOut(d, uid, true))
}

func (s *Server) updateDoc(c *gin.Context) {
	uid := auth.UserID(c)
	var in struct {
		Title   *string         `json:"title"`
		Content json.RawMessage `json:"content"`
		Shared  *bool           `json:"shared"`
	}
	if c.ShouldBindJSON(&in) != nil {
		fail(c, http.StatusBadRequest, "请求格式错误")
		return
	}
	patch := store.DocPatch{Title: in.Title, Shared: in.Shared}
	if in.Title != nil {
		t := strings.TrimSpace(*in.Title)
		if t == "" || utf8.RuneCountInString(t) > 100 {
			fail(c, http.StatusBadRequest, "标题不能为空且不超过 100 字")
			return
		}
		patch.Title = &t
	}
	var widgetIDs []string
	if len(in.Content) > 0 {
		var probe struct {
			Type string `json:"type"`
		}
		if json.Unmarshal(in.Content, &probe) != nil || probe.Type != "doc" {
			fail(c, http.StatusBadRequest, "文档内容格式错误")
			return
		}
		raw := string(in.Content)
		patch.Content = &raw
		widgetIDs = ai.ExtractWidgetIDs(raw)
	}

	d, err := s.st.UpdateDoc(c.Param("id"), uid, patch)
	if err != nil {
		storeErr(c, err)
		return
	}
	// 组件与文档的绑定由服务端从内容里推导，客户端无法伪造
	if patch.Content != nil {
		if err := s.st.BindWidgets(d.ID, uid, widgetIDs); err != nil {
			storeErr(c, err)
			return
		}
	}
	c.JSON(http.StatusOK, toDocOut(d, uid, false))
}

func (s *Server) deleteDoc(c *gin.Context) {
	if err := s.st.DeleteDoc(c.Param("id"), auth.UserID(c)); err != nil {
		storeErr(c, err)
		return
	}
	c.Status(http.StatusNoContent)
}
