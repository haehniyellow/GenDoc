/** 防止代码里出现 </script> 或 <!-- 让 HTML 解析器提前结束内联脚本 / 进入“双重转义”状态。
 *  替换后的字面量在 JS 字符串、正则、注释里的语义都不变。 */
export function escapeInlineScript(js: string): string {
  return js.replace(/<\/(script)/gi, '<\\/$1').replace(/<!--/g, '<\\!--')
}

const CONFIG_PLACEHOLDER = '__CONFIG__'

/** 把配置注入引导脚本。占位符出现次数必须恰好为 1：模板被改坏时宁可直接报错，也不要带着未替换的占位符运行 */
export function injectConfig(script: string, config: string): string {
  const parts = script.split(CONFIG_PLACEHOLDER)
  if (parts.length !== 2) {
    throw new Error(`bootstrap.js 中的 ${CONFIG_PLACEHOLDER} 占位符应恰好出现 1 次，实际 ${parts.length - 1} 次`)
  }
  return parts[0] + config + parts[1]
}
