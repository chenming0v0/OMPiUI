import type { Attachment } from '../../attachment'

export const FILE_BYTE_LIMIT = 5 * 1024 * 1024
export const TOTAL_FILE_BYTE_LIMIT = 16 * 1024 * 1024

export function attachmentBytes(attachments: readonly Attachment[]): number {
  return attachments.reduce((total, attachment) => {
    const url = attachment.url
    if (!url?.startsWith('data:')) return total
    const data = url.slice(url.indexOf(',') + 1)
    return total + Math.floor(data.length * 3 / 4) - (data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0)
  }, 0)
}

export function assertAttachmentBudget(size: number, existing: number): void {
  if (size > FILE_BYTE_LIMIT) throw new Error('Single attachment exceeds 5 MiB')
  if (existing + size > TOTAL_FILE_BYTE_LIMIT) throw new Error('Attachments exceed 16 MiB in total')
}
