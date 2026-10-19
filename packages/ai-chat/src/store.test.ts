import { describe, expect, it, vi } from 'vitest'
import { ApiError, type Api, type ChatMessage, type SessionDetail } from '@doc/shared'
import { createChatStore } from './store'
import { frame, sseResponse } from './testUtils'

const msg = (id: string, role: 'user' | 'assistant', content: string): ChatMessage => ({
  id,
  role,
  content,
  createdAt: '2026-01-01T00:00:00Z',
})

/** 一个内存里的假后端，行为和真实服务端一致：任务与请求解耦，事件日志可重放 */
function fakeBackend() {
  const sessions = new Map<string, { title: string; messages: ChatMessage[]; activeRun: string | null }>()
  const logs = new Map<string, string[]>() // runId -> 已编码的 SSE 帧
  const sent: Array<{ sessionId: string; clientMessageId: string; docId?: string }> = []
  let failNextSend = 0
  let n = 0

  sessions.set('s1', { title: '旧会话', messages: [msg('m1', 'user', '你好'), msg('m2', 'assistant', '你好！')], activeRun: null })
  sessions.set('s2', { title: '进行中', messages: [msg('m3', 'user', '写文章')], activeRun: 'run-live' })
  logs.set('run-live', [
    frame(1, { type: 'run.start', runId: 'run-live' }),
    frame(2, { type: 'text.delta', text: '第一段，' }),
    frame(3, { type: 'text.delta', text: '第二段' }),
    frame(4, { type: 'run.done' }),
  ])

  const api = {
    listSessions: async () => [...sessions].map(([id, s]) => ({ id, title: s.title, updatedAt: '' })),
    createSession: async () => {
      const id = `s-new-${++n}`
      sessions.set(id, { title: '新对话', messages: [], activeRun: null })
      return { id, title: '新对话', updatedAt: '' }
    },
    getSession: vi.fn(async (id: string): Promise<SessionDetail> => {
      const s = sessions.get(id)
      if (!s) throw new ApiError(404, '会话不存在')
      return {
        session: { id, title: s.title, updatedAt: '' },
        messages: [...s.messages],
        activeRun: s.activeRun ? { id: s.activeRun } : null,
      }
    }),
    deleteSession: async (id: string) => void sessions.delete(id),
    sendMessage: vi.fn(async (sessionId: string, input: { clientMessageId: string; content: string; docId?: string }) => {
      sent.push({ sessionId, ...input })
      if (failNextSend > 0) {
        failNextSend--
        throw new TypeError('Failed to fetch')
      }
      const s = sessions.get(sessionId)!
      s.messages.push(msg(`u-${n}`, 'user', input.content))
      const runId = `run-${++n}`
      logs.set(runId, [
        frame(1, { type: 'run.start', runId }),
        frame(2, { type: 'text.delta', text: '回复内容' }),
        frame(3, { type: 'run.done' }),
      ])
      // 与真实服务端一致：先把助手消息落库并清除“进行中”标记，之后才会发出 run.done。
      // 客户端收到 run.done 立刻重新拉会话，必须能看到完整消息。
      s.messages.push(msg(`a-${n}`, 'assistant', '回复内容'))
      s.activeRun = null
      return { runId, deduplicated: false }
    }),
    cancelRun: vi.fn(async () => {}),
    openRunStream: vi.fn(async (runId: string, lastSeq: number) => {
      const log = logs.get(runId)
      if (!log) return new Response('{}', { status: 404 })
      return sseResponse(log.slice(lastSeq))
    }),
  }
  return { api: api as unknown as Api, raw: api, sessions, sent, failSends: (k: number) => (failNextSend = k) }
}

const settle = async (check: () => boolean) => {
  for (let i = 0; i < 100 && !check(); i++) await new Promise((r) => setTimeout(r, 10))
  expect(check()).toBe(true)
}

describe('chat store', () => {
  it('init 加载会话列表并打开最近一个', async () => {
    const { api } = fakeBackend()
    const store = createChatStore(api)
    await store.getState().init()
    expect(store.getState().currentId).toBe('s1')
    expect(store.getState().messages.map((m) => m.content)).toEqual(['你好', '你好！'])
    expect(store.getState().live).toBeNull()
  })

  it('发送消息：乐观展示 → 流式 → 结束后以服务端消息为准', async () => {
    const { api, sent } = fakeBackend()
    const store = createChatStore(api)
    await store.getState().init()

    const p = store.getState().send('  再问一个  ', { docId: 'doc-1' })
    expect(store.getState().messages.at(-1)).toMatchObject({ role: 'user', content: '再问一个' })
    await p
    expect(sent).toHaveLength(1)
    expect(sent[0]).toMatchObject({ docId: 'doc-1' })

    await settle(() => store.getState().live === null && store.getState().messages.at(-1)?.role === 'assistant')
    expect(store.getState().messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user', 'assistant'])
    // 乐观消息已被服务端消息替换，没有重复
    expect(store.getState().messages.filter((m) => m.content === '再问一个')).toHaveLength(1)
  })

  it('刷新后打开一个仍在生成的会话：重放事件重建流式文本，完成后落到消息里', async () => {
    const { api, sessions, raw } = fakeBackend()
    const store = createChatStore(api)
    const real = raw.openRunStream.getMockImplementation()!
    // 与真实服务端一致：任务先落库，再发出 run.done
    raw.openRunStream.mockImplementationOnce(async (runId: string, lastSeq: number) => {
      sessions.get('s2')!.messages.push(msg('a9', 'assistant', '第一段，第二段'))
      sessions.get('s2')!.activeRun = null
      return real(runId, lastSeq)
    })
    await store.getState().selectSession('s2')

    await settle(() => store.getState().live === null)
    expect(store.getState().messages.at(-1)?.content).toBe('第一段，第二段')
    expect(raw.openRunStream).toHaveBeenCalledTimes(1)
    expect(raw.openRunStream.mock.calls[0]![1]).toBe(0) // 刷新后从头重放
  })

  it('服务端仍报告刚结束的任务“进行中”时，不会陷入重复订阅的死循环', async () => {
    const { api, raw } = fakeBackend()
    const store = createChatStore(api)
    // 假后端故意不清 activeRun：run.done 收到后重新拉会话仍显示 run-live 进行中
    await store.getState().selectSession('s2')
    await settle(() => store.getState().live === null)
    await new Promise((r) => setTimeout(r, 50))
    expect(raw.openRunStream.mock.calls.length).toBeLessThanOrEqual(1)
  })

  it('打开进行中的会话时，先重放出已生成的文本', async () => {
    const { api, raw } = fakeBackend()
    const store = createChatStore(api)
    // 让流永远不结束，观察中间状态
    raw.openRunStream.mockImplementationOnce(async () =>
      sseResponse([frame(1, { type: 'run.start', runId: 'run-live' }), frame(2, { type: 'text.delta', text: '第一段，' })], { hang: true }),
    )
    await store.getState().selectSession('s2')
    await settle(() => store.getState().live?.text === '第一段，')
    expect(store.getState().live).toMatchObject({ runId: 'run-live', status: 'live' })
    store.getState().dispose()
  })

  it('发送失败（网络错误）会用同一个 clientMessageId 重试，且最终成功', async () => {
    const { api, sent, failSends } = fakeBackend()
    const store = createChatStore(api)
    await store.getState().init()
    failSends(2) // 前两次失败，第三次成功
    await store.getState().send('重试我')
    expect(sent).toHaveLength(3)
    // 关键：三次请求必须是同一个 clientMessageId，服务端才能据此去重
    expect(new Set(sent.map((s) => s.clientMessageId)).size).toBe(1)
    expect(store.getState().error).toBeNull()
    store.getState().dispose()
  })

  it('4xx 错误不重试，撤回乐观消息并给出错误', async () => {
    const { api, raw } = fakeBackend()
    const store = createChatStore(api)
    await store.getState().init()
    raw.sendMessage.mockRejectedValueOnce(new ApiError(409, '上一条消息仍在生成中'))
    await store.getState().send('被拒绝')
    expect(raw.sendMessage).toHaveBeenCalledTimes(1)
    expect(store.getState().error).toBe('上一条消息仍在生成中')
    expect(store.getState().messages.some((m) => m.content === '被拒绝')).toBe(false)
  })

  it('生成期间不允许再次发送', async () => {
    const { api, raw } = fakeBackend()
    const store = createChatStore(api)
    raw.openRunStream.mockImplementation(async () => sseResponse([frame(1, { type: 'run.start', runId: 'x' })], { hang: true }))
    await store.getState().init()
    await store.getState().send('第一条')
    await settle(() => store.getState().live !== null)
    await store.getState().send('第二条')
    expect(raw.sendMessage).toHaveBeenCalledTimes(1)
    store.getState().dispose()
  })

  it('快速切换会话时，慢返回的旧请求不会覆盖新会话', async () => {
    const { api, raw } = fakeBackend()
    const store = createChatStore(api)
    const real = raw.getSession.getMockImplementation()!
    raw.getSession.mockImplementation(async (id: string) => {
      if (id === 's1') await new Promise((r) => setTimeout(r, 60)) // s1 很慢
      return real(id)
    })
    const slow = store.getState().selectSession('s1')
    const fast = store.getState().selectSession('s2')
    await Promise.all([slow, fast])
    expect(store.getState().currentId).toBe('s2')
    expect(store.getState().messages.map((m) => m.content)).toEqual(['写文章'])
    store.getState().dispose()
  })

  it('run 已过期（404）时回退到以数据库为准', async () => {
    const { api, sessions, raw } = fakeBackend()
    const store = createChatStore(api)
    raw.openRunStream.mockImplementationOnce(async () => {
      // 服务端重启：内存里的任务日志没了（404），而数据库里已有完整消息、也没有进行中的任务
      sessions.get('s2')!.messages.push(msg('a9', 'assistant', '已经生成完的内容'))
      sessions.get('s2')!.activeRun = null
      return new Response('{}', { status: 404 })
    })
    await store.getState().selectSession('s2')
    await settle(() => store.getState().live === null)
    expect(store.getState().messages.at(-1)?.content).toBe('已经生成完的内容')
  })

  it('停止：调用后端取消接口', async () => {
    const { api, raw } = fakeBackend()
    const store = createChatStore(api)
    raw.openRunStream.mockImplementation(async () => sseResponse([frame(1, { type: 'run.start', runId: 'x' })], { hang: true }))
    await store.getState().init()
    await store.getState().send('长任务')
    await settle(() => store.getState().live !== null)
    await store.getState().stop()
    expect(raw.cancelRun).toHaveBeenCalledWith(store.getState().live!.runId)
    store.getState().dispose()
  })

  it('删除当前会话后自动切到下一个', async () => {
    const { api } = fakeBackend()
    const store = createChatStore(api)
    await store.getState().init()
    await store.getState().deleteSession('s1')
    expect(store.getState().currentId).toBe('s2')
    store.getState().dispose()
  })
})
