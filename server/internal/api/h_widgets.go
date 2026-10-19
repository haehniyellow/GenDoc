package api

import (
	"encoding/json"
	"net/http"
	"regexp"

	"github.com/gin-gonic/gin"

	"doc-platform/server/internal/auth"
	"doc-platform/server/internal/store"
)

// 与前端 protocol.ts 的 WIDGET_KEY_PATTERN / WIDGET_VALUE_MAX_BYTES 保持一致；
// 前端宿主会先校验一遍，这里是不依赖前端的最终校验。
var widgetKeyRe = regexp.MustCompile(`^[A-Za-z0-9_.:-]{1,128}$`)

const widgetValueMaxBytes = 64 * 1024

func (s *Server) listWidgets(c *gin.Context) {
	ws, err := s.st.ListWidgets(auth.UserID(c))
	if err != nil {
		storeErr(c, err)
		return
	}
	c.JSON(http.StatusOK, ws)
}

// accessibleWidget 取组件并校验当前用户有权访问（所有者，或组件所在文档已分享）
func (s *Server) accessibleWidget(c *gin.Context) (*store.Widget, bool) {
	w, err := s.st.GetWidget(c.Param("uuid"))
	if err != nil || !s.st.CanAccessWidget(w, auth.UserID(c)) {
		fail(c, http.StatusNotFound, "组件不存在")
		return nil, false
	}
	return w, true
}

func (s *Server) getWidget(c *gin.Context) {
	w, ok := s.accessibleWidget(c)
	if !ok {
		return
	}
	c.JSON(http.StatusOK, w)
}

func (s *Server) listWidgetKeys(c *gin.Context) {
	w, ok := s.accessibleWidget(c)
	if !ok {
		return
	}
	keys, err := s.st.ListWidgetKeys(w.UUID)
	if err != nil {
		storeErr(c, err)
		return
	}
	c.JSON(http.StatusOK, gin.H{"keys": keys})
}

func validKey(c *gin.Context) (string, bool) {
	k := c.Param("key")
	if !widgetKeyRe.MatchString(k) {
		fail(c, http.StatusBadRequest, "key 不合法")
		return "", false
	}
	return k, true
}

func (s *Server) getWidgetData(c *gin.Context) {
	w, ok := s.accessibleWidget(c)
	if !ok {
		return
	}
	key, ok := validKey(c)
	if !ok {
		return
	}
	v, found, err := s.st.GetWidgetData(w.UUID, key)
	if err != nil {
		storeErr(c, err)
		return
	}
	if !found {
		c.JSON(http.StatusOK, gin.H{"value": nil})
		return
	}
	c.JSON(http.StatusOK, gin.H{"value": json.RawMessage(v)})
}

func (s *Server) putWidgetData(c *gin.Context) {
	w, ok := s.accessibleWidget(c)
	if !ok {
		return
	}
	key, ok := validKey(c)
	if !ok {
		return
	}
	var in struct {
		Value json.RawMessage `json:"value"`
	}
	if c.ShouldBindJSON(&in) != nil || len(in.Value) == 0 {
		fail(c, http.StatusBadRequest, "请求格式错误")
		return
	}
	if len(in.Value) > widgetValueMaxBytes {
		fail(c, http.StatusRequestEntityTooLarge, "数据超过 64KB 上限")
		return
	}
	if err := s.st.SetWidgetData(w.UUID, key, string(in.Value)); err != nil {
		storeErr(c, err)
		return
	}
	c.Status(http.StatusNoContent)
}

func (s *Server) deleteWidgetData(c *gin.Context) {
	w, ok := s.accessibleWidget(c)
	if !ok {
		return
	}
	key, ok := validKey(c)
	if !ok {
		return
	}
	if err := s.st.DeleteWidgetData(w.UUID, key); err != nil {
		storeErr(c, err)
		return
	}
	c.Status(http.StatusNoContent)
}
