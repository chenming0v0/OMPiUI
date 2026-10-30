import { memo, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { FileImage, LoaderCircle } from 'lucide-react'
import { isJsonObject } from '@ompiui/protocol'
import type { ImageContent } from '../../omp/vendor/pi-ai'
import { postPiSessionCommand } from '../../omp/transport'
import { serverStore } from '../../store/serverStore'
import { useSessionNavigation } from '../../contexts/SessionNavigationContext'
import { AttachmentItem } from '../attachment'

type ImageReference = { sessionId?: string; entryId: string; blockIndex: number; source?: 'content' | 'details'; epoch?: string; etag?: string }

type HistoryImageProps = {
  block: ImageContent
  id: string
  onFullscreenChange?: (isOpen: boolean) => void
}

export const HistoryImage = memo(function HistoryImage(props: HistoryImageProps) {
  const { currentSessionId } = useSessionNavigation()
  const generation = useSyncExternalStore(listener => serverStore.subscribe(listener), () => serverStore.getActiveServerGeneration(), () => serverStore.getActiveServerGeneration())
  const reference = (props.block as ImageContent & { attachment?: ImageReference }).attachment
  const key = JSON.stringify([generation, props.id, props.block.data, props.block.mimeType, reference?.sessionId ?? currentSessionId, reference?.entryId, reference?.blockIndex, reference?.source, reference?.epoch, reference?.etag])
  const [previousKey, setPreviousKey] = useState(key)
  const changed = previousKey !== key
  useEffect(() => {
    if (previousKey === key) return
    // Commit the new key on a microtask after this render has painted with the
    // one-frame "changed" signal (a render-phase update would discard it).
    const scheduled = setTimeout(() => setPreviousKey(key), 0)
    return () => clearTimeout(scheduled)
  }, [key, previousKey])
  return <HistoryImageContent key={key} {...props} initialError={changed ? 'Image reference or server changed; reload image' : ''} />
})

function HistoryImageContent({ block, id, onFullscreenChange, initialError }: HistoryImageProps & { initialError: string }) {
  const { currentSessionId } = useSessionNavigation()
  const reference = (block as ImageContent & { attachment?: ImageReference }).attachment
  const [data, setData] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(initialError)
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
    if (!reference || loading) return
    if (!sessionId) { setError('Image session is not available'); return }
    if (!reference.entryId || !Number.isSafeInteger(reference.blockIndex) || reference.blockIndex < 0 ||
      (reference.source !== undefined && reference.source !== 'content' && reference.source !== 'details')) {
      setError('Invalid image reference'); return
    }
    const signal = new AbortController()
    controller.current = signal
    const generation = serverStore.getActiveServerGeneration()
    setLoading(true)
    setError('')
    try {
      let offset = 0
      let etag: string | undefined
      let totalChars: number | undefined
      let revision: string | undefined
      const chunks: string[] = []
      for (;;) {
        const page = await postPiSessionCommand(
          sessionId,
          'attachment.get',
          {
            entryId: reference.entryId,
            blockIndex: reference.blockIndex,
            ...(reference.source ? { source: reference.source } : {}),
            offset,
          },
          signal.signal,
        )
        signal.signal.throwIfAborted()
        if (serverStore.getActiveServerGeneration() !== generation) throw new Error('Server changed')
        if (!isJsonObject(page) || typeof page.data !== 'string' || typeof page.etag !== 'string' ||
          page.mimeType !== block.mimeType || typeof page.hasMore !== 'boolean' ||
          typeof page.totalChars !== 'number' || !Number.isSafeInteger(page.totalChars) || page.totalChars <= 0 ||
          typeof page.nextOffset !== 'number' || !Number.isSafeInteger(page.nextOffset) ||
          page.nextOffset !== offset + page.data.length || page.nextOffset > page.totalChars ||
          page.data.length === 0 || page.data.length > 256 * 1024 || page.data.length % 4 !== 0 ||
          !/^[A-Za-z0-9+/]*={0,2}$/.test(page.data) ||
          page.hasMore !== (page.nextOffset < page.totalChars) || (page.hasMore && page.data.includes('='))) {
          throw new Error('Invalid image chunk')
        }
        if (page.totalChars > 64 * 1024 * 1024) throw new Error('Image exceeds 64 MiB preview limit')
        if ((reference.etag && page.etag !== reference.etag) || (etag && page.etag !== etag) ||
          (totalChars !== undefined && totalChars !== page.totalChars) ||
          (revision !== undefined && revision !== page.revision)) throw new Error('Image changed during download')
        etag = page.etag
        totalChars = page.totalChars
        revision = typeof page.revision === 'string' ? page.revision : undefined
        chunks.push(page.data)
        offset = page.nextOffset
        if (!page.hasMore) break
      }
      const restored = chunks.join('')
      signal.signal.throwIfAborted()
      if (serverStore.getActiveServerGeneration() !== generation) throw new Error('Server changed')
      setData(restored)
    } catch (cause) {
      if (!signal.signal.aborted) setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      if (!signal.signal.aborted) setLoading(false)
    }
  }
  if (!reference && block.data.startsWith('blob:sha256:')) {
    return <p role="alert" className="break-words text-[length:var(--fs-xs)] text-error">Image data is not available: {block.data}</p>
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
      {loading && <button type="button" className="ml-2 text-[length:var(--fs-xs)] text-text-300" onClick={() => { controller.current?.abort(); setLoading(false); setError('Image download cancelled') }}>Cancel</button>}
      {error && (
        <p role="alert" className="mt-1 break-words text-[length:var(--fs-xs)] text-error">
          {error}
        </p>
      )}
    </div>
  )
}
