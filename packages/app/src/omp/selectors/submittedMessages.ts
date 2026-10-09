import { isJsonObject, type JsonValue } from '@ompiui/protocol'
import type { PiTimelineItem, SessionMessageEntry, UserMessage } from '../domain/index.js'

/** 已受理但尚未落盘的用户消息只参与展示，不能用其临时 ID 执行历史操作。 */
export function appendSubmittedUserMessages(items: PiTimelineItem[], submitted: JsonValue | undefined): PiTimelineItem[] {
  if (!Array.isArray(submitted) || submitted.length === 0) return items
  const pending: PiTimelineItem[] = []
  for (const record of submitted) {
    if (!isJsonObject(record) || typeof record.id !== 'string' || !isJsonObject(record.message)) continue
    const raw = record.message
    if (raw.role !== 'user' || typeof raw.timestamp !== 'number' || !Array.isArray(raw.content)) continue
    if (items.some(item => item.kind === 'user_message' && item.message.timestamp === raw.timestamp)) continue
    const message = raw as unknown as UserMessage
    const rawEntry: SessionMessageEntry = {
      type: 'message', id: record.id, parentId: null,
      timestamp: new Date(message.timestamp).toISOString(), message,
    }
    pending.push({
      kind: 'user_message', entryId: record.id, timestamp: message.timestamp,
      rawEntry, message, blocks: message.content as Exclude<UserMessage['content'], string>,
    })
  }
  return pending.length > 0 ? [...items, ...pending] : items
}
