/**
 * 组件代码静态策略。
 *
 * 这是纵深防御的“第一道快筛”，不是安全边界：真正的隔离来自
 *   1. iframe sandbox="allow-scripts"（不含 allow-same-origin，opaque origin）
 *   2. srcdoc 内的 CSP（connect-src 'none'、无 unsafe-eval）
 *   3. 宿主 RPC 桥的来源校验 + 后端权限控制
 *
 * 检查对象是 sucrase 编译后的 JS，而不是用户源码：JSX 文本（如 "Top 10"、"window 计数"）
 * 编译后变成字符串字面量，可以精确消去，避免把界面文案误判为标识符；动态 import() 也会被
 * 转换成 require()，统一走模块白名单。
 *
 * 服务端 Go 侧 (server/internal/ai/validate.go) 只有无法解析 JSX 的轻量版，用于提前给模型反馈；
 * 以这里的检查结果为准。
 */

export const ALLOWED_MODULES: readonly string[] = ['react', '@sdk']
export const MAX_CODE_CHARS = 60_000

export interface Violation {
  rule: string
  message: string
  line: number
}

const BANNED_IDENTIFIERS = [
  'eval',
  'Function',
  'fetch',
  'XMLHttpRequest',
  'WebSocket',
  'EventSource',
  'Worker',
  'SharedWorker',
  'importScripts',
  'localStorage',
  'sessionStorage',
  'indexedDB',
  'caches',
  'WebAssembly',
  'postMessage',
  'BroadcastChannel',
  'dangerouslySetInnerHTML',
  'innerHTML',
  'outerHTML',
  'insertAdjacentHTML',
  'srcdoc',
  '__proto__',
]

/** window / document 上允许访问的成员；其余一律拒绝，含计算属性访问 window[...] */
const ALLOWED_GLOBAL_MEMBERS: Record<string, readonly string[]> = {
  window: [
    'innerWidth',
    'innerHeight',
    'addEventListener',
    'removeEventListener',
    'requestAnimationFrame',
    'cancelAnimationFrame',
    'matchMedia',
    'devicePixelRatio',
    'setTimeout',
    'clearTimeout',
    'setInterval',
    'clearInterval',
  ],
  document: ['addEventListener', 'removeEventListener', 'getElementById', 'activeElement', 'hidden'],
}

const BANNED_TAGS = ['iframe', 'script', 'object', 'embed', 'link', 'meta', 'base', 'form', 'frame']

/** 抹掉注释；字符串内容保持原样，返回值与输入等长、换行保留 */
function stripComments(src: string): string {
  const out = src.split('')
  let i = 0
  let quote: string | null = null
  while (i < src.length) {
    const c = src[i]!
    const n = src[i + 1]
    if (quote) {
      if (c === '\\') i += 2
      else {
        if (c === quote) quote = null
        i++
      }
      continue
    }
    if (c === '"' || c === "'" || c === '`') {
      quote = c
      i++
    } else if (c === '/' && n === '/') {
      while (i < src.length && src[i] !== '\n') out[i++] = ' '
    } else if (c === '/' && n === '*') {
      const end = src.indexOf('*/', i + 2)
      const stop = end === -1 ? src.length : end + 2
      for (; i < stop; i++) if (src[i] !== '\n') out[i] = ' '
    } else i++
  }
  return out.join('')
}

/** 把字符串字面量的内容替换成空格（引号保留），避免文案里的 "window" 之类被误报 */
function blankStrings(src: string): string {
  const out = src.split('')
  let i = 0
  while (i < src.length) {
    const c = src[i]!
    if (c === '"' || c === "'" || c === '`') {
      const q = c
      i++
      while (i < src.length && src[i] !== q) {
        if (src[i] === '\\') {
          if (src[i + 1] !== '\n') out[i + 1] = ' '
          out[i] = ' '
          i += 2
          continue
        }
        if (src[i] !== '\n') out[i] = ' '
        i++
      }
      i++
    } else i++
  }
  return out.join('')
}

function lineOf(src: string, index: number): number {
  let line = 1
  for (let i = 0; i < index; i++) if (src.charCodeAt(i) === 10) line++
  return line
}

/** 校验 sucrase（transforms: typescript/jsx/imports，classic JSX）编译后的 CJS 代码 */
export function validateCompiled(js: string): Violation[] {
  const v: Violation[] = []
  const add = (rule: string, message: string, src: string, index: number) =>
    v.push({ rule, message, line: lineOf(src, index) })

  const code = stripComments(js)

  if (!/\bexports\s*\.\s*default\b/.test(code)) {
    v.push({ rule: 'entry', message: '缺少 export default 的组件', line: 1 })
  }

  // 1. 模块白名单：import / 动态 import() / require() 编译后都是 require(...)
  for (const m of code.matchAll(/(?<![\w$.])require\s*\(\s*(?:(['"`])([^'"`]*)\1)?/g)) {
    if (m[2] === undefined) add('import', 'require() 只允许字符串常量', code, m.index)
    else if (!ALLOWED_MODULES.includes(m[2])) {
      add('import', `不允许导入模块 "${m[2]}"，仅可使用 ${ALLOWED_MODULES.join(' / ')}`, code, m.index)
    }
  }

  const blanked = blankStrings(code)

  // 2. 禁用标识符
  const banned = new RegExp(`(?<![\\w$.])(${BANNED_IDENTIFIERS.join('|')})(?![\\w$])`, 'g')
  for (const m of blanked.matchAll(banned)) add('identifier', `禁止使用 ${m[1]}`, blanked, m.index)
  for (const m of blanked.matchAll(/\.\s*(?:innerHTML|outerHTML|srcdoc|constructor\s*\.\s*constructor)(?![\w$])/g)) {
    add('identifier', '禁止访问危险属性', blanked, m.index)
  }

  // 3. 全局对象：window/document 仅允许白名单成员；globalThis/self 一律拒绝
  for (const m of blanked.matchAll(/(?<![\w$.])(window|document|globalThis|self)(?![\w$])\s*(\.\s*([A-Za-z_$][\w$]*)|\[)?/g)) {
    const obj = m[1]!
    const tail = m[2]
    const member = m[3]
    const allowed = ALLOWED_GLOBAL_MEMBERS[obj]
    if (!allowed) add('global', `禁止使用 ${obj}`, blanked, m.index)
    else if (tail === undefined) add('global', `禁止直接引用 ${obj}，只能访问其白名单成员`, blanked, m.index)
    else if (tail.startsWith('[')) add('global', `禁止对 ${obj} 使用计算属性访问`, blanked, m.index)
    else if (!allowed.includes(member!)) add('global', `禁止访问 ${obj}.${member}`, blanked, m.index)
  }
  // 裸用 parent/top/opener/frames（对象键 `top:` 与成员 `.top` 不算）
  for (const m of blanked.matchAll(/(?<![\w$.])(parent|top|opener|frames)(?![\w$])(?!\s*:)/g)) {
    add('global', `禁止使用 ${m[1]}`, blanked, m.index)
  }

  // 4. 危险标签与外链：编译后标签是 createElement('iframe', ...)，属性是对象键；这里需要看字符串内容
  const tags = new RegExp(`createElement\\(\\s*(['"])(${BANNED_TAGS.join('|')})\\1`, 'gi')
  for (const m of code.matchAll(tags)) add('tag', `禁止使用 <${m[2]}> 标签`, code, m.index)
  for (const m of code.matchAll(/\b(?:href|src|action|formAction|poster|srcSet)\s*:\s*(['"`])\s*(?:https?:)?\/\//gi)) {
    add('external', '禁止引用外部资源', code, m.index)
  }
  for (const m of code.matchAll(/javascript\s*:/gi)) add('external', '禁止 javascript: URL', code, m.index)
  for (const m of code.matchAll(/url\(\s*['"]?\s*(?:https?:)?\/\//gi)) {
    add('external', '禁止 CSS 引用外部资源', code, m.index)
  }

  return v
}

export function formatViolations(vs: Violation[]): string {
  return vs.map((x) => `第 ${x.line} 行：${x.message}`).join('\n')
}
