import type { PiImageInput } from '../../omp/transport/index.js'
import type { Attachment } from '../attachment'

/**
 * 把 data-url 图片附件转换为 Pi 原生 ImageContent 块（base64）。
 * 非图片 / 非 data-url 附件返回 null —— Pi 只接受 ImageContent，
 * 其它附件按路径语义留给 Pi 自身处理，前端不做提取。
 */
export function attachmentToImage(attachment: Attachment): PiImageInput | null {
  if (!attachment.url?.startsWith('data:') || !attachment.mime?.startsWith('image/')) return null
  const commaIndex = attachment.url.indexOf(',')
  if (commaIndex === -1) return null
  return { type: 'image', data: attachment.url.slice(commaIndex + 1), mimeType: attachment.mime }
}

/**
 * 把 Pi 原生 ImageContent(base64)还原为输入框图片附件(data-url)。
 * 与 attachmentToImage 互逆:编辑队列条目回填时用它,再次发送时 attachmentToImage
 * 会得到相同的 data/mimeType,图片内容保持一致。
 */
export function imageInputToAttachment(image: PiImageInput): Attachment {
  const ext = image.mimeType.split('/')[1] || 'png'
  return {
    id: crypto.randomUUID(),
    type: 'file',
    displayName: `image.${ext}`,
    url: `data:${image.mimeType};base64,${image.data}`,
    mime: image.mimeType,
  }
}
