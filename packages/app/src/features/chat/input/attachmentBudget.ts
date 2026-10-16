import type { Attachment } from '../../attachment'
import { base64Bytes, IMAGE_BYTE_LIMIT, TOTAL_IMAGE_BYTE_LIMIT } from '@ompiui/protocol'

export const FILE_BYTE_LIMIT = IMAGE_BYTE_LIMIT
export const TOTAL_FILE_BYTE_LIMIT = TOTAL_IMAGE_BYTE_LIMIT

export function attachmentBytes(attachments: readonly Attachment[]): number {
  return attachments.reduce((total, attachment) => {
    const url = attachment.url
    if (!url?.startsWith('data:')) return total
    const data = url.slice(url.indexOf(',') + 1)
    return total + base64Bytes(data)
  }, 0)
}

export function assertAttachmentsBudget(attachments: readonly Attachment[]): void {
  let total = 0
  for (const attachment of attachments) {
    const size = attachmentBytes([attachment])
    assertAttachmentBudget(size, total)
    total += size
  }
}

export function mergeAttachmentsWithinBudget(previous: Attachment[], added: Attachment[]): Attachment[] {
  const merged = [...previous, ...added]
  assertAttachmentsBudget(merged)
  return merged
}

export function assertAttachmentBudget(size: number, existing: number): void {
  if (size > FILE_BYTE_LIMIT) throw new Error('Single attachment exceeds 5 MiB')
  if (existing + size > TOTAL_FILE_BYTE_LIMIT) throw new Error('Attachments exceed 16 MiB in total')
}
