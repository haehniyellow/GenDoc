package auth

import (
	"errors"
	"net/http"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/golang-jwt/jwt/v5"
	"golang.org/x/crypto/bcrypt"
)

const ctxUserKey = "userID"

func HashPassword(pw string) (string, error) {
	b, err := bcrypt.GenerateFromPassword([]byte(pw), bcrypt.DefaultCost)
	return string(b), err
}

func CheckPassword(hash, pw string) bool {
	return bcrypt.CompareHashAndPassword([]byte(hash), []byte(pw)) == nil
}

type claims struct {
	jwt.RegisteredClaims
}

func Issue(secret, userID string, ttl time.Duration) (string, error) {
	c := claims{RegisteredClaims: jwt.RegisteredClaims{
		Subject:   userID,
		IssuedAt:  jwt.NewNumericDate(time.Now()),
		ExpiresAt: jwt.NewNumericDate(time.Now().Add(ttl)),
	}}
	return jwt.NewWithClaims(jwt.SigningMethodHS256, c).SignedString([]byte(secret))
}

func parse(secret, token string) (string, error) {
	var c claims
	// 显式限定算法，防止 alg=none / 算法混淆
	t, err := jwt.ParseWithClaims(token, &c, func(*jwt.Token) (any, error) { return []byte(secret), nil },
		jwt.WithValidMethods([]string{"HS256"}))
	if err != nil || !t.Valid || c.Subject == "" {
		return "", errors.New("invalid token")
	}
	return c.Subject, nil
}

// Middleware 校验 Authorization: Bearer <jwt>，通过后把用户 ID 放进 gin.Context
func Middleware(secret string) gin.HandlerFunc {
	return func(c *gin.Context) {
		h := c.GetHeader("Authorization")
		token, ok := strings.CutPrefix(h, "Bearer ")
		if !ok || token == "" {
			c.AbortWithStatusJSON(http.StatusUnauthorized, gin.H{"error": "未登录"})
			return
		}
		uid, err := parse(secret, token)
		if err != nil {
			c.AbortWithStatusJSON(http.StatusUnauthorized, gin.H{"error": "登录已失效"})
			return
		}
		c.Set(ctxUserKey, uid)
		c.Next()
	}
}

func UserID(c *gin.Context) string { return c.GetString(ctxUserKey) }
