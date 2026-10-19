import { describe, expect, it } from 'vitest'
import type { RunEvent } from '@doc/shared'
import { applyEvent, initLive } from './live'

const replay = (events: RunEvent[]) => events.reduce(applyEvent, initLive('r1'))

describe('applyEvent', () => {
  const events: RunEvent[] = [
    { type: 'run.start', runId: 'r1' },
    { type: 'text.delta', text: '好的，' },
    { type: 'tool.start', callId: 'c1', name: 'create_widget', args: '{}' },
    { type: 'stage', callId: 'c1', stage: 'generate', message: '正在生成代码' },
    { type: 'stage', callId: 'c1', stage: 'review', message: '审核中' },
    { type: 'tool.end', callId: 'c1', name: 'create_widget', result: '{"ok":true}' },
    { type: 'text.delta', text: '完成。' },
    { type: 'run.done' },
  ]

  it('重放全部事件即可重建完整状态（刷新页面后接上的基础）', () => {
    const s = replay(events)
    expect(s.text).toBe('好的，完成。')
    expect(s.tools).toHaveLength(1)
    expect(s.tools[0]).toMatchObject({ callId: 'c1', done: true, result: '{"ok":true}', stage: undefined })
  })

  it('阶段进度挂在对应工具上，工具结束后清除', () => {
    const s = replay(events.slice(0, 5))
    expect(s.tools[0]!.stage).toBe('审核中')
    expect(s.tools[0]!.done).toBe(false)
  })

  it('没有 callId 的阶段事件挂到最近一个未完成的工具', () => {
    const s = replay([
      { type: 'tool.start', callId: 'a', name: 'x', args: '' },
      { type: 'tool.end', callId: 'a', name: 'x', result: '' },
      { type: 'tool.start', callId: 'b', name: 'y', args: '' },
      { type: 'stage', stage: 's', message: '进行中' },
    ])
    expect(s.tools[0]!.stage).toBeUndefined()
    expect(s.tools[1]!.stage).toBe('进行中')
  })

  it('重复的 tool.start 不会产生重复卡片', () => {
    const ev: RunEvent = { type: 'tool.start', callId: 'c1', name: 'x', args: '' }
    expect(replay([ev, ev]).tools).toHaveLength(1)
  })

  it('run.error 记录错误信息', () => {
    expect(replay([{ type: 'run.error', message: '模型超时' }]).error).toBe('模型超时')
  })

  it('不修改传入的状态对象', () => {
    const s0 = initLive('r1')
    applyEvent(s0, { type: 'text.delta', text: 'x' })
    expect(s0.text).toBe('')
  })
})
