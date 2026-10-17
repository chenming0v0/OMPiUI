import { memo, useEffect, useMemo, useRef, useState } from 'react'
import { FileImage, LoaderCircle } from 'lucide-react'
import { isJsonObject } from '@ompiui/protocol'
import type { ImageContent } from '../../omp/vendor/pi-ai'
import { postPiSessionCommand } from '../../omp/transport'
import { serverStore } from '../../store/serverStore'
import { useSessionNavigation } from '../../contexts/SessionNavigationContext'
import { AttachmentItem } from '../attachment'

type ImageReference = { sessionId?: string; entryId: string; blockIndex: number }

export const HistoryImage = memo(function HistoryImage({ block, id, onFullscreenChange }: {
  block: ImageContent
  id: string
  onFullscreenChange?: (isOpen: boolean) => void
}) {
  const { currentSessionId } = useSessionNavigation()
  const reference = (block as ImageContent & { attachment?: ImageReference }).attachment
  const [data, setData] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const controller = useRef<AbortController | undefined>(undefined)
  useEffect(() => () => controller.current?.abort(), [])
  const attachment = useMemo(
    () => ({
      id,
      type: 'file' as const,
      displayName: `image.${block.mimeType.split('/')[1] || 'png'}`,
      url: `data:${block.mimeType};base64,${data || block.data}`,
      mime: block.mimeType,
    }),
    [block.data, block.mimeType, data, id],
  )
  const load = async () => {
    const sessionId = reference?.sessionId ?? currentSessionId
    if (!reference || !sessionId || loading) return
    const signal = new AbortController()
    controller.current = signal
    const generation = serverStore.getActiveServerGeneration()
    setLoading(true)
    setError('')
    try {
      let offset = 0
      let etag: string | undefined
      const chunks: string[] = []
      for (;;) {
        const page = await postPiSessionCommand(
          sessionId,
          'attachment.get',
          {
            entryId: reference.entryId,
            blockIndex: reference.blockIndex,
            offset,
          },
          signal.signal,
        )
        signal.signal.throwIfAborted()
        if (serverStore.getActiveServerGeneration() !== generation) throw new Error('Server changed')
        if (!isJsonObject(page) || typeof page.data !== 'string') throw new Error('Invalid image chunk')
        if (typeof page.totalChars === 'number' && page.totalChars > 64 * 1024 * 1024)
          throw new Error('Image exceeds 64 MiB preview limit')
        if (etag && page.etag !== etag) throw new Error('Image changed during download')
        etag = typeof page.etag === 'string' ? page.etag : undefined
        chunks.push(page.data)
        if (!page.hasMore) break
        const next = Number(page.nextOffset)
        if (!Number.isSafeInteger(next) || next <= offset) throw new Error('Image cursor did not advance')
        offset = next
      }
      setData(chunks.join(''))
    } catch (cause) {
      if (!signal.signal.aborted) setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      if (!signal.signal.aborted) setLoading(false)
    }
  }
  if (!reference || data)
    return <AttachmentItem attachment={attachment} expandable size="sm" onFullscreenChange={onFullscreenChange} />
  return (
    <div className="min-w-0 max-w-full">
      <button
        type="button"
        disabled={loading}
        onClick={() => void load()}
        title={attachment.displayName}
        className="inline-flex max-w-full items-center gap-1.5 rounded-md border border-border-300/50 bg-bg-100/50 px-2.5 py-1.5 text-[length:var(--fs-sm)] text-text-200 hover:bg-bg-200 disabled:opacity-50 focus-visible:outline focus-visible:outline-2"
      >
        {loading ? (
          <LoaderCircle size={14} className="shrink-0 animate-spin" aria-hidden="true" />
        ) : (
          <FileImage size={14} className="shrink-0" aria-hidden="true" />
        )}
        <span className="truncate">{attachment.displayName}</span>
      </button>
      {error && (
        <p role="alert" className="mt-1 break-words text-[length:var(--fs-xs)] text-error">
          {error}
        </p>
      )}
    </div>
  )
})
