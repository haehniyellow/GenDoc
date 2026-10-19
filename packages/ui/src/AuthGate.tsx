import { createContext, useCallback, useContext, useEffect, useState, type FormEvent, type ReactNode } from 'react'
import { ApiError, UNAUTHORIZED_EVENT, getToken, setToken, type Api, type User } from '@doc/shared'

interface AuthValue {
  user: User
  logout: () => void
}

const AuthContext = createContext<AuthValue | null>(null)

export function useAuth(): AuthValue {
  const v = useContext(AuthContext)
  if (!v) throw new Error('useAuth 必须在 <AuthGate> 内使用')
  return v
}

type State = { kind: 'checking' } | { kind: 'anonymous' } | { kind: 'authed'; user: User }

/** 登录门：没有有效 token 时展示登录 / 注册表单，登录后渲染 children */
export function AuthGate({ api, title, children }: { api: Api; title: string; children: ReactNode }) {
  const [state, setState] = useState<State>(() => (getToken() ? { kind: 'checking' } : { kind: 'anonymous' }))

  useEffect(() => {
    if (state.kind !== 'checking') return
    let alive = true
    api.me().then(
      (user) => alive && setState({ kind: 'authed', user }),
      () => alive && setState({ kind: 'anonymous' }),
    )
    return () => {
      alive = false
    }
  }, [api, state.kind])

  useEffect(() => {
    const onUnauthorized = () => setState({ kind: 'anonymous' })
    window.addEventListener(UNAUTHORIZED_EVENT, onUnauthorized)
    return () => window.removeEventListener(UNAUTHORIZED_EVENT, onUnauthorized)
  }, [])

  const logout = useCallback(() => {
    setToken(null)
    setState({ kind: 'anonymous' })
  }, [])

  if (state.kind === 'checking') return <div className="center-fill">加载中…</div>
  if (state.kind === 'anonymous') {
    return <LoginForm api={api} title={title} onAuthed={(user) => setState({ kind: 'authed', user })} />
  }
  return <AuthContext.Provider value={{ user: state.user, logout }}>{children}</AuthContext.Provider>
}

function LoginForm({ api, title, onAuthed }: { api: Api; title: string; onAuthed: (u: User) => void }) {
  const [mode, setMode] = useState<'login' | 'register'>('login')
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  async function submit(e: FormEvent) {
    e.preventDefault()
    setBusy(true)
    setError('')
    try {
      const res = await (mode === 'login' ? api.login : api.register)(username.trim(), password)
      setToken(res.token)
      onAuthed(res.user)
    } catch (err) {
      setError(err instanceof ApiError ? err.message : '网络错误，请检查后端服务是否已启动')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="auth-page">
      <div className="auth-card">
        <h1>{title}</h1>
        <div className="muted">{mode === 'login' ? '登录以继续' : '创建一个新账号'}</div>
        <form onSubmit={submit}>
          <label>
            用户名
            <input
              className="input"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              autoComplete="username"
              autoFocus
              required
            />
          </label>
          <label>
            密码{mode === 'register' && '（至少 8 位）'}
            <input
              className="input"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
              required
            />
          </label>
          {error && <div className="error-text">{error}</div>}
          <button className="btn primary" disabled={busy}>
            {busy ? '请稍候…' : mode === 'login' ? '登录' : '注册并登录'}
          </button>
        </form>
        <p style={{ marginBottom: 0 }}>
          <button
            type="button"
            className="btn ghost small"
            onClick={() => {
              setMode(mode === 'login' ? 'register' : 'login')
              setError('')
            }}
          >
            {mode === 'login' ? '没有账号？去注册' : '已有账号？去登录'}
          </button>
        </p>
      </div>
    </div>
  )
}
