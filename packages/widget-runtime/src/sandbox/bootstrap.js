/* 运行在 sandbox iframe 内部的引导脚本。以纯文本形式（?raw）内联进 srcdoc，不经过打包。
 * 配置对象（{ns, nonce, hostOrigin}）由 srcdoc.ts 在构建 srcdoc 时注入到下面的 CFG 常量。
 * 组件代码通过 window.__mount(factory) 交给这里执行；组件只能 require('react') 和 require('@sdk')。 */
(function () {
  'use strict'
  var CFG = __CONFIG__
  var React = window.React
  var ReactDOM = window.ReactDOM
  var parentWin = window.parent
  var seq = 0
  var pending = {}
  var RPC_TIMEOUT_MS = 15000

  function post(msg) {
    parentWin.postMessage(msg, CFG.hostOrigin)
  }

  function call(method, params) {
    return new Promise(function (resolve, reject) {
      var id = ++seq
      var timer = setTimeout(function () {
        delete pending[id]
        reject(new Error('请求超时：' + method))
      }, RPC_TIMEOUT_MS)
      pending[id] = { resolve: resolve, reject: reject, timer: timer }
      post({ ns: CFG.ns, kind: 'req', nonce: CFG.nonce, id: id, method: method, params: params || {} })
    })
  }

  // 只接受来自父窗口的响应，其他来源（含同页其他 iframe）一律忽略
  window.addEventListener('message', function (e) {
    if (e.source !== parentWin) return
    var m = e.data
    if (!m || m.ns !== CFG.ns || m.kind !== 'res') return
    var p = pending[m.id]
    if (!p) return
    delete pending[m.id]
    clearTimeout(p.timer)
    if (m.ok) p.resolve(m.result)
    else p.reject(new Error(m.error || '请求失败'))
  })

  function reportError(message) {
    call('log.error', { message: String(message).slice(0, 2000) }).catch(function () {})
  }

  window.addEventListener('error', function (e) {
    reportError(e.message + (e.lineno ? ' (行 ' + e.lineno + ')' : ''))
  })
  window.addEventListener('unhandledrejection', function (e) {
    reportError('未处理的异步错误：' + (e.reason && e.reason.message ? e.reason.message : e.reason))
  })

  var storage = {
    get: function (key) {
      return call('storage.get', { key: key })
    },
    set: function (key, value) {
      return call('storage.set', { key: key, value: value })
    },
    remove: function (key) {
      return call('storage.remove', { key: key })
    },
    keys: function () {
      return call('storage.keys')
    },
  }

  /** useState 的持久化版本：首次挂载从后端读取，之后每次修改 300ms 防抖写回 */
  function useWidgetState(key, initial) {
    var useState = React.useState
    var useRef = React.useRef
    var useEffect = React.useEffect
    var useCallback = React.useCallback

    var pair = useState(initial)
    var state = pair[0]
    var setState = pair[1]
    var loadingPair = useState(true)
    var latest = useRef(state)
    var dirty = useRef(false)
    var timer = useRef(null)

    useEffect(
      function () {
        var alive = true
        storage
          .get(key)
          .then(function (v) {
            // 用户在加载完成前已经操作过，则保留用户的输入，不被旧数据覆盖
            if (alive && !dirty.current && v !== null && v !== undefined) {
              latest.current = v
              setState(v)
            }
          })
          .catch(function (err) {
            reportError('读取 ' + key + ' 失败：' + err.message)
          })
          .then(function () {
            if (alive) loadingPair[1](false)
          })
        return function () {
          alive = false
        }
      },
      [key],
    )

    var set = useCallback(
      function (next) {
        var value = typeof next === 'function' ? next(latest.current) : next
        latest.current = value
        dirty.current = true
        setState(value)
        clearTimeout(timer.current)
        timer.current = setTimeout(function () {
          storage.set(key, value).catch(function (err) {
            reportError('保存 ' + key + ' 失败：' + err.message)
          })
        }, 300)
      },
      [key],
    )

    return [state, set, { loading: loadingPair[0] }]
  }

  var sdk = { storage: storage, useWidgetState: useWidgetState }
  var modules = { react: React, '@sdk': sdk }

  function requireModule(name) {
    if (Object.prototype.hasOwnProperty.call(modules, name)) return modules[name]
    throw new Error('不允许导入模块：' + name)
  }

  class ErrorBoundary extends React.Component {
    constructor(props) {
      super(props)
      this.state = { error: null }
    }
    static getDerivedStateFromError(error) {
      return { error: error }
    }
    componentDidCatch(error) {
      reportError('渲染错误：' + (error && error.message ? error.message : error))
    }
    render() {
      if (this.state.error) {
        return React.createElement(
          'pre',
          { style: { color: '#b42318', whiteSpace: 'pre-wrap', margin: 0, font: '12px/1.5 ui-monospace,monospace' } },
          '组件渲染出错：' + this.state.error.message,
        )
      }
      return this.props.children
    }
  }

  window.__mount = function (factory) {
    var module = { exports: {} }
    factory(requireModule, module.exports, module, React)
    var Component = module.exports.default || module.exports
    if (typeof Component !== 'function') throw new Error('组件必须 export default 一个函数组件')
    ReactDOM.createRoot(document.getElementById('root')).render(
      React.createElement(ErrorBoundary, null, React.createElement(Component)),
    )
    reportHeight()
  }

  // 高度上报：宿主可选择跟随内容自适应
  var lastHeight = 0
  function reportHeight() {
    var h = Math.ceil(document.documentElement.getBoundingClientRect().height)
    if (h && h !== lastHeight) {
      lastHeight = h
      call('ui.resize', { height: h }).catch(function () {})
    }
  }
  if (window.ResizeObserver) new ResizeObserver(reportHeight).observe(document.documentElement)
})()
