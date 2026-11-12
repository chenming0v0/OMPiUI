import type { AgentMessage } from './vendor/pi-agent-core'
import type { SessionEntry } from './vendor/pi-coding-agent'
import type { PiCustomMessageItem } from './domain'

export function isInjectedMessage(message: AgentMessage): message is Extract<AgentMessage, { role: 'custom' | 'developer' | 'hookMessage' }> {
  return message.role === 'custom' || message.role === 'developer' || message.role === 'hookMessage'
}

export function injectedMessageItem(entry: Extract<SessionEntry, { type: 'message' }>): PiCustomMessageItem | undefined {
  const message = entry.message
  if (!isInjectedMessage(message)) return
  return {
    kind: 'custom_message', entryId: entry.id, timestamp: Date.parse(entry.timestamp), rawEntry: entry,
    customType: message.customType ?? message.role, content: message.content,
    display: message.display !== false, details: message.details,
    injectedRole: message.role, attribution: message.attribution ?? 'agent',
  }
}

/** 同一次注入可经 message 帧和 custom_message 落盘；时间戳防止吞掉后续同文提醒。 */
export function matchesInjectedMessage(entry: SessionEntry, live: { id: string; message: AgentMessage }): boolean {
  if (!isInjectedMessage(live.message)) return false
  const message = entry.type === 'message' && isInjectedMessage(entry.message) ? entry.message
    : entry.type === 'custom_message' ? { ...entry, timestamp: Date.parse(entry.timestamp) } : undefined
  if (!message) return false
  if (entry.id === live.id) return true
  return message.timestamp === live.message.timestamp
    && (message.attribution ?? 'agent') === (live.message.attribution ?? 'agent')
    && (!message.customType || !live.message.customType || message.customType === live.message.customType)
    && JSON.stringify(message.content) === JSON.stringify(live.message.content)
}
