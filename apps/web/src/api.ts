import { createApi, getToken, notifyUnauthorized } from '@doc/shared'

// 开发时 /api 由 Vite 代理到后端；生产环境同域部署或用 VITE_API_BASE 指向后端
export const api = createApi({
  baseURL: import.meta.env.VITE_API_BASE ?? '',
  getToken,
  onUnauthorized: notifyUnauthorized,
})
