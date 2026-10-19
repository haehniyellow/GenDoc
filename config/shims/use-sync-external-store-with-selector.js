// use-sync-external-store/shim/with-selector 的 ESM 替身，原因见 use-sync-external-store.js。
// 语义与官方实现一致：基于 React 内置的 useSyncExternalStore，对 selector 的结果做记忆化，
// 只有 selection 真正变化（isEqual 判定）时才让组件重新渲染。
import { useEffect, useMemo, useRef, useSyncExternalStore } from 'react'

export function useSyncExternalStoreWithSelector(subscribe, getSnapshot, getServerSnapshot, selector, isEqual) {
  const instRef = useRef(null)
  if (instRef.current === null) instRef.current = { hasValue: false, value: null }
  const inst = instRef.current

  const [getSelection, getServerSelection] = useMemo(() => {
    let hasMemo = false
    let memoizedSnapshot
    let memoizedSelection

    const memoizedSelector = (nextSnapshot) => {
      if (!hasMemo) {
        hasMemo = true
        memoizedSnapshot = nextSnapshot
        const nextSelection = selector(nextSnapshot)
        // 重新挂载时复用上一次渲染得到的 selection，保持引用稳定
        if (isEqual !== undefined && inst.hasValue && isEqual(inst.value, nextSelection)) {
          memoizedSelection = inst.value
          return memoizedSelection
        }
        memoizedSelection = nextSelection
        return nextSelection
      }
      if (Object.is(memoizedSnapshot, nextSnapshot)) return memoizedSelection
      const nextSelection = selector(nextSnapshot)
      memoizedSnapshot = nextSnapshot
      if (isEqual !== undefined && isEqual(memoizedSelection, nextSelection)) return memoizedSelection
      memoizedSelection = nextSelection
      return nextSelection
    }

    return [
      () => memoizedSelector(getSnapshot()),
      getServerSnapshot === undefined || getServerSnapshot === null ? undefined : () => memoizedSelector(getServerSnapshot()),
    ]
  }, [getSnapshot, getServerSnapshot, selector, isEqual, inst])

  const value = useSyncExternalStore(subscribe, getSelection, getServerSelection)
  useEffect(() => {
    inst.hasValue = true
    inst.value = value
  }, [inst, value])
  return value
}
