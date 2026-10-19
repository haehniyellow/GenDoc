import { describe, expect, it } from 'vitest'
import { compileCore } from './compile-core'

const wrap = (body: string) => `import { useState } from 'react'\nexport default function W() {\n${body}\nreturn <div/>\n}`

function violations(code: string) {
  const r = compileCore(code)
  return r.ok ? [] : (r.violations ?? [])
}
const rules = (code: string) => violations(code).map((v) => v.rule)

describe('compileCore 策略校验', () => {
  it('放行正常组件，并输出可执行的 CJS', () => {
    const r = compileCore(`import { useState } from 'react'
import { useWidgetState } from '@sdk'
export default function Counter() {
  const [n, setN] = useWidgetState('count', 0)
  // fetch 只出现在注释里
  return <div style={{ position: 'absolute', top: 0, left: 0 }} onClick={() => setN(n + 1)}>window 计数 {n}</div>
}`)
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.js).toContain('exports.default')
  })

  it('JSX 文案里的 window / Top / document / fetch 不会被误报', () => {
    expect(violations(wrap(`return <p>Top 10 in the window: fetch the document from parent, self and top.</p>`))).toEqual([])
  })

  it('支持 TypeScript 语法', () => {
    const r = compileCore(`import { useState } from 'react'
type P = { n: number }
export default function A({ n }: P) { const [x] = useState<number>(n); return <b>{x}</b> }`)
    expect(r.ok).toBe(true)
  })

  it('放行 window 白名单成员', () => {
    expect(violations(wrap(`window.addEventListener('resize', () => {}); const w = window.innerWidth`))).toEqual([])
  })

  it('语法错误返回 syntax', () => {
    const r = compileCore(`export default function A( { return <div> }`)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.kind).toBe('syntax')
  })

  it('要求 export default', () => {
    expect(rules(`export function A() { return <div/> }`)).toContain('entry')
  })

  it('拒绝白名单外的模块、动态 import、require', () => {
    expect(rules(`import axios from 'axios'\nexport default () => <div>{String(axios)}</div>`)).toContain('import')
    // 未被使用的 import 会被 sucrase 直接剔除，永远不会执行，因此无需拦截
    expect(rules(`import axios from 'axios'\nexport default () => <div/>`)).toEqual([])
    expect(rules(wrap(`import('./x')`))).toContain('import')
    expect(rules(wrap(`const x = require('fs')`))).toContain('import')
    expect(rules(wrap(`const n = 'f' + 's'; require(n)`))).toContain('import')
  })

  it.each([
    ['网络', `fetch('/api')`],
    ['XHR', `new XMLHttpRequest()`],
    ['eval', `eval('1')`],
    ['Function 构造', `new Function('return 1')()`],
    ['localStorage', `localStorage.getItem('a')`],
    ['postMessage', `window.parent.postMessage(1, '*')`],
    ['innerHTML', `document.getElementById('a').innerHTML = 'x'`],
  ])('拒绝 %s', (_name, body) => {
    expect(violations(wrap(body)).length).toBeGreaterThan(0)
  })

  it('拒绝通过 window 计算属性 / globalThis / 别名绕过', () => {
    expect(rules(wrap(`window['fe' + 'tch']('/a')`))).toContain('global')
    expect(rules(wrap(`globalThis.fetch('/a')`))).toContain('global')
    expect(rules(wrap(`const w = window`))).toContain('global')
    expect(rules(wrap(`self.location.href = 'x'`))).toContain('global')
    expect(rules(wrap(`parent.postMessage(1, '*')`))).toContain('global')
    expect(rules(wrap(`window.top.location = 'x'`))).toContain('global')
  })

  it('拒绝 constructor.constructor 逃逸', () => {
    expect(violations(wrap(`const F = (()=>{}).constructor.constructor`)).length).toBeGreaterThan(0)
  })

  it('拒绝危险标签与外链', () => {
    expect(rules(`export default () => <iframe src="x" />`)).toContain('tag')
    expect(rules(`export default () => <img src="https://evil.test/a.png" />`)).toContain('external')
    expect(rules(`export default () => <a href="javascript:alert(1)">x</a>`)).toContain('external')
    expect(rules(`export default () => <div style={{ background: 'url(https://x.test/a.png)' }} />`)).toContain('external')
  })

  it('注释与字符串里的违规词不报错', () => {
    expect(violations(wrap(`/* fetch('x') */ const t = "请勿使用 eval 和 fetch"`))).toEqual([])
  })

  it('超长代码被拒绝', () => {
    expect(rules('x'.repeat(70_000))).toContain('size')
  })
})
