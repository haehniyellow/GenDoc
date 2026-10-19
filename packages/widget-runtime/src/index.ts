export { WidgetFrame, type WidgetFrameProps } from './WidgetFrame'
export { compileWidget, getCompiler, createCompiler, CompileError } from './compiler'
export { validateCompiled, formatViolations, ALLOWED_MODULES, type Violation } from './policy'
export { widgetBridge, WidgetBridge, handleRpc, type BridgeEntry } from './bridge'
