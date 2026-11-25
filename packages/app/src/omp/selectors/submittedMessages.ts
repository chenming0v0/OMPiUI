import { isJsonObject, type JsonValue } from '@ompiui/protocol'
import type { PiTimelineItem, SessionMessageEntry, UserMessage } from '../domain/index.js'

/** 已提升的原生队列项由共享待消费行展示，不能再留在本端队列栏。 */
export function selectSubmittedQueueEntryIds(submitted: JsonValue | undefined): ReadonlySet<string> {
  const ids = new Set<string>()
  if (!Array.isArray(submitted)) return ids
  for (const record of submitted) {
    if (!isJsonObject(record) || typeof record.queueEntryId !== 'string') continue
    ids.add(record.queueEntryId)
  }
  return ids
}

/** 已受理但尚未落盘的用户消息只参与展示，不能用其临时 ID 执行历史操作。 */
export function appendSubmittedUserMessages(items: PiTimelineItem[], submitted: JsonValue | undefined, imageLabel: (count: number) => string): PiTimelineItem[] {
  if (!Array.isArray(submitted) || submitted.length === 0) return items
  const pending: PiTimelineItem[] = []
  for (const record of submitted) {
    if (!isJsonObject(record) || typeof record.id !== 'string' || !isJsonObject(record.message)) continue
    const raw = record.message
    if (raw.role !== 'user' || typeof raw.timestamp !== 'number' || !Array.isArray(raw.content)) continue
    if (items.some(item => item.kind === 'user_message' && item.message.timestamp === raw.timestamp)) continue
    const omittedImage = (block: JsonValue) => isJsonObject(block) && block.type === 'image' && block.dataOmitted === true
    const omittedCount = raw.content.filter(omittedImage).length
    const message = (omittedCount ? { ...raw, content: [...raw.content.filter(block => !omittedImage(block)), { type: 'text', text: imageLabel(omittedCount) }] } : raw) as unknown as UserMessage
    const rawEntry: SessionMessageEntry = {
      type: 'message', id: record.id, parentId: null,
      timestamp: new Date(message.timestamp).toISOString(), message,
    }
    pending.push({
      kind: 'user_message', entryId: record.id, timestamp: message.timestamp,
      submissionStatus: record.submissionStatus === 'queued' ? 'queued' : undefined,
      rawEntry, message, blocks: message.content as Exclude<UserMessage['content'], string>,
    })
  }
  return pending.length > 0 ? [...items, ...pending] : items
}
