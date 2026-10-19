import type { RunEvent } from '@doc/shared'

const enc = new TextEncoder()

export function frame(seq: number, ev: RunEvent): string {
  return `id: ${seq}\nevent: ${ev.type}\ndata: ${JSON.stringify(ev)}\n\n`
}

export interface FakeStreamOptions {
  /** 发完所有 chunk 后让流报错（模拟断网） */
  failAfter?: boolean
  /** 发完所有 chunk 后永远挂起（模拟半开连接，只能靠空闲超时发现） */
  hang?: boolean
  signal?: AbortSignal
}

/**
 * 用给定的文本块构造一个 SSE 响应流。
 * 用 pull 逐块投递：controller.error() 会丢弃队列里尚未被读取的数据，
 * 必须等消费者把前面的块都读走之后再报错，才能模拟“收到了一部分数据后断线”。
 */
export function sseResponse(chunks: string[], opts: FakeStreamOptions = {}): Response {
  let i = 0
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (i < chunks.length) {
        controller.enqueue(enc.encode(chunks[i++]!))
        return
      }
      if (opts.failAfter) {
        controller.error(new Error('network down'))
      } else if (opts.hang) {
        await new Promise<void>((resolve) => {
          if (opts.signal?.aborted) return resolve()
          opts.signal?.addEventListener('abort', () => resolve(), { once: true })
        })
        try {
          controller.error(new DOMException('aborted', 'AbortError'))
        } catch {
          /* 已关闭 */
        }
      } else {
        controller.close()
      }
    },
  })
  return new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } })
}
