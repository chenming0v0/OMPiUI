import { useEffect, useRef, useState } from 'react'
import { ChevronDown, ChevronUp, LoaderCircle } from 'lucide-react'
import { isJsonObject, type JsonValue } from '@ompiui/protocol'
import { useTranslation } from 'react-i18next'
import { useSessionNavigation } from '../../../../contexts/SessionNavigationContext'
import { postPiSessionCommand } from '../../../../omp/transport'
import { serverStore } from '../../../../store/serverStore'

const MAX_OUTPUT_PAGE_BYTES = 128 * 1024

type ToolOutputPage = {
  data: string
  nextOffset: number
  totalBytes: number
  hasMore: boolean
  revision: string
}

export function FullOutputControl({ artifactId }: { artifactId?: string }) {
  const { t } = useTranslation('message')
  const { currentSessionId } = useSessionNavigation()
  const [loading, setLoading] = useState(false)
  const [output, setOutput] = useState<string | null>(null)
  const [error, setError] = useState('')
  const controllerRef = useRef<AbortController | undefined>(undefined)

  useEffect(() => () => controllerRef.current?.abort(), [])

  if (!artifactId) return null

  const load = async () => {
    if (controllerRef.current || output !== null) return
    if (!currentSessionId) {
      setError(t('truncation.loadError'))
      return
    }

    const controller = new AbortController()
    controllerRef.current = controller
    const sessionId = currentSessionId
    const serverGeneration = serverStore.getActiveServerGeneration()
    const chunks: string[] = []
    const encoder = new TextEncoder()
    let offset = 0
    let totalBytes: number | undefined
    let revision: string | undefined
    setLoading(true)
    setError('')
    try {
      for (;;) {
        const response = await postPiSessionCommand<JsonValue, 'toolOutput.get'>(
          sessionId,
          'toolOutput.get',
          { artifactId, offset, ...(revision ? { revision } : {}) },
          controller.signal,
          30_000,
        )
        controller.signal.throwIfAborted()
        if (serverStore.getActiveServerGeneration() !== serverGeneration) throw new Error('Server changed')
        if (!isJsonObject(response) || typeof response.data !== 'string' ||
          typeof response.nextOffset !== 'number' || !Number.isSafeInteger(response.nextOffset) ||
          typeof response.totalBytes !== 'number' || !Number.isSafeInteger(response.totalBytes) || response.totalBytes < 0 ||
          typeof response.hasMore !== 'boolean' || typeof response.revision !== 'string') {
          throw new Error('Invalid tool output page')
        }
        const page = response as unknown as ToolOutputPage
        const pageBytes = encoder.encode(page.data).byteLength
        if (page.nextOffset !== offset + pageBytes || page.nextOffset > page.totalBytes ||
          page.data.length > 0 && pageBytes === 0 || pageBytes > MAX_OUTPUT_PAGE_BYTES ||
          page.hasMore !== (page.nextOffset < page.totalBytes) ||
          (page.hasMore && page.data.length === 0) ||
          (totalBytes !== undefined && totalBytes !== page.totalBytes) ||
          (revision !== undefined && revision !== page.revision)) {
          throw new Error('Invalid tool output page')
        }
        totalBytes = page.totalBytes
        revision = page.revision
        chunks.push(page.data)
        offset = page.nextOffset
        if (!page.hasMore) break
      }
      controller.signal.throwIfAborted()
      if (serverStore.getActiveServerGeneration() !== serverGeneration) throw new Error('Server changed')
      setOutput(chunks.join(''))
    } catch (cause) {
      if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      if (controllerRef.current === controller) controllerRef.current = undefined
      if (!controller.signal.aborted) setLoading(false)
    }
  }

  const expanded = output !== null
  return (
    <div className="mt-1">
      <button
        type="button"
        onClick={expanded ? () => setOutput(null) : () => void load()}
        disabled={loading}
        aria-expanded={expanded}
        aria-busy={loading}
        className="inline-flex items-center gap-1 text-[length:var(--fs-xs)] text-text-500 transition-colors hover:text-text-100 disabled:cursor-wait"
      >
        {loading ? <LoaderCircle size={13} className="animate-spin" /> : expanded ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
        {t(loading ? 'truncation.loadingFullOutput' : expanded ? 'truncation.collapseFullOutput' : 'truncation.expandFullOutput')}
      </button>
      {error && <p role="alert" className="mt-1 text-[length:var(--fs-xs)] text-danger-100">{t('truncation.loadError')}: {error}</p>}
      {output !== null && <pre className="mt-2 max-h-[60vh] overflow-auto whitespace-pre-wrap break-all font-mono text-[length:var(--fs-code)] leading-[1.6] text-text-300">{output}</pre>}
    </div>
  )
}
