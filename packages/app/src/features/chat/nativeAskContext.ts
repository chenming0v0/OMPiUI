import { createContext } from 'react'
import type { NativeAskRequest } from './nativeAskMatching'

export type AskSlot = { requestKey: string; inline: boolean; element: HTMLDivElement; onLayoutChange?: () => void }
type InlineAskContext = {
  requestsByCall: Map<string, NativeAskRequest>
  register: (token: symbol, slot: AskSlot | null) => void
}

// 与组件实现分开，避免热更新表单时重建 Context、让现有插槽失去 Provider。
export const InlineAskRequestsContext = createContext<InlineAskContext | null>(null)
