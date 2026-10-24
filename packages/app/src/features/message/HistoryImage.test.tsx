// @vitest-environment jsdom
import { act, fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { HistoryImage } from './HistoryImage'
import { SessionNavigationContext } from '../../contexts/SessionNavigationContext'
import type { ImageContent } from '../../omp/vendor/pi-ai'

const request = vi.hoisted(() => vi.fn())
vi.mock('../../omp/transport', () => ({ postPiSessionCommand: request }))
vi.mock('../attachment', () => ({ AttachmentItem: ({ attachment }: { attachment: { url: string; displayName: string } }) => <img src={attachment.url} alt={attachment.displayName} /> }))

function block(source: 'content' | 'details', entryId = 'image-entry'): ImageContent {
  return { type: 'image', data: '', mimeType: 'image/png', attachment: { entryId, blockIndex: 1, source } } as ImageContent
}
function surface(image: ImageContent) {
  return <SessionNavigationContext.Provider value={{ currentSessionId: 'image-session', currentDirectory: undefined, navigateToSession: vi.fn() }}><HistoryImage block={image} id="image-view" /></SessionNavigationContext.Provider>
}

describe('HistoryImage', () => {
  beforeEach(() => request.mockReset())

  it.each(['content', 'details'] as const)('recovers %s image bytes in cursor order and replaces the placeholder with the real image source', async source => {
    request.mockResolvedValueOnce({ data: 'aGVs', hasMore: true, nextOffset: 4, etag: 'image-hash' }).mockResolvedValueOnce({ data: 'bG8=', hasMore: false, etag: 'image-hash' })
    render(surface(block(source)))
    fireEvent.click(screen.getByRole('button', { name: 'image.png' }))
    expect(await screen.findByRole('img')).toHaveAttribute('src', 'data:image/png;base64,aGVsbG8=')
    expect(request.mock.calls.map(call => call[2])).toEqual([
      { entryId: 'image-entry', blockIndex: 1, source, offset: 0 },
      { entryId: 'image-entry', blockIndex: 1, source, offset: 4 },
    ])
  })

  it('shows a missing blob error rather than creating a corrupt data URL', async () => {
    request.mockRejectedValueOnce(new Error('image blob not found'))
    render(surface(block('details')))
    fireEvent.click(screen.getByRole('button', { name: 'image.png' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('image blob not found')
    expect(screen.queryByRole('img')).not.toBeInTheDocument()
  })

  it('never reuses downloaded bytes for a different image reference and ignores an aborted old download', async () => {
    const previous = Promise.withResolvers<{ data: string; hasMore: boolean }>()
    request.mockReturnValueOnce(previous.promise).mockResolvedValueOnce({ data: 'bmV3', hasMore: false })
    const view = render(surface(block('content', 'previous')))
    fireEvent.click(screen.getByRole('button', { name: 'image.png' }))
    view.rerender(surface(block('details', 'current')))
    await act(async () => { previous.resolve({ data: 'b2xk', hasMore: false }) })
    expect(screen.queryByRole('img')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'image.png' }))
    expect(await screen.findByRole('img')).toHaveAttribute('src', 'data:image/png;base64,bmV3')
  })

  it('reports an unprojected blob reference rather than rendering the hash as base64', () => {
    render(surface({ type: 'image', data: `blob:sha256:${'a'.repeat(64)}`, mimeType: 'image/png' }))
    expect(screen.getByRole('alert')).toHaveTextContent('Image data is not available')
    expect(screen.queryByRole('img')).not.toBeInTheDocument()
  })
})
