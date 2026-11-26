import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { isWorkspaceWatchExcluded, type WorkspaceFilesChanged } from '@ompiui/protocol'
import { useTheme } from '../hooks/useTheme'
import { useExcludedPathRevisions } from '../hooks/useExcludedPathRevisions'
import { useServerStore } from '../hooks/useServerStore'
import { resolveWorkspacePath } from '../omp/workspaces'
import { invalidateHostFileReadFlights } from '../omp/transport'
import { isSameDirectory } from '../utils/directoryUtils'
import { createSandboxedHtmlDocument } from './htmlSandbox'
import { resolveHtmlPreviewResources } from './htmlPreviewResources'

interface HtmlFilePreviewFrameProps {
  html: string
  title: string
  isResizing?: boolean
  filePath?: string
  directory?: string
}

export function HtmlFilePreviewFrame({
  html,
  title,
  isResizing = false,
  filePath,
  directory,
}: HtmlFilePreviewFrameProps) {
  const frameRef = useRef<HTMLIFrameElement>(null)
  const { activeServerGeneration } = useServerStore()
  const resourceKey = `${activeServerGeneration}\0${directory ?? ''}\0${filePath ?? ''}\0${html}`
  const [revision, setRevision] = useState(0)
  const [resolution, setResolution] = useState<{ key: string; html: string; excludedPathsKey: string } | null>(null)
  const dependencyRef = useRef<{ key: string; paths: Set<string> } | null>(null)
  const resizeId = useId()
  const { t } = useTranslation('components')
  const { resolvedTheme } = useTheme()
  const theme = resolvedTheme === 'dark' ? 'dark' : 'light'
  const [initialTheme] = useState<'light' | 'dark'>(theme)
  const effectiveHtml = filePath ? (resolution?.key === resourceKey ? resolution.html : null) : html
  const resourcesTruncated = effectiveHtml?.includes('data-ompiui-resources-truncated="true"') ?? false
  const srcDoc = useMemo(
    () =>
      effectiveHtml &&
      createSandboxedHtmlDocument(effectiveHtml, resizeId, initialTheme, {
        overflow: 'auto',
        allowDataScripts: true,
      }),
    [effectiveHtml, initialTheme, resizeId],
  )

  useExcludedPathRevisions(directory, resolution?.key === resourceKey ? resolution.excludedPathsKey : '', activeServerGeneration,
    () => setRevision(value => value + 1))

  useEffect(() => {
    if (!filePath) return
    const controller = new AbortController()
    let workspacePath = directory
    let timer: ReturnType<typeof setTimeout> | undefined
    const dependencies = new Set<string>()
    const previousDependencies = dependencyRef.current?.key === resourceKey ? dependencyRef.current.paths : new Set<string>()
    const caseInsensitive = /^(?:[a-z]:[\\/]|[\\/]{2})/i.test(directory ?? '')
    const key = (path: string) => caseInsensitive ? path.toLowerCase() : path
    if (directory) {
      void resolveWorkspacePath(directory).then(canonical => {
        if (canonical && !controller.signal.aborted) workspacePath = canonical
      }).catch(() => undefined)
    }
    const onFiles = (event: Event) => {
      const detail = (event as CustomEvent<WorkspaceFilesChanged>).detail
      if (!workspacePath || !detail || !isSameDirectory(workspacePath, detail.workspacePath)) return
      if (!detail.rescan && detail.changes.length && !detail.changes.some(change => {
        const changedPath = key(change.path)
        return [dependencies, previousDependencies].some(paths => paths.has(changedPath) || (change.type === 'directory' &&
          [...paths].some(dependency => dependency.startsWith(`${changedPath}/`))))
      })) return
      invalidateHostFileReadFlights(detail.workspacePath)
      timer ??= setTimeout(() => { timer = undefined; setRevision(value => value + 1) }, 300)
    }
    window.addEventListener('ompiui:workspace-files-changed', onFiles)
    resolveHtmlPreviewResources(html, filePath, directory, controller.signal, path => dependencies.add(key(path))).then(
      resolved => {
        if (controller.signal.aborted) return
        dependencyRef.current = { key: resourceKey, paths: dependencies }
        setResolution({
          key: resourceKey, html: resolved,
          excludedPathsKey: [...dependencies].filter(path => isWorkspaceWatchExcluded(path, caseInsensitive)).join('\0'),
        })
      },
      () => {
        if (!controller.signal.aborted) setResolution({ key: resourceKey, html, excludedPathsKey: '' })
      },
    )
    return () => {
      controller.abort()
      clearTimeout(timer)
      window.removeEventListener('ompiui:workspace-files-changed', onFiles)
    }
  }, [directory, filePath, html, resourceKey, revision])

  const sendTheme = useCallback(() => {
    frameRef.current?.contentWindow?.postMessage({ type: 'ompiui-html-theme', theme }, '*')
  }, [theme])

  useEffect(() => {
    sendTheme()
  }, [sendTheme])

  if (!srcDoc) {
    return (
      <div className="flex h-full items-center justify-center" aria-busy="true">
        <span className="h-4 w-4 animate-spin rounded-full border border-text-400 border-t-transparent" />
      </div>
    )
  }

  // File previews are explicitly opened workspace content; sandboxing isolates them from the app origin.
  return (
    <div className="flex h-full min-h-0 flex-col">
      {resourcesTruncated && (
        <div role="status" className="shrink-0 border-b border-amber-500/30 bg-amber-500/10 px-3 py-2 text-sm text-text-200">
          {t('htmlPreview.resourcesTruncated')}
        </div>
      )}
      <iframe
        ref={frameRef}
        title={title}
        sandbox="allow-scripts"
        referrerPolicy="no-referrer"
        srcDoc={srcDoc}
        onLoad={sendTheme}
        style={{ colorScheme: theme, touchAction: 'pan-x pan-y' }}
        className={`block min-h-0 w-full flex-1 border-0 bg-transparent ${isResizing ? 'pointer-events-none' : ''}`}
      />
    </div>
  )
}
