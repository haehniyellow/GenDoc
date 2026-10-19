import { useState } from 'react'
import { ChatPanel } from '@doc/ai-chat'
import { api } from '../api'
import InsertToDocDialog from '../components/InsertToDocDialog'

export default function ChatPage() {
  const [pending, setPending] = useState<{ uuid: string; title: string } | null>(null)
  return (
    <div className="chat-page">
      {/* setPending 引用稳定，不会让对话面板重新创建 store */}
      <ChatPanel api={api} onInsertWidget={setPending} />
      {pending && <InsertToDocDialog widget={pending} onClose={() => setPending(null)} />}
    </div>
  )
}
