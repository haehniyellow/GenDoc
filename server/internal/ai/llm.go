package ai

import (
	"context"
	"log"

	"github.com/cloudwego/eino-ext/components/model/openai"
	"github.com/cloudwego/eino/components/model"

	"doc-platform/server/internal/config"
)

// NewChatModel 按配置创建模型：配置了 OPENAI_API_KEY 用 OpenAI 兼容接口（DeepSeek / 通义 / 智谱 / OpenAI 等均可，
// 改 OPENAI_BASE_URL 与 OPENAI_MODEL 即可），否则使用内置 Mock，方便无 key 联调。
func NewChatModel(ctx context.Context, cfg config.Config) (model.ToolCallingChatModel, error) {
	if cfg.UseMock() {
		log.Println("[ai] 使用 Mock 模型（未设置 OPENAI_API_KEY，或 LLM_MOCK=true）。生成结果是固定模板，仅用于联调。")
		return &MockModel{}, nil
	}
	log.Printf("[ai] 使用 OpenAI 兼容模型 %s @ %s", cfg.OpenAIModel, cfg.OpenAIBaseURL)
	return openai.NewChatModel(ctx, &openai.ChatModelConfig{
		APIKey:  cfg.OpenAIAPIKey,
		BaseURL: cfg.OpenAIBaseURL,
		Model:   cfg.OpenAIModel,
	})
}
