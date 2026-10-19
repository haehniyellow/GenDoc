import { describe, expect, it, vi } from 'vitest'
import type { RunEvent } from '@doc/shared'
import { followRun } from './runClient'
import { frame, sseResponse } from './testUtils'

const noSleep = async () => {}
const delta = (t: string): RunEvent => ({ type: 'text.delta', text: t })
const start: RunEvent = { type: 'run.start', runId: 'r1' }
const done: RunEvent = { type: 'run.done' }

function setup(responses: Array<(lastSeq: number, signal: AbortSignal) => Response | Promise<Response>>) {
  const calls: number[] = []
  const openRunStream = vi.fn(async (_id: string, lastSeq: number, signal: AbortSignal) => {
    calls.push(lastSeq)
    const next = responses[calls.length - 1] ?? responses[responses.length - 1]!
    return next(lastSeq, signal)
  })
  const events: Array<[number, RunEvent]> = []
  const run = (extra: Partial<Parameters<typeof followRun>[0]> = {}, ctrl = new AbortController()) =>
    followRun({
      api: { openRunStream },
      runId: 'r1',
      signal: ctrl.signal,
      onEvent: (ev, seq) => events.push([seq, ev]),
      sleep: noSleep,
      ...extra,
    })
  return { run, calls, events, openRunStream }
}

describe('followRun', () => {
  it('按顺序交付事件，收到终止事件后返回 done', async () => {
    const { run, events, calls } = setup([() => sseResponse([frame(1, start), frame(2, delta('你')), frame(3, done)])])
    expect(await run()).toBe('done')
    expect(events.map(([s]) => s)).toEqual([1, 2, 3])
    expect(calls).toEqual([0])
  })

  it('一个帧被切成多个网络块也能正确解析', async () => {
    const whole = frame(1, delta('中文分块'))
    const mid = Math.floor(whole.length / 2)
    const { run, events } = setup([() => sseResponse([whole.slice(0, mid), whole.slice(mid), frame(2, done)])])
    expect(await run()).toBe('done')
    expect(events[0]![1]).toEqual(delta('中文分块'))
  })

  it('忽略心跳注释帧', async () => {
    const { run, events } = setup([() => sseResponse([': ping\n\n', frame(1, delta('a')), ': ping\n\n', frame(2, done)])])
    await run()
    expect(events).toHaveLength(2)
  })

  it('断线后从最后收到的 seq 续传，事件不丢不重', async () => {
    const { run, events, calls } = setup([
      () => sseResponse([frame(1, start), frame(2, delta('a'))], { failAfter: true }),
      (last) => {
        expect(last).toBe(2) // 关键：续传位点是 2，而不是 0
        return sseResponse([frame(3, delta('b')), frame(4, done)])
      },
    ])
    expect(await run()).toBe('done')
    expect(calls).toEqual([0, 2])
    expect(events.map(([s]) => s)).toEqual([1, 2, 3, 4])
  })

  it('服务端重放了已收到的事件时按 seq 去重', async () => {
    const { run, events } = setup([
      () => sseResponse([frame(1, start), frame(2, delta('a'))], { failAfter: true }),
      // 一个不守规矩的服务端从头重放
      () => sseResponse([frame(1, start), frame(2, delta('a')), frame(3, delta('b')), frame(4, done)]),
    ])
    await run()
    expect(events.map(([s]) => s)).toEqual([1, 2, 3, 4])
  })

  it('流被正常关闭但没有终止事件，视为断线并重连', async () => {
    const { run, calls } = setup([
      () => sseResponse([frame(1, start)]), // 正常 close，没有 run.done
      () => sseResponse([frame(2, done)]),
    ])
    expect(await run()).toBe('done')
    expect(calls).toEqual([0, 1])
  })

  it('run 不存在（404）时返回 gone，不重试', async () => {
    const { run, calls } = setup([() => new Response('{}', { status: 404 })])
    expect(await run()).toBe('gone')
    expect(calls).toHaveLength(1)
  })

  it('连续失败超过上限后返回 failed', async () => {
    const { run, calls } = setup([() => new Response('boom', { status: 500 })])
    expect(await run({ maxRetries: 3 })).toBe('failed')
    expect(calls).toHaveLength(4) // 首次 + 3 次重试
  })

  it('每次重连只要有进展，失败计数就会清零', async () => {
    // 每条连接只送一个事件就断；总共 6 次连接、maxRetries 只有 2，仍应成功
    const responses = [1, 2, 3, 4, 5].map((n) => () => sseResponse([frame(n, delta(String(n)))], { failAfter: true }))
    responses.push(() => sseResponse([frame(6, done)]))
    const { run, events } = setup(responses)
    expect(await run({ maxRetries: 2 })).toBe('done')
    expect(events).toHaveLength(6)
  })

  it('外部中止时返回 aborted，且停止重连', async () => {
    const ctrl = new AbortController()
    const { run, openRunStream } = setup([(_l, signal) => sseResponse([frame(1, start)], { hang: true, signal })])
    const p = run({}, ctrl)
    await new Promise((r) => setTimeout(r, 20))
    ctrl.abort()
    expect(await p).toBe('aborted')
    expect(openRunStream).toHaveBeenCalledTimes(1)
  })

  it('长时间没有任何数据（半开连接）会触发空闲超时并重连', async () => {
    const { run, calls } = setup([
      (_l, signal) => sseResponse([frame(1, start)], { hang: true, signal }),
      () => sseResponse([frame(2, done)]),
    ])
    expect(await run({ idleTimeoutMs: 30 })).toBe('done')
    expect(calls).toEqual([0, 1])
  })

  it('从指定 afterSeq 开始订阅（刷新页面后接上）', async () => {
    const { run, calls } = setup([() => sseResponse([frame(8, done)])])
    await run({ afterSeq: 7 })
    expect(calls).toEqual([7])
  })

  it('run.error 也是终止事件', async () => {
    const { run, events } = setup([() => sseResponse([frame(1, { type: 'run.error', message: 'x' })])])
    expect(await run()).toBe('done')
    expect(events[0]![1].type).toBe('run.error')
  })
})
