import type { PiImageInput } from '../../omp/transport/index.js'
import type { Attachment } from '../attachment'
import { bytesToDataUrl } from '../chat/input/inputUtils'

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

/** Atomic interruption must fail before dispatch rather than drop an image. */
export async function interruptAttachmentsToImages(attachments: Attachment[]): Promise<PiImageInput[]> {
  const images: PiImageInput[] = []
  for (const attachment of attachments) {
    if (!attachment.mime?.startsWith('image/')) continue
    let source = attachment
    if (attachment.url?.startsWith('blob:') && !attachment.url.startsWith('blob:sha256:')) {
      const response = await fetch(attachment.url)
      if (!response.ok) throw new Error(`Unable to read image attachment: ${attachment.displayName}`)
      source = { ...attachment, url: bytesToDataUrl(new Uint8Array(await response.arrayBuffer()), attachment.mime) }
    }
    const image = attachmentToImage(source)
    if (!image?.data || !/^data:image\/[^;,]+;base64,/.test(source.url ?? '')) throw new Error(`Unable to submit image attachment: ${attachment.displayName}`)
    images.push(image)
  }
  return images
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
