import type { CompileResult } from './compile-core'

export interface WorkerRequest {
  id: number
  code: string
}

export type WorkerResponse = { id: number } & CompileResult

export class CompileError extends Error {
  constructor(
    message: string,
    public kind: 'policy' | 'syntax' | 'timeout',
  ) {
    super(message)
  }
}

/** 编译流水线变更（sucrase 版本、transform 选项、策略规则）时递增，使旧缓存整体失效 */
export const COMPILE_CACHE_VERSION = 'v1'

export interface CompilerDeps {
  /** 真正执行编译的函数；生产环境是 Web Worker，测试里可以替换 */
  run: (code: string) => Promise<string>
  /** 持久化缓存（可选）。失败必须静默，缓存只是优化 */
  persist?: PersistentCache
  memoryLimit?: number
}

export interface PersistentCache {
  get(key: string): string | null
  set(key: string, value: string): void
}

/** 按内容哈希缓存编译结果；相同代码并发编译只会执行一次 */
export function createCompiler(deps: CompilerDeps) {
  const limit = deps.memoryLimit ?? 200
  const memory = new Map<string, string>()
  const inflight = new Map<string, Promise<string>>()
  const stats = { hits: 0, persistHits: 0, misses: 0 }

  function remember(key: string, js: string) {
    memory.delete(key)
    memory.set(key, js)
    if (memory.size > limit) memory.delete(memory.keys().next().value as string)
  }

  async function compile(code: string): Promise<string> {
    const key = `${COMPILE_CACHE_VERSION}:${await hashCode(code)}`

    const cached = memory.get(key)
    if (cached !== undefined) {
      stats.hits++
      remember(key, cached) // 刷新 LRU 位置
      return cached
    }
    const stored = deps.persist?.get(key)
    if (stored) {
      stats.persistHits++
      remember(key, stored)
      return stored
    }
    const pending = inflight.get(key)
    if (pending) return pending

    stats.misses++
    const p = deps
      .run(code)
      .then((js) => {
        remember(key, js)
        deps.persist?.set(key, js)
        return js
      })
      .finally(() => inflight.delete(key))
    inflight.set(key, p)
    return p
  }

  return { compile, stats, clear: () => memory.clear() }
}

/** SHA-256；非安全上下文（如局域网 http 访问）没有 crypto.subtle 时回退到 FNV-1a */
export async function hashCode(code: string): Promise<string> {
  if (globalThis.crypto?.subtle) {
    const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(code))
    return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join('')
  }
  let h1 = 0x811c9dc5
  let h2 = 0x01000193
  for (let i = 0; i < code.length; i++) {
    h1 = Math.imul(h1 ^ code.charCodeAt(i), 0x01000193)
    h2 = Math.imul(h2 + code.charCodeAt(i), 0x85ebca6b)
  }
  return `f${(h1 >>> 0).toString(16)}${(h2 >>> 0).toString(16)}${code.length.toString(16)}`
}

/** localStorage 持久缓存：最多 60 条，超出淘汰最旧；任何异常都当作未命中 */
export function createLocalStorageCache(prefix = 'wc:', maxEntries = 60, maxBytes = 200_000): PersistentCache {
  const indexKey = `${prefix}index`
  const readIndex = (): string[] => {
    try {
      const raw = localStorage.getItem(indexKey)
      return raw ? (JSON.parse(raw) as string[]) : []
    } catch {
      return []
    }
  }
  return {
    get(key) {
      try {
        return localStorage.getItem(prefix + key)
      } catch {
        return null
      }
    },
    set(key, value) {
      if (value.length > maxBytes) return
      try {
        const index = readIndex().filter((k) => k !== key)
        index.push(key)
        while (index.length > maxEntries) localStorage.removeItem(prefix + index.shift()!)
        localStorage.setItem(prefix + key, value)
        localStorage.setItem(indexKey, JSON.stringify(index))
      } catch {
        /* 配额已满或被禁用 */
      }
    },
  }
}

// ───────────────────────── 浏览器端 Worker 实现 ─────────────────────────

const COMPILE_TIMEOUT_MS = 8000

function createWorkerRunner(): (code: string) => Promise<string> {
  let worker: Worker | null = null
  let seq = 0
  const pending = new Map<number, { resolve: (js: string) => void; reject: (e: Error) => void; timer: number }>()

  function ensure(): Worker {
    if (worker) return worker
    const w = new Worker(new URL('./compile.worker.ts', import.meta.url), { type: 'module' })
    w.onmessage = (e: MessageEvent<WorkerResponse>) => {
      const res = e.data
      const p = pending.get(res.id)
      if (!p) return
      pending.delete(res.id)
      clearTimeout(p.timer)
      if (res.ok) p.resolve(res.js)
      else p.reject(new CompileError(res.message, res.kind))
    }
    w.onerror = () => reset(new CompileError('编译 Worker 异常退出', 'syntax'))
    worker = w
    return w
  }

  function reset(err: Error) {
    worker?.terminate()
    worker = null
    for (const [id, p] of pending) {
      clearTimeout(p.timer)
      p.reject(err)
      pending.delete(id)
    }
  }

  return (code) =>
    new Promise<string>((resolve, reject) => {
      const id = ++seq
      const timer = window.setTimeout(() => reset(new CompileError('编译超时', 'timeout')), COMPILE_TIMEOUT_MS)
      pending.set(id, { resolve, reject, timer })
      ensure().postMessage({ id, code } satisfies WorkerRequest)
    })
}

let shared: ReturnType<typeof createCompiler> | null = null

/** 全局共享的编译器：同一页面里所有 WidgetFrame 共用一个 Worker 与一份缓存 */
export function getCompiler() {
  return (shared ??= createCompiler({ run: createWorkerRunner(), persist: createLocalStorageCache() }))
}

export function compileWidget(code: string): Promise<string> {
  return getCompiler().compile(code)
}
