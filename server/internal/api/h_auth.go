package api

import (
	"errors"
	"net/http"
	"regexp"
	"time"

	"github.com/gin-gonic/gin"

	"doc-platform/server/internal/auth"
	"doc-platform/server/internal/store"
)

const tokenTTL = 7 * 24 * time.Hour

var usernameRe = regexp.MustCompile(`^[A-Za-z0-9_-]{3,32}$`)

type credentials struct {
	Username string `json:"username"`
	Password string `json:"password"`
}

func (s *Server) issue(c *gin.Context, u *store.User) {
	token, err := auth.Issue(s.cfg.JWTSecret, u.ID, tokenTTL)
	if err != nil {
		fail(c, http.StatusInternalServerError, "签发令牌失败")
		return
	}
	c.JSON(http.StatusOK, gin.H{"token": token, "user": gin.H{"id": u.ID, "username": u.Username}})
}

func (s *Server) register(c *gin.Context) {
	if !s.cfg.AllowRegister {
		fail(c, http.StatusForbidden, "当前不开放注册")
		return
	}
	var in credentials
	if c.ShouldBindJSON(&in) != nil || !usernameRe.MatchString(in.Username) {
		fail(c, http.StatusBadRequest, "用户名需为 3-32 位字母、数字、下划线或连字符")
		return
	}
	if l := len(in.Password); l < 8 || l > 72 { // bcrypt 只处理前 72 字节
		fail(c, http.StatusBadRequest, "密码长度需为 8-72 位")
		return
	}
	hash, err := auth.HashPassword(in.Password)
	if err != nil {
		fail(c, http.StatusInternalServerError, "服务器内部错误")
		return
	}
	u, err := s.st.CreateUser(in.Username, hash)
	if errors.Is(err, store.ErrConflict) {
		fail(c, http.StatusConflict, "用户名已被占用")
		return
	}
	if err != nil {
		storeErr(c, err)
		return
	}
	s.issue(c, u)
}

// 用户不存在时也做一次 bcrypt 比较，避免通过响应时间探测用户名是否存在
var dummyHash, _ = auth.HashPassword("dummy-password-for-timing")

func (s *Server) login(c *gin.Context) {
	var in credentials
	if c.ShouldBindJSON(&in) != nil {
		fail(c, http.StatusBadRequest, "请求格式错误")
		return
	}
	u, err := s.st.UserByName(in.Username)
	hash := dummyHash
	if err == nil {
		hash = u.PasswordHash
	}
	if !auth.CheckPassword(hash, in.Password) || err != nil {
		fail(c, http.StatusUnauthorized, "用户名或密码错误")
		return
	}
	s.issue(c, u)
}

func (s *Server) me(c *gin.Context) {
	u, err := s.st.UserByID(auth.UserID(c))
	if err != nil {
		fail(c, http.StatusUnauthorized, "登录已失效")
		return
	}
	c.JSON(http.StatusOK, gin.H{"id": u.ID, "username": u.Username})
}
