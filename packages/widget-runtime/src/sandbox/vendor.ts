// 沙箱内使用 React 18 的 UMD 构建：React 19 已移除 UMD，而沙箱的 CSP 禁止 eval，需要现成的浏览器全局构建。
// 用相对路径直达文件以绕过 package exports 限制，由 Vite 以 ?url 输出为静态资源（不进入应用 JS 包）。
import reactUrl from '../../node_modules/react18/umd/react.production.min.js?url'
import reactDomUrl from '../../node_modules/react-dom18/umd/react-dom.production.min.js?url'
import { escapeInlineScript } from './inline'

let cached: Promise<string> | null = null

async function fetchText(u: string): Promise<string> {
  const res = await fetch(u)
  if (!res.ok) throw new Error(`加载沙箱运行库失败：${u} (${res.status})`)
  const text = await res.text()
  // 开发服务器会给文件追加内联 base64 sourcemap（约 700KB），内联进每个 iframe 毫无意义，剥掉
  return text.replace(/^\/\/# sourceMappingURL=.*$/gm, '')
}

/**
 * 取回 React / ReactDOM 的源码文本，用于内联进 srcdoc。
 *
 * 为什么内联而不是 <script src>：沙箱 iframe 是 opaque origin（没有 allow-same-origin），
 * 它向宿主域名发起的脚本请求会被当作“来自 null 源的跨站请求”，Vite 开发服务器等会直接拒绝，
 * 生产环境下是否可用也取决于静态服务器 / CDN 的 CORS 与 CORP 配置。宿主自己（同源）fetch 则没有这个问题。
 * 内联后 CSP 的 script-src 也只需要 'unsafe-inline'，不必再放行任何外部地址。
 * 文本只取一次并缓存，所有组件共用。
 */
export function loadVendorScripts(): Promise<string> {
  cached ??= Promise.all([fetchText(reactUrl), fetchText(reactDomUrl)]).then(
    ([react, dom]) => `${escapeInlineScript(react)}\n${escapeInlineScript(dom)}`,
    (err: unknown) => {
      cached = null // 失败不缓存，下次渲染时重试
      throw err
    },
  )
  return cached
}
