import { createContext, useContext } from 'react'
import { useStore } from 'zustand'
import type { Api } from '@doc/shared'
import type { ChatState, ChatStore } from './store'

export interface ChatContextValue {
  api: Api
  store: ChatStore
  /** 组件卡片上的“插入文档”动作；不传则不显示该按钮（如独立的对话页） */
  onInsertWidget?: (w: { uuid: string; title: string }) => void
}

export const ChatContext = createContext<ChatContextValue | null>(null)

export function useChatContext(): ChatContextValue {
  const v = useContext(ChatContext)
  if (!v) throw new Error('必须在 <ChatPanel> 内使用')
  return v
}

export function useChat<T>(selector: (s: ChatState) => T): T {
  return useStore(useChatContext().store, selector)
}
