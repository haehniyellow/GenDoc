import { transform } from 'sucrase'
import { MAX_CODE_CHARS, formatViolations, validateCompiled, type Violation } from './policy'

export type CompileResult =
  | { ok: true; js: string }
  | { ok: false; kind: 'policy' | 'syntax'; message: string; violations?: Violation[] }

/** 编译 + 策略校验。Worker 与单测共用，不依赖任何浏览器 API。 */
export function compileCore(code: string): CompileResult {
  if (code.length > MAX_CODE_CHARS) {
    const message = `代码超过 ${MAX_CODE_CHARS} 字符上限`
    return { ok: false, kind: 'policy', message, violations: [{ rule: 'size', message, line: 1 }] }
  }
  let js: string
  try {
    js = transform(code, {
      transforms: ['typescript', 'jsx', 'imports'],
      jsxRuntime: 'classic',
      production: true,
      filePath: 'widget.tsx',
    }).code
  } catch (err) {
    return { ok: false, kind: 'syntax', message: err instanceof Error ? err.message : String(err) }
  }
  const violations = validateCompiled(js)
  if (violations.length > 0) {
    return { ok: false, kind: 'policy', message: formatViolations(violations), violations }
  }
  return { ok: true, js }
}
