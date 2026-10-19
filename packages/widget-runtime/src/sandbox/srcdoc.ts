import { RPC_NAMESPACE } from '@doc/shared'
import bootstrap from './bootstrap.js?raw'
import { escapeInlineScript, injectConfig } from './inline'

export interface SrcdocOptions {
  /** sucrase 输出的 CJS 代码 */
  compiledJs: string
  /** React + ReactDOM 的 UMD 源码（见 vendor.ts） */
  vendorJs: string
  nonce: string
  /** 宿主页面的 origin，组件向它 postMessage 时用作 targetOrigin */
  hostOrigin: string
}

const BASE_CSS = `
*,*::before,*::after{box-sizing:border-box}
html,body{margin:0;padding:0}
body{padding:12px;font:14px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif;color:#1f2328;background:transparent}
button,input,select,textarea{font:inherit}
@media (prefers-color-scheme:dark){body{color:#e6edf3}}
`

// 所有脚本都是内联的，所以 script-src 只需要 'unsafe-inline'，不放行任何外部地址。
// connect-src 'none'：组件无法发起任何网络请求，数据只能走宿主 RPC。
// 不含 unsafe-eval：eval / new Function 直接失败，堵住字符串拼接类绕过。
export const SANDBOX_CSP = [
  "default-src 'none'",
  "script-src 'unsafe-inline'",
  "style-src 'unsafe-inline'",
  'img-src data: blob:',
  'font-src data:',
  'media-src data: blob:',
  "connect-src 'none'",
  "form-action 'none'",
  "base-uri 'none'",
].join('; ')

export function buildSrcdoc({ compiledJs, vendorJs, nonce, hostOrigin }: SrcdocOptions): string {
  const config = JSON.stringify({ ns: RPC_NAMESPACE, nonce, hostOrigin }).replace(/</g, '\\u003c')
  return `<!doctype html>
<html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${SANDBOX_CSP}">
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>${BASE_CSS}</style></head>
<body><div id="root"></div>
<script>${vendorJs}</script>
<script>${injectConfig(bootstrap, config)}</script>
<script>window.__mount(function (require, exports, module, React) {
${escapeInlineScript(compiledJs)}
})</script>
</body></html>`
}
