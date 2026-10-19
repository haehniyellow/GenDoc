export interface SSEFrame {
  id?: string
  event: string
  data: string
}

function parseFrame(raw: string): SSEFrame | null {
  let id: string | undefined
  let event = 'message'
  const data: string[] = []
  for (const line of raw.split('\n')) {
    if (!line || line.startsWith(':')) continue // 空行与注释（心跳）
    const i = line.indexOf(':')
    const field = i === -1 ? line : line.slice(0, i)
    let value = i === -1 ? '' : line.slice(i + 1)
    if (value.startsWith(' ')) value = value.slice(1)
    if (field === 'id') id = value
    else if (field === 'event') event = value
    else if (field === 'data') data.push(value)
  }
  if (data.length === 0) return null
  return { id, event, data: data.join('\n') }
}

/**
 * 把 fetch 返回的 ReadableStream 解析成 SSE 帧。
 * 不使用 EventSource：它无法自定义 Authorization 头，也无法控制重连位点。
 * @param onActivity 收到任何字节（包括心跳注释）时回调，用于上层做“卡死检测”
 */
export async function* readSSE(
  body: ReadableStream<Uint8Array>,
  onActivity?: () => void,
): AsyncGenerator<SSEFrame> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buf = ''
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      onActivity?.()
      buf += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n')
      let idx: number
      while ((idx = buf.indexOf('\n\n')) >= 0) {
        const frame = parseFrame(buf.slice(0, idx))
        buf = buf.slice(idx + 2)
        if (frame) yield frame
      }
    }
    buf += decoder.decode()
    if (buf.trim()) {
      const frame = parseFrame(buf)
      if (frame) yield frame
    }
  } finally {
    try {
      await reader.cancel()
    } catch {
      /* 已关闭 */
    }
  }
}
