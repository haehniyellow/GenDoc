import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig, type Plugin, type UserConfigFn } from 'vite'
import react from '@vitejs/plugin-react'
import { visualizer } from 'rollup-plugin-visualizer'

const shim = (name: string) => join(dirname(fileURLToPath(import.meta.url)), 'shims', name)

/**
 * CDN 外置：把 react / react-dom 从产物里剔除，运行时通过 import map 从 CDN 加载。
 *
 * 为什么用 import map 而不是常见的 vite-plugin-cdn-import：后者依赖库提供 UMD 构建，
 * 而 React 19 已经移除了 UMD。import map 走原生 ESM，TipTap / zustand 等第三方包里的
 * `import 'react'` 也会被同一份映射解析，保证页面里只有一份 React 实例。
 *
 * 默认关闭，用 vite build --mode cdn 开启。开启前请确认目标用户所在地区能稳定访问该 CDN。
 */
function cdnImportMap(enabled: boolean, cdn: string, appDir: string): Plugin {
  // 从应用目录解析，拿到的是该应用实际安装的版本，避免 import map 与打包时的版本不一致
  const require = createRequire(join(appDir, 'package.json'))
  const version = (pkg: string) => (require(`${pkg}/package.json`) as { version: string }).version
  const react_ = version('react')
  const dom = version('react-dom')
  const imports: Record<string, string> = {
    react: `${cdn}/react@${react_}`,
    'react/jsx-runtime': `${cdn}/react@${react_}/jsx-runtime`,
    // external=react：保持 react-dom 内部对 react 的引用为裸模块名，由 import map 统一解析
    'react-dom': `${cdn}/react-dom@${dom}?external=react`,
    'react-dom/client': `${cdn}/react-dom@${dom}/client?external=react`,
  }
  return {
    name: 'cdn-import-map',
    apply: 'build',
    config() {
      if (!enabled) return
      return {
        build: { rollupOptions: { external: Object.keys(imports) } },
        resolve: {
          // 外置 React 后，依赖里的 CommonJS `require('react')` 无法在浏览器中解析（页面白屏）。
          // @tiptap/react 依赖的 use-sync-external-store 就是这种情况，用基于 React 内置 API 的 ESM 替身替换。
          // 新增依赖后如果 CDN 构建白屏，先在产物里搜 `require`，多半是同类问题。
          alias: [
            { find: /^use-sync-external-store\/shim\/index(\.js)?$/, replacement: shim('use-sync-external-store.js') },
            { find: /^use-sync-external-store\/shim\/with-selector(\.js)?$/, replacement: shim('use-sync-external-store-with-selector.js') },
          ],
        },
      }
    },
    transformIndexHtml() {
      if (!enabled) return
      return [{ tag: 'script', attrs: { type: 'importmap' }, children: JSON.stringify({ imports }), injectTo: 'head-prepend' as const }]
    },
  }
}

export interface AppConfigOptions {
  /** 应用目录，传 import.meta.dirname */
  appDir: string
  port: number
  /** 启动开发服务器后自动打开浏览器（设置环境变量 BROWSER=none 可关闭） */
  open?: boolean
  /** 后端地址，开发时 /api 代理到这里 */
  apiTarget?: string
}

/**
 * 构建模式：
 *   vite build                默认生产构建
 *   vite build --mode analyze 额外生成 stats.html（依赖体积树图）
 *   vite build --mode cdn     react / react-dom 走 CDN import map（可用 VITE_CDN_BASE 换 CDN 源）
 */
export function createAppConfig({ appDir, port, open = false, apiTarget = 'http://localhost:8080' }: AppConfigOptions): UserConfigFn {
  return defineConfig(({ mode }) => {
  const analyze = mode === 'analyze'
  const cdn = mode === 'cdn'
  const cdnBase = process.env.VITE_CDN_BASE ?? 'https://esm.sh'

  return {
    plugins: [
      react(),
      cdnImportMap(cdn, cdnBase, appDir),
      // ANALYZE=1 时生成 stats.html，用来分析各依赖在产物里的体积占比
      analyze && visualizer({ filename: 'stats.html', gzipSize: true, brotliSize: true, template: 'treemap' }),
    ],
    server: {
      port,
      open,
      strictPort: true,
      // SSE 需要代理保持长连接、不缓冲；vite 的 http-proxy 默认满足
      proxy: { '/api': { target: apiTarget, changeOrigin: true } },
    },
    preview: { port, proxy: { '/api': { target: apiTarget, changeOrigin: true } } },
    build: {
      target: 'es2022',
      chunkSizeWarningLimit: 600,
      rollupOptions: {
        output: {
          // 框架代码变动少，单独成块以利用长期缓存；业务代码变更不会让它失效
          manualChunks(id: string) {
            if (/node_modules[\\/](react|react-dom|scheduler)[\\/]/.test(id)) return 'react-vendor'
            return undefined
          },
        },
      },
    },
  }
  })
}
