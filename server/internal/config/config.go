package config

import (
	"bufio"
	"crypto/rand"
	"encoding/hex"
	"log"
	"os"
	"path/filepath"
	"strconv"
	"strings"
)

type Config struct {
	Addr          string
	DataDir       string
	JWTSecret     string
	AllowRegister bool

	// OpenAI 兼容接口。APIKey 为空时自动退回到内置 Mock 模型，便于无 key 联调整条链路。
	OpenAIAPIKey  string
	OpenAIBaseURL string
	OpenAIModel   string
	ForceMock     bool
}

func (c Config) UseMock() bool { return c.ForceMock || c.OpenAIAPIKey == "" }

// Load 读取环境变量；若当前目录或上级目录存在 .env 会先加载（不覆盖已有环境变量）。
func Load() Config {
	loadDotEnv(".env")
	loadDotEnv(filepath.Join("..", ".env"))

	c := Config{
		Addr:          env("ADDR", ":8080"),
		DataDir:       env("DATA_DIR", "./data"),
		JWTSecret:     os.Getenv("JWT_SECRET"),
		AllowRegister: envBool("ALLOW_REGISTER", true),
		OpenAIAPIKey:  os.Getenv("OPENAI_API_KEY"),
		OpenAIBaseURL: env("OPENAI_BASE_URL", "https://api.openai.com/v1"),
		OpenAIModel:   env("OPENAI_MODEL", "gpt-4o-mini"),
		ForceMock:     envBool("LLM_MOCK", false),
	}
	if c.JWTSecret == "" {
		// 未配置时每次启动生成随机密钥：重启后旧 token 失效，但不会因为默认弱密钥造成风险
		b := make([]byte, 32)
		_, _ = rand.Read(b)
		c.JWTSecret = hex.EncodeToString(b)
		log.Println("[config] JWT_SECRET 未设置，已生成临时密钥（重启后需要重新登录）")
	}
	return c
}

func env(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}

func envBool(key string, def bool) bool {
	if v := os.Getenv(key); v != "" {
		if b, err := strconv.ParseBool(v); err == nil {
			return b
		}
	}
	return def
}

func loadDotEnv(path string) {
	f, err := os.Open(path)
	if err != nil {
		return
	}
	defer f.Close()
	sc := bufio.NewScanner(f)
	for sc.Scan() {
		line := strings.TrimSpace(sc.Text())
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		k, v, ok := strings.Cut(line, "=")
		if !ok {
			continue
		}
		k = strings.TrimSpace(k)
		v = strings.Trim(strings.TrimSpace(v), `"'`)
		if _, exists := os.LookupEnv(k); !exists {
			_ = os.Setenv(k, v)
		}
	}
}
