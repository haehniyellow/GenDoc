import { describe, expect, it } from 'vitest'
import { readSSE, type SSEFrame } from './sse'

const enc = new TextEncoder()

function stream(chunks: Array<string | Uint8Array>): ReadableStream<Uint8Array> {
  let i = 0
  return new ReadableStream({
    pull(c) {
      if (i >= chunks.length) return c.close()
      const ch = chunks[i++]!
      c.enqueue(typeof ch === 'string' ? enc.encode(ch) : ch)
    },
  })
}

async function collect(chunks: Array<string | Uint8Array>, onActivity?: () => void): Promise<SSEFrame[]> {
  const out: SSEFrame[] = []
  for await (const f of readSSE(stream(chunks), onActivity)) out.push(f)
  return out
}

describe('readSSE', () => {
  it('解析 id / event / data', async () => {
    expect(await collect(['id: 7\nevent: text.delta\ndata: {"a":1}\n\n'])).toEqual([
      { id: '7', event: 'text.delta', data: '{"a":1}' },
    ])
  })

  it('没有 event 字段时默认为 message', async () => {
    expect((await collect(['data: hi\n\n']))[0]).toEqual({ id: undefined, event: 'message', data: 'hi' })
  })

  it('一个帧被切在任意位置的多个网络块里也能拼对', async () => {
    const whole = 'id: 1\nevent: e\ndata: hello\n\nid: 2\nevent: e\ndata: world\n\n'
    for (let cut = 1; cut < whole.length; cut++) {
      const frames = await collect([whole.slice(0, cut), whole.slice(cut)])
      expect(frames.map((f) => f.data)).toEqual(['hello', 'world'])
    }
  })

  it('多字节字符（中文）被切在字节中间时不会乱码', async () => {
    const bytes = enc.encode('data: 你好，世界\n\n')
    for (let cut = 1; cut < bytes.length; cut++) {
      const frames = await collect([bytes.slice(0, cut), bytes.slice(cut)])
      expect(frames[0]?.data).toBe('你好，世界')
    }
  })

  it('忽略注释行（心跳），且心跳也会触发 onActivity', async () => {
    let activity = 0
    const frames = await collect([': ping\n\n', 'data: x\n\n', ': ping\n\n'], () => activity++)
    expect(frames).toHaveLength(1)
    expect(activity).toBe(3)
  })

  it('多行 data 用换行连接', async () => {
    expect((await collect(['data: a\ndata: b\n\n']))[0]?.data).toBe('a\nb')
  })

  it('兼容 CRLF 换行', async () => {
    expect((await collect(['id: 1\r\ndata: x\r\n\r\n']))[0]).toMatchObject({ id: '1', data: 'x' })
  })

  it('冒号后没有空格也能解析；值里的冒号保留', async () => {
    expect((await collect(['data:{"t":"a:b"}\n\n']))[0]?.data).toBe('{"t":"a:b"}')
  })

  it('流结束时最后一个没有空行收尾的帧仍会交付', async () => {
    expect(await collect(['data: last'])).toHaveLength(1)
  })

  it('只有注释或空内容时不产生帧', async () => {
    expect(await collect([': only comment\n\n', '\n\n'])).toEqual([])
  })
})
