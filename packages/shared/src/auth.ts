const TOKEN_KEY = 'doc.token'

export function getToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY)
  } catch {
    return null
  }
}

export function setToken(token: string | null): void {
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token)
    else localStorage.removeItem(TOKEN_KEY)
  } catch {
    /* 隐私模式下 localStorage 可能不可用 */
  }
}

/** 任何请求收到 401 时广播此事件，AuthGate 监听后回到登录页 */
export const UNAUTHORIZED_EVENT = 'doc:unauthorized'

export function notifyUnauthorized(): void {
  setToken(null)
  window.dispatchEvent(new Event(UNAUTHORIZED_EVENT))
}

/** 组件代码被修改（如 AI 局部修改成功）后广播，文档里已渲染的同一组件据此重新拉取代码 */
export const WIDGET_UPDATED_EVENT = 'doc:widget-updated'

export function notifyWidgetUpdated(uuid: string): void {
  window.dispatchEvent(new CustomEvent(WIDGET_UPDATED_EVENT, { detail: { uuid } }))
}
