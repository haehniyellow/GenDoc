# 参考项目

动手前在 GitHub 上找过类似项目。结论：**没有任何一个项目同时覆盖「TipTap 文档 + Agent 生成 + 沙箱组件 + 数据持久化 + 断线续传」**，所以本项目是按能力拆开、分别参考、再组装的。

下表的"借鉴"指借鉴思路或调用其公开 API；**没有拷贝任何第三方项目的源码**。

| 项目 | 许可证 | 我们借鉴了什么 | 没有采用 / 与之不同 |
|---|---|---|---|
| [cloudwego/eino](https://github.com/cloudwego/eino) 与 [eino-examples](https://github.com/cloudwego/eino-examples) | Apache-2.0 | ADK 的 `ChatModelAgent` + `Runner` 用法、工具定义（`utils.InferTool`）、事件流（`AgentEvent` / `MessageStream`）的消费方式；`compose.GetToolCallID` 用来把工具内部的阶段进度关联到具体工具卡片 | — |
| [ddc-111/gorag-agent](https://github.com/ddc-111/gorag-agent)（Eino ADK + Gin + SSE） | 仓库中未见 LICENSE 文件 | 「Gin handler 里驱动 ADK Runner、把事件翻译成 SSE」这一整体结构 | 该项目在**请求内**同步跑 Agent；本项目把任务与请求解耦（见下），以支持刷新不中断。因无 LICENSE，只参考了结构思路，未拷贝代码 |
| [vercel/resumable-stream](https://github.com/vercel/resumable-stream) | MIT | 「stream id + 偏移量续传」的模型：事件带单调序号，客户端断线后带位点重连，服务端从位点之后重放 | 它依赖 Redis pub/sub 以适配 serverless；本项目是单进程，用内存事件日志代替。**多实例部署时需要换成 Redis Stream 等共享存储** |
| [aziddy/LLM-React-Artifact-Render-Server](https://github.com/aziddy/LLM-React-Artifact-Render-Server) | package.json 声明 ISC | `sandbox="allow-scripts"` 的 iframe 渲染 LLM 生成的 JSX、把 `import` 映射到全局变量的思路 | 它在 iframe 内用主线程 Babel + 外部 CDN；本项目改为 **Web Worker 里的 Sucrase + 编译缓存**，并用 CSP 禁止网络与 eval、模块白名单只有 `react` 与 `@sdk` |
| [alangpierce/sucrase](https://github.com/alangpierce/sucrase) | MIT | JSX/TS → CJS 编译（速度快、体积小，适合放进 Worker） | — |
| [ueberdosis/tiptap](https://github.com/ueberdosis/tiptap)、[steven-tey/novel](https://github.com/steven-tey/novel)（Apache-2.0）、[Knote](https://github.com/1661169091kiwi/Knote)（MIT） | 见左 | TipTap 自定义节点 + React NodeView 的组织方式；AI 改写的交互形态 | novel 是补全式交互且已一年多未更新；本项目是「选中 → 指令 → 预览 → 采纳/放弃」，采纳前不改文档 |

## 从参考项目之外学到的、值得记录的坑

这些是实际联调中踩到的，写在这里避免重复：

1. **Eino ADK 是在每次模型调用时通过 `model.WithTools(...)` *选项* 传入工具**，而不是调用模型的 `WithTools()` 方法。自己实现 / Mock `ToolCallingChatModel` 时必须读 `model.GetCommonOptions(...).Tools`。
2. **不要让沙箱 iframe 用 `<script src>` 加载宿主域名下的文件。** 没有 `allow-same-origin` 的 iframe 是 opaque origin，它发出的请求会被当作来自 `null` 源的跨站请求：Vite 开发服务器会直接拒绝，生产环境是否可用又取决于静态服务器 / CDN 的 CORS 配置。本项目改为宿主同源 `fetch` 取到 React 源码后**内联**进 `srcdoc`，CSP 的 `script-src` 因此只需 `'unsafe-inline'`。
3. **React 19 已移除 UMD 构建**，而沙箱的 CSP 又不允许 eval，所以沙箱内单独使用 React 18 的 UMD（以 `react18` / `react-dom18` 别名依赖引入），宿主仍是 React 19，两者被 iframe 边界隔开。
4. **Sucrase 的 TS 转换会剔除未使用的 import**，所以"导入了白名单外的模块但没用"的代码不会被执行，无需拦截；策略校验因此放在**编译产物**上做（JSX 文本已变成字符串字面量，可以精确消去，避免把界面文案里的 `window`、`Top 10` 误判为标识符）。
5. **React 外置成 CDN import map 时，依赖里的 CommonJS `require('react')` 会让页面白屏**（浏览器报错 `Calling require for "react" in an environment that doesn't expose the require function`）。`@tiptap/react` 依赖的 `use-sync-external-store` 只有 CJS 构建，会被内联进产物；React ≥ 18 自带 `useSyncExternalStore`，用 Vite 的 `resolve.alias` 指到 ESM 替身即可（见 `config/shims/`）。这个问题只有在真实浏览器里打开**编辑器页**才会暴露——构建成功、列表页正常都不能说明 CDN 模式可用。
