import { StrictMode, Suspense, lazy } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter, Route, Routes } from 'react-router-dom'
import { AuthGate } from '@doc/ui'
import '@doc/ui/styles.css'
import './app.css'
import { api } from './api'
import Layout from './components/Layout'

// 路由级代码分割：每个页面按需下载。文档列表页不需要编辑器（TipTap），对话页不需要编辑器，
// 只有进入 /doc/:id 才会加载编辑器与 AI 面板。
const DocList = lazy(() => import('./pages/DocList'))
const ChatPage = lazy(() => import('./pages/ChatPage'))
const DocPage = lazy(() => import('./pages/DocPage'))

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {/* 整个站点只登录一次：文档与 AI 对话共用同一个 origin 与令牌 */}
    <AuthGate api={api} title="知识库 · AI 内容平台">
      <BrowserRouter>
        <Suspense fallback={<div className="center-fill">加载中…</div>}>
          <Routes>
            <Route element={<Layout />}>
              <Route path="/" element={<DocList />} />
              <Route path="/chat" element={<ChatPage />} />
            </Route>
            {/* 编辑器占满整屏，自带顶栏 */}
            <Route path="/doc/:id" element={<DocPage />} />
            <Route path="*" element={<div className="center-fill">页面不存在</div>} />
          </Routes>
        </Suspense>
      </BrowserRouter>
    </AuthGate>
  </StrictMode>,
)
