import { describe, expect, it, vi } from 'vitest'
import { createCompiler, hashCode, type PersistentCache } from './compiler'

function memoryPersist(): PersistentCache & { store: Map<string, string> } {
  const store = new Map<string, string>()
  return { store, get: (k) => store.get(k) ?? null, set: (k, v) => void store.set(k, v) }
}

describe('createCompiler', () => {
  it('相同代码只编译一次，后续命中内存缓存', async () => {
    const run = vi.fn(async (code: string) => `js:${code}`)
    const c = createCompiler({ run })
    expect(await c.compile('a')).toBe('js:a')
    expect(await c.compile('a')).toBe('js:a')
    expect(run).toHaveBeenCalledTimes(1)
    expect(c.stats).toMatchObject({ hits: 1, misses: 1 })
  })

  it('并发编译同一份代码会合并为一次', async () => {
    let calls = 0
    const c = createCompiler({
      run: async (code) => {
        calls++
        await new Promise((r) => setTimeout(r, 10))
        return code
      },
    })
    await Promise.all([c.compile('x'), c.compile('x'), c.compile('x')])
    expect(calls).toBe(1)
  })

  it('内存缓存未命中时读持久缓存，写入也会落盘', async () => {
    const persist = memoryPersist()
    const run = vi.fn(async (code: string) => `js:${code}`)
    await createCompiler({ run, persist }).compile('a')
    expect(persist.store.size).toBe(1)

    // 模拟刷新页面：新的 compiler，内存为空
    const run2 = vi.fn(async () => 'never')
    const c2 = createCompiler({ run: run2, persist })
    expect(await c2.compile('a')).toBe('js:a')
    expect(run2).not.toHaveBeenCalled()
    expect(c2.stats.persistHits).toBe(1)
  })

  it('编译失败不会被缓存，可以重试', async () => {
    let n = 0
    const c = createCompiler({
      run: async () => {
        if (n++ === 0) throw new Error('boom')
        return 'ok'
      },
    })
    await expect(c.compile('a')).rejects.toThrow('boom')
    expect(await c.compile('a')).toBe('ok')
  })

  it('内存缓存按 LRU 淘汰', async () => {
    const run = vi.fn(async (code: string) => code)
    const c = createCompiler({ run, memoryLimit: 2 })
    await c.compile('a')
    await c.compile('b')
    await c.compile('a') // a 变新
    await c.compile('c') // 淘汰 b
    run.mockClear()
    await c.compile('a')
    expect(run).not.toHaveBeenCalled()
    await c.compile('b')
    expect(run).toHaveBeenCalledTimes(1)
  })
})

describe('hashCode', () => {
  it('内容相同哈希相同，不同则不同', async () => {
    expect(await hashCode('abc')).toBe(await hashCode('abc'))
    expect(await hashCode('abc')).not.toBe(await hashCode('abd'))
  })
})
