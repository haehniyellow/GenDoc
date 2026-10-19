import { describe, expect, it, vi } from 'vitest'
import { RPC_NAMESPACE, type RpcRequest, type WidgetDataProvider } from '@doc/shared'
import { handleRpc, type BridgeEntry } from './bridge'

function setup() {
  const provider: WidgetDataProvider = {
    get: vi.fn(async () => ({ n: 1 })),
    set: vi.fn(async () => {}),
    remove: vi.fn(async () => {}),
    keys: vi.fn(async () => ['a']),
  }
  const entry: BridgeEntry = { target: {} as Window, nonce: 'n', provider, onResize: vi.fn(), onError: vi.fn() }
  const req = (method: RpcRequest['method'], params?: Record<string, unknown>): RpcRequest => ({
    ns: RPC_NAMESPACE,
    kind: 'req',
    nonce: 'n',
    id: 1,
    method,
    params,
  })
  return { provider, entry, req }
}

describe('handleRpc', () => {
  it('转发读写到 provider', async () => {
    const { provider, entry, req } = setup()
    expect(await handleRpc(entry, req('storage.get', { key: 'count' }))).toEqual({ n: 1 })
    await handleRpc(entry, req('storage.set', { key: 'count', value: [1, 2] }))
    expect(provider.set).toHaveBeenCalledWith('count', [1, 2])
    expect(await handleRpc(entry, req('storage.keys'))).toEqual(['a'])
  })

  it('拒绝非法 key', async () => {
    const { provider, entry, req } = setup()
    for (const key of ['', 'a/b', '../x', 'a'.repeat(129), 42 as unknown as string]) {
      await expect(handleRpc(entry, req('storage.get', { key }))).rejects.toThrow('key')
    }
    expect(provider.get).not.toHaveBeenCalled()
  })

  it('拒绝超大 value', async () => {
    const { provider, entry, req } = setup()
    await expect(handleRpc(entry, req('storage.set', { key: 'k', value: 'x'.repeat(70 * 1024) }))).rejects.toThrow('上限')
    expect(provider.set).not.toHaveBeenCalled()
  })

  it('ui.resize 会被限制在合理范围', async () => {
    const { entry, req } = setup()
    await handleRpc(entry, req('ui.resize', { height: 999999 }))
    await handleRpc(entry, req('ui.resize', { height: 1 }))
    expect(entry.onResize).toHaveBeenNthCalledWith(1, 2000)
    expect(entry.onResize).toHaveBeenNthCalledWith(2, 40)
  })
})
