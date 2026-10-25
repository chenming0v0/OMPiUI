import { describe, expect, it, vi } from 'vitest'
import { attachmentToImage, interruptAttachmentsToImages } from './attachmentToImage'
import type { Attachment } from '../attachment'

function imageAttachment(overrides: Partial<Attachment> = {}): Attachment {
  return {
    id: 'a1',
    type: 'file',
    displayName: 'photo.png',
    url: 'data:image/png;base64,QUJDREVGRw==',
    mime: 'image/png',
    ...overrides,
  }
}

describe('attachmentToImage', () => {
  it('converts a data-url image attachment to a native Pi ImageContent block', () => {
    expect(attachmentToImage(imageAttachment())).toEqual({
      type: 'image',
      data: 'QUJDREVGRw==',
      mimeType: 'image/png',
    })
  })

  it('returns null for non-image attachments', () => {
    expect(attachmentToImage(imageAttachment({ mime: 'text/plain' }))).toBeNull()
    expect(attachmentToImage(imageAttachment({ type: 'file', url: undefined }))).toBeNull()
  })

  it('returns null for non-data-url or malformed urls', () => {
    expect(attachmentToImage(imageAttachment({ url: 'file:///tmp/photo.png' }))).toBeNull()
    expect(attachmentToImage(imageAttachment({ url: 'data:image/png;base64' }))).toBeNull()
  })
})

describe('interruptAttachmentsToImages', () => {
  it('retains all independent images in attachment order', async () => {
    const images = await interruptAttachmentsToImages([imageAttachment(), imageAttachment({ id: 'a2', url: 'data:image/png;base64,YWJj' })])
    expect(images.map(image => image.data)).toEqual(['QUJDREVGRw==', 'YWJj'])
  })

  it('resolves browser blob images before native atomic dispatch', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(new Uint8Array([65, 66, 67]))))
    try {
      expect(await interruptAttachmentsToImages([imageAttachment({ url: 'blob:local-image' })])).toEqual([{ type: 'image', data: 'QUJD', mimeType: 'image/png' }])
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('rejects unreadable or unencoded images without mutating the editable snapshot', async () => {
    const attachments = [imageAttachment({ url: 'data:image/png,not-base64' })]
    await expect(interruptAttachmentsToImages(attachments)).rejects.toThrow('Unable to submit image attachment')
    expect(attachments[0]?.url).toBe('data:image/png,not-base64')
  })
})
