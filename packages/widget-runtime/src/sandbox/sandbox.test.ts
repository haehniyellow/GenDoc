import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { escapeInlineScript, injectConfig } from './inline'

const bootstrap = readFileSync(new URL('./bootstrap.js', import.meta.url), 'utf8')

describe('bootstrap.js 模板', () => {
  it('占位符恰好出现一次（回归：注释里的同名占位符曾被先替换，真正的常量没被注入）', () => {
    expect(bootstrap.split('__CONFIG__')).toHaveLength(2)
  })

  it('注入配置后是合法的 JavaScript，且不再含占位符', () => {
    const out = injectConfig(bootstrap, JSON.stringify({ ns: 'x', nonce: 'n', hostOrigin: 'http://h' }))
    expect(out).not.toContain('__CONFIG__')
    expect(() => new Function(out)).not.toThrow() // 只做语法检查，不执行
  })

  it('占位符缺失或重复时直接报错，而不是静默运行', () => {
    expect(() => injectConfig('var a = 1', '{}')).toThrow('占位符')
    expect(() => injectConfig('__CONFIG__; __CONFIG__', '{}')).toThrow('占位符')
  })
})

describe('escapeInlineScript', () => {
  it('转义 </script 与 <!--，且转义后的字符串字面量取值不变', () => {
    const src = `var a = "</script><!--";`
    const escaped = escapeInlineScript(src)
    expect(escaped).not.toMatch(/<\/script/i)
    expect(escaped).not.toContain('<!--')
    // eslint-disable-next-line no-new-func
    expect(new Function(`${escaped}; return a`)()).toBe('</script><!--')
  })

  it('不改动普通代码', () => {
    expect(escapeInlineScript('var a = 1 < 2 && 3 > 2')).toBe('var a = 1 < 2 && 3 > 2')
  })
})
