import ReactMarkdown from 'react-markdown'

/** 单独成文件是为了被 React.lazy 动态加载：react-markdown 及其依赖不进入首屏包 */
export default function Markdown({ text }: { text: string }) {
  return (
    <div className="md">
      <ReactMarkdown>{text}</ReactMarkdown>
    </div>
  )
}
