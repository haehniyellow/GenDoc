// use-sync-external-store/shim 的 ESM 替身。
// 该 shim 是给 React < 18 用的，且只提供 CommonJS 构建，内部 require('react')。
// React 被外置成 ESM import map（--mode cdn）后，打进产物的 CJS require 在浏览器里无法解析而白屏。
// React ≥ 18 自带 useSyncExternalStore，直接转出即可。
export { useSyncExternalStore } from 'react'
