import type { JsonObject } from '@ompiui/protocol'

export type OmpSubagentTranscriptItem = {
  kind: 'user' | 'assistant' | 'tool'
  text: string
  messageId?: string
  toolCallId?: string
  toolName?: string
  toolTitle?: string
  toolStatus?: 'pending' | 'running' | 'completed' | 'error'
  isError?: boolean
  timestamp: number
  /** 消息快照仍在生成，后续 update/end 更新同一组而不是追加气泡。 */
  streaming?: boolean
}

const MAX_TRANSCRIPT_ITEMS = 200
let messageSequence = 0

function record(value: unknown): JsonObject | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as JsonObject) : undefined
}

function string(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function textFromMessage(message: JsonObject): string {
  if (typeof message.content === 'string') return message.content
  if (!Array.isArray(message.content)) return ''
  return message.content
    .map(block => {
      const part = record(block)
      return part?.type === 'text' ? (string(part.text) ?? '') : ''
    })
    .filter(Boolean)
    .join('\n')
}

function newMessageId(): string {
  return `subagent-message-${++messageSequence}`
}

function append(
  items: OmpSubagentTranscriptItem[],
  item: Omit<OmpSubagentTranscriptItem, 'timestamp'>,
): OmpSubagentTranscriptItem[] {
  const next = [...items, { ...item, timestamp: Date.now() }]
  const tail = next.slice(-MAX_TRANSCRIPT_ITEMS)
  const firstUser = next.find(part => part.kind === 'user')
  return firstUser && !tail.includes(firstUser) ? [firstUser, ...tail.slice(1)] : tail
}

function updateTool(
  items: OmpSubagentTranscriptItem[],
  tool: Omit<OmpSubagentTranscriptItem, 'kind' | 'text' | 'timestamp'>,
): OmpSubagentTranscriptItem[] {
  const index = tool.toolCallId
    ? items.findIndex(item => item.kind === 'tool' && item.toolCallId === tool.toolCallId)
    : items.findIndex(
        item =>
          item.kind === 'tool' &&
          item.toolName === tool.toolName &&
          (item.toolStatus === 'pending' || item.toolStatus === 'running'),
      )
  if (index < 0) return append(items, { kind: 'tool', text: '', ...tool })
  const previous = items[index]
  const settled = previous.toolStatus === 'completed' || previous.toolStatus === 'error'
  const status =
    settled && (tool.toolStatus === 'pending' || tool.toolStatus === 'running')
      ? previous.toolStatus
      : (tool.toolStatus ?? previous.toolStatus)
  return items.map((item, position) =>
    position === index
      ? {
          ...previous,
          toolTitle: tool.toolTitle ?? previous.toolTitle,
          toolStatus: status,
          isError: status === 'error',
          streaming: tool.streaming ?? previous.streaming,
        }
      : item,
  )
}

function assistantSnapshot(
  items: OmpSubagentTranscriptItem[],
  message: JsonObject,
  type: string,
  explicitId?: string,
): OmpSubagentTranscriptItem[] {
  const open = type === 'message_start' ? undefined : items.findLast(item => item.streaming)
  const messageId = explicitId ?? string(message.id) ?? open?.messageId ?? newMessageId()
  let next =
    type === 'message_start' ? items.map(item => (item.streaming ? { ...item, streaming: false } : item)) : items
  const streaming = type !== 'message_end'
  const text = textFromMessage(message)
  const textIndex = next.findIndex(item => item.kind === 'assistant' && item.messageId === messageId)
  if (textIndex >= 0) {
    next = next.map((item, index) => (index === textIndex ? { ...item, text: text || item.text, streaming } : item))
  } else if (text) {
    next = append(next, { kind: 'assistant', text, messageId, streaming })
  }
  if (Array.isArray(message.content)) {
    for (const raw of message.content) {
      const part = record(raw)
      if (part?.type !== 'toolCall') continue
      next = updateTool(next, {
        messageId,
        toolCallId: string(part.id),
        toolName: string(part.name) ?? 'tool',
        toolTitle: string(part.title),
        toolStatus: 'pending',
        streaming,
      })
    }
  }
  return streaming
    ? next
    : next.map(item => (item.messageId === messageId && item.streaming ? { ...item, streaming: false } : item))
}

/** OMP 的累计消息快照和工具事件统一成消息组，工具开始与结束更新同一枚徽标。 */
export function appendTranscriptEvent(
  event: JsonObject,
  items: OmpSubagentTranscriptItem[],
): OmpSubagentTranscriptItem[] {
  const type = string(event.type) ?? ''
  const message = record(event.message)
  if ((type === 'message_start' || type === 'message_update' || type === 'message_end') && message) {
    if (message.role === 'assistant') return assistantSnapshot(items, message, type, string(event.messageId))
    if (message.role !== 'user' || type !== 'message_end') return items
    const text = textFromMessage(message)
    if (!text || (items.at(-1)?.kind === 'user' && items.at(-1)?.text === text)) return items
    return append(items, { kind: 'user', text, messageId: string(message.id) ?? newMessageId() })
  }
  if (type === 'tool_execution_start' || type === 'tool_execution_end') {
    const last = items.at(-1)
    return updateTool(items, {
      messageId: last?.kind !== 'user' ? (last?.messageId ?? newMessageId()) : newMessageId(),
      toolCallId: string(event.toolCallId),
      toolName: string(event.toolName) ?? 'tool',
      toolTitle: string(event.title),
      toolStatus: type === 'tool_execution_start' ? 'running' : event.isError === true ? 'error' : 'completed',
      isError: event.isError === true,
    })
  }
  return items
}

/** 磁盘消息沿用相同分组与调用身份，打开历史后的布局与实时预览保持一致。 */
export function transcriptItemsFromMessages(messages: unknown[]): OmpSubagentTranscriptItem[] {
  let items: OmpSubagentTranscriptItem[] = []
  for (const [index, raw] of messages.entries()) {
    const message = record(raw)
    if (!message) continue
    if (message.role === 'assistant') {
      items = assistantSnapshot(items, message, 'message_end', string(message.id) ?? `disk-message-${index}`)
    } else if (message.role === 'user') {
      const text = textFromMessage(message)
      if (text) items = append(items, { kind: 'user', text, messageId: `disk-message-${index}` })
    } else if (message.role === 'toolResult') {
      const last = items.at(-1)
      items = updateTool(items, {
        messageId: last?.kind !== 'user' ? (last?.messageId ?? `disk-message-${index}`) : `disk-message-${index}`,
        toolCallId: string(message.toolCallId),
        toolName: string(message.toolName) ?? 'tool',
        toolStatus: message.isError === true ? 'error' : 'completed',
        isError: message.isError === true,
      })
    }
  }
  return items
}
