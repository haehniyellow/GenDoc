import { NavLink, Outlet } from 'react-router-dom'
import { useAuth } from '@doc/ui'

/** 文档列表页与 AI 对话页共用的顶栏：站内导航 + 当前用户 */
export default function Layout() {
  const { user, logout } = useAuth()
  return (
    <div className="page">
      <header className="topbar">
        <strong className="brand">知识库</strong>
        <nav className="nav">
          <NavLink to="/" end>
            文档
          </NavLink>
          <NavLink to="/chat">AI 对话</NavLink>
        </nav>
        <span style={{ flex: 1 }} />
        <span className="muted">{user.username}</span>
        <button className="btn small ghost" onClick={logout}>
          退出
        </button>
      </header>
      <div className="page-body">
        <Outlet />
      </div>
    </div>
  )
}
