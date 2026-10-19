# 知识管理与分享的 AI 内容平台

支持文章编辑、个人知识库，以及由 Agent + Skill 驱动的文章生成与修改；提供「随心搭」——把自然语言需求变成带状态、可交互、数据可持久化的自定义组件，并嵌入文档中运行。

**技术栈**：React 19 · TypeScript · Zustand · Vite · TipTap 3 · Go · Gin · [Eino](https://github.com/cloudwego/eino) · SQLite

参考了哪些开源项目、借鉴了什么、踩过哪些坑：见 [docs/REFERENCES.md](docs/REFERENCES.md)。

## 快速开始

需要 Node ≥ 20.19、pnpm ≥ 10、Go ≥ 1.26（更低版本的 Go 会通过 `GOTOOLCHAIN` 自动下载）。

```bash
pnpm install
pnpm dev          # 一条命令：Go 后端（:8080）+ Web 前端（:5173），并自动打开浏览器
```

首次运行会自动从 `.env.example` 生成 `.env`（默认使用 Mock 模型，无需 API key；JWT 密钥随机生成）。
打开后先注册一个账号：顶栏「文档」是文章与知识库，「AI 对话」是 Agent 对话，**两者是同一个站点、共用一次登录**。
`Ctrl+C` 会同时停止前后端。不想自动打开浏览器：`BROWSER=none pnpm dev`。

也可以分开启动：`pnpm dev:server`（后端）、`pnpm dev:web`（前端）。

国内网络下载 Go 依赖较慢时：`go env -w GOPROXY=https://goproxy.cn,direct`。

**接入真实模型**：在 `.env` 里注释掉 `LLM_MOCK`，填 `OPENAI_API_KEY` / `OPENAI_BASE_URL` / `OPENAI_MODEL`。任何 OpenAI 兼容接口都可以（OpenAI、DeepSeek、通义、智谱、自建网关）。**Mock 模型只返回固定模板**，用来验证链路，不代表真实模型的生成质量——真实模型下的生成质量、审核误报率、重试次数都还没有测过。

## 目录结构（pnpm monorepo）

```
apps/
  web/             唯一的 Web 应用，路由级懒加载：
                     /          文档列表
                     /doc/:id   编辑器 + 右侧 AI 面板
                     /chat      AI 对话（会话历史、组件预览，可把组件插入任意文档）
packages/
  shared/          前后端共用协议：RunEvent、RPC 消息、API 客户端、SSE 解析器
  widget-runtime/  动态组件运行时：Worker 编译 + 缓存、iframe 沙箱、postMessage RPC 桥
  ai-chat/         对话面板：Zustand store、断线续传的 SSE 客户端、组件预览卡片
  editor/          TipTap 编辑器：自定义 widget 节点（可拖拽缩放）、AI 改写预览
  ui/              登录门与基础样式
server/            Go：Gin + Eino Agent + SQLite
config/            Vite 公共配置（分析 / CDN / 分包）
scripts/dev.mjs    `pnpm dev` 的实现：启动后端 + 前端，合并日志，退出时清理子进程
```

Monorepo 的复用体现在 `packages/`：`/chat` 页面与 `/doc/:id` 的 AI 侧边栏用的是同一个 `@doc/ai-chat` 对话面板；组件的运行时（`@doc/widget-runtime`）、协议与 API 客户端（`@doc/shared`）被对话预览卡片和编辑器里的组件块共同使用。

## 核心机制

### 1. 随心搭：从自然语言到沙箱里运行的组件

```
需求 ──▶ Agent 调 create_widget ──▶ 生成 JSX ──▶ 静态快筛 ──▶ 独立审核 Agent ──▶ 入库
                                      ▲              │             │
                                      └──── 带反馈重试（最多 2 次）◀──┘
入库后： 代码 ──▶ Worker 编译(Sucrase, 按内容哈希缓存) ──▶ 内联 srcdoc ──▶ sandbox iframe
```

- **受控生成**（`server/internal/ai/prompts.go`）：Prompt 限定只输出一个 jsx 代码块、只能导入 `react` 和 `@sdk`、列出全部禁用项与 SDK 用法。
- **独立审核 Agent**（`widgetgen.go`）：另起一次模型调用，用不同的系统提示、看不到生成过程，检查语义 / 安全绕过（字符串拼接、`constructor.constructor`、伪造 postMessage 等）/ 需求符合度，输出 JSON。**输出无法解析时按"未通过"处理（失败即关闭）**，出现 high 级别问题时无论模型说 pass 与否都不通过。
- **局部修改**（`patch.go`）：`modify_widget` 让模型输出 `SEARCH/REPLACE` 块并精确应用；任何一块匹配不到或出现多处命中就整体失败，回退为整段重写。省 token，也不会误伤无关代码。
- **编译放进 Web Worker，结果缓存**（`compiler.ts`）：按 SHA-256 内容哈希做内存 LRU + localStorage 两级缓存，并发编译同一份代码合并为一次。

### 2. 运行时 SDK 与数据持久化

沙箱内只有 `react` 与 `@sdk`：

```jsx
import { useWidgetState } from '@sdk'
const [items, setItems, { loading }] = useWidgetState('items', [])   // 自动读取 / 300ms 防抖写回
```

`postMessage` RPC 流程：组件 → 宿主桥（`bridge.ts`）→ `api.widgetData(uuid)` → 后端 `PUT /api/widgets/:uuid/data/:key`，数据按组件 UUID 存 JSON。

### 3. 安全模型（纵深防御，逐层实测过）

| 层 | 机制 | 结果（浏览器实测） |
|---|---|---|
| 隔离 | `sandbox="allow-scripts"`，**不含** `allow-same-origin` | 读宿主 DOM / localStorage / cookie 全部抛 `SecurityError` |
| CSP | `connect-src 'none'`，无 `unsafe-eval`，`script-src 'unsafe-inline'` | `fetch` / `WebSocket` / 外链图片被拦；`eval` / `new Function` 抛 `EvalError` |
| 桥 | 以 `e.source` 判定来源（opaque origin 下 `e.origin` 恒为 `null`）+ 每实例一次性 nonce + 方法白名单 + key/大小校验 + 令牌桶限流 | 伪造 nonce 的 RPC 被丢弃，后端零调用 |
| widgetId | 由宿主在注册时绑定，**不从消息里取** | 组件无法读写别的组件的数据 |
| 后端 | JWT；组件数据仅所有者可访问，或其所在文档被分享后对登录用户开放；文档与组件的绑定由服务端从文档 JSON 推导，客户端无法伪造 | 跨用户访问返回 404（不泄露资源是否存在） |
| 快筛 | 前端基于编译产物、后端基于源码的静态检查 | 只是快速反馈，**不是安全边界** |

### 4. 对话：SSE、断线续传、刷新不中断、不重复执行

- **任务与请求解耦**：`POST /messages` 只登记并启动后台任务，立即返回 `runId`；生成过程通过 `GET /runs/:id/events` 以 SSE 订阅。HTTP 连接断了，任务继续跑。
- **带序号的事件日志**（`server/internal/runs`）：每个 run 一份 `seq` 递增的日志，SSE 只是它的订阅者。`Last-Event-ID` 之后重放，多标签页可同时旁观。
- **客户端**（`ai-chat/src/runClient.ts`）：用 `fetch` 而不是 `EventSource`（后者不能带 `Authorization`、不能控制重连位点）；指数退避重连、按 `seq` 去重、45 秒无数据（含心跳）判定连接已死。
- **刷新 / 切换会话**：会话详情返回 `activeRun`，客户端重放全部事件重建流式状态后接着跟随。
- **幂等**：同一个 `clientMessageId` 重复提交返回同一个 `runId`，不会启动第二个任务。
- **先落库再发 `run.done`**：客户端收到终止事件后立刻拉会话，一定能看到完整消息。

### 5. 编辑器

- 文档以 TipTap JSON 保存；`widget` 节点只存 `{uuid, title, height, width}`，代码与数据在服务端。因此 AI 修改组件后，文档里所有引用处自动更新。
- 组件块可拖拽调整宽高（拖动中只改本地状态，松手时一次事务写入文档）。
- AI 改写：选中 → 指令 → 流式预览 → 采纳 / 放弃；采纳前校验选区内容未变，避免改错位置。
- 自动保存：1 秒防抖、请求串行化（避免旧内容晚到覆盖新内容）、失败保留待保存内容、离开页面前强制保存。

### 6. 构建与性能

```bash
pnpm analyze                       # vite build --mode analyze，生成 apps/web/stats.html（依赖体积树图）
pnpm --filter @doc/web build:cdn   # react / react-dom 走 CDN import map（默认 esm.sh，可用 VITE_CDN_BASE 换源）
```

已做：路由级代码分割（文档列表页不下载编辑器）、AI 面板 / Markdown 渲染 / 组件编译 Worker 均按需加载、React 单独成 chunk 以利用长期缓存、可选 CDN 外置。

**实测的构建产物**（`apps/web`，gzip）：首屏（文档列表页）需要的 JS ≈ 91 KB（入口 + react-vendor + 列表页）；全部 JS ≈ 264 KB，其余（文档页含编辑器 131 KB、Markdown 35 KB、对话页几乎为零）按需加载；Sucrase 编译 Worker 约 206 KB（未压缩）独立成包。

> **没有做 FCP 前后对比的测量。** 简历上如果要写具体的 FCP 数字，请用 Lighthouse 在你自己的部署环境里测；本地 localhost 的数字没有参考意义。
>
> **CDN 模式**已在浏览器里实际加载验证：文档列表页与编辑器页（TipTap、AI 面板、沙箱组件）均正常，页面里只有一份 React（否则 TipTap 的 hooks 会直接报错）。**未验证**的是目标用户所在地区对该 CDN 的可用性与延迟。外置 React 后，依赖里的 CommonJS `require('react')` 会让页面白屏——`@tiptap/react` 依赖的 `use-sync-external-store` 就是这样，已用 `config/shims/` 里的 ESM 替身处理；日后新增依赖后若 CDN 构建白屏，先在产物里搜 `require`。

## 测试

```bash
pnpm test                          # 前端：75 个（shared 10 / widget-runtime 34 / ai-chat 31）
pnpm test:server                   # 后端：23 个（等价于 cd server && go test ./internal/...）
pnpm typecheck
```

后端的 e2e（`server/internal/api/e2e_test.go`）使用真实的 SQLite、真实路由、真实 Eino Agent，只把 LLM 换成 Mock，覆盖：工具调用全链路、SSE 任意位点续传、重复提交幂等、客户端断开后任务照常完成且不重复执行、跨用户隔离、组件数据权限与分享。

## 已知限制 / 尚未做

- **真实模型未测**：见上文。审核 Agent 对真实模型输出的误报 / 漏报率未知，需要用真实模型和一批对抗样本评估。
- **单进程**：事件日志在内存里。多实例部署需换成共享存储；服务重启时进行中的任务会中断（已落库的消息不受影响，客户端收到 404 后会以数据库为准）。
- **没有登录限流 / 验证码**：登录接口没有防暴力破解。生产环境请在网关层限流，并设置 `ALLOW_REGISTER=false`。
- **组件挂载时的写入竞态**：`useWidgetState` 在数据加载完成前若被用户代码（如挂载时的 `useEffect`）写入，会保留用户的写入而不是被旧数据覆盖，这可能覆盖已存的值。属于刻意的取舍。
- **组件数量**：每个沙箱 iframe 都内联约 140 KB 的 React 运行库（生产环境），单页放几十个组件时首次渲染会变慢；尚未做"滚动到可视区才挂载"。
- **分享模型较粗**：分享 = 对所有登录用户只读可见，且访客可读写其中组件的数据；没有细粒度的协作者 / 权限。
- **不支持多人协同编辑**（保存为最后写入者胜出）。
- 开发用的 `.claude/launch.json` 里写了本机的绝对路径（`D:/AAAjianlixiangmu/Doc/...`），换机器需要改。
