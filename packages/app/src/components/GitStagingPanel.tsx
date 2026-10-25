import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { useTranslation } from 'react-i18next'
import type { GitCommitPreview, GitFileDiffResponse, GitStatusItem } from '@ompiui/protocol'
import { resolveWorkspacePath } from '../omp/workspaces'
import { getHostGitStatus, getHostGitFileDiff, stageHostGitFiles, unstageHostGitFiles, changeHostGitHunk, previewHostGitCommit, commitHostGit } from '../omp/transport/index.js'
import { serverStore } from '../store/serverStore'

type Props = {
  directory?: string
  onSelectFile: (path: string, staged: boolean) => void
  onChanged: () => void
}

const buttonClass = 'px-2 py-1 rounded border border-border-200 hover:bg-bg-200 disabled:opacity-50 text-[length:var(--fs-xs)]'

/** Explicit host Git operations on the native session's existing checkout. No session writes. */
export function GitStagingPanel(props: Props) {
  const serverGeneration = useSyncExternalStore(listener => serverStore.subscribe(listener), () => serverStore.getActiveServerGeneration(), () => serverStore.getActiveServerGeneration())
  return <ScopedGitStagingPanel key={JSON.stringify([serverGeneration, props.directory])} {...props} serverGeneration={serverGeneration} />
}

function ScopedGitStagingPanel({ directory, onSelectFile, onChanged, serverGeneration }: Props & { serverGeneration: number }) {
  const { t } = useTranslation('components')
  const [items, setItems] = useState<GitStatusItem[]>([])
  const [selection, setSelection] = useState<Set<string>>(new Set())
  const [patch, setPatch] = useState<GitFileDiffResponse | null>(null)
  const [message, setMessage] = useState('')
  const [preview, setPreview] = useState<GitCommitPreview | null>(null)
  const [busy, setBusy] = useState(false)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const generation = useRef(0)
  const operationActive = useRef(false)
  const workspace = useRef<string | null>(null)
  const mounted = useRef(true)
  const isCurrent = useCallback(() => mounted.current && serverStore.getActiveServerGeneration() === serverGeneration, [serverGeneration])

  const refresh = useCallback(async () => {
    if (!isCurrent()) return
    const request = ++generation.current
    setLoading(true)
    try {
      const root = await resolveWorkspacePath(directory)
      if (!isCurrent() || generation.current !== request) return
      if (!root) throw new Error(t('gitStaging.noWorkspace'))
      const status = await getHostGitStatus(root)
      if (!isCurrent() || generation.current !== request) return
      workspace.current = root
      setItems(status.items)
      setSelection(new Set())
      setPatch(null)
      setPreview(null)
    } catch (cause) {
      if (isCurrent() && generation.current === request) setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      if (isCurrent() && generation.current === request) setLoading(false)
    }
  }, [directory, isCurrent, t])

  useEffect(() => {
    mounted.current = true
    workspace.current = null
    setItems([])
    setMessage('')
    setError(null)
    setNotice(null)
    void refresh()
    const changed = (event: Event) => {
      const root = (event as CustomEvent<{ workspacePath: string }>).detail?.workspacePath
      if (root === workspace.current && !operationActive.current) void refresh()
    }
    window.addEventListener('ompiui:workspace-git-updated', changed)
    return () => {
      mounted.current = false
      ++generation.current
      window.removeEventListener('ompiui:workspace-git-updated', changed)
    }
  }, [refresh])

  const operate = async (action: (root: string) => Promise<string | void>, mutation = false) => {
    if (!isCurrent() || operationActive.current || loading || !workspace.current) return
    operationActive.current = true
    const root = workspace.current
    setBusy(true)
    setError(null)
    setNotice(null)
    try {
      const result = await action(root)
      if (!isCurrent() || workspace.current !== root) return
      if (mutation) {
        await refresh()
        if (!isCurrent() || workspace.current !== root) return
        onChanged()
        window.dispatchEvent(new CustomEvent('ompiui:workspace-git-updated', { detail: { workspacePath: root } }))
      }
      if (result) setNotice(result)
    } catch (cause) {
      if (isCurrent() && workspace.current === root) {
        setError(cause instanceof Error ? cause.message : String(cause))
        if (mutation) {
          await refresh()
          if (!isCurrent() || workspace.current !== root) return
          onChanged()
        }
      }
    } finally {
      operationActive.current = false
      if (isCurrent()) setBusy(false)
    }
  }

  const selected = (staged: boolean) => items.filter(item => (staged ? item.staged : item.unstaged) && selection.has(`${staged}:${item.path}`)).map(item => item.path)
  const openPatch = (item: GitStatusItem, staged: boolean) => void operate(async root => {
    onSelectFile(item.path, staged)
    const loaded = await getHostGitFileDiff(root, item.path, staged ? 'staged' : 'unstaged')
    if (isCurrent() && workspace.current === root) setPatch(loaded)
  })
  const hunkStarts = patch ? [...patch.patch.matchAll(/^@@ .+@@.*$/gm)].map(match => match.index!) : []
  const canHunk = patch && !patch.binary && !patch.truncated && !/^(?:new file mode|deleted file mode|old mode|new mode|rename from|copy from)/m.test(patch.patch)
  const disabled = busy || loading

  return (
    <section aria-label={t('gitStaging.manage')} className="shrink-0 max-h-[45vh] overflow-auto border-b border-border-200 px-3 py-2 space-y-2 text-[length:var(--fs-xs)]">
      <div className="flex items-center justify-between gap-2">
        <strong>{t('gitStaging.manage')}</strong>
        <button type="button" className={buttonClass} disabled={disabled} onClick={() => { setError(null); void refresh() }}>{t('gitStaging.refresh')}</button>
      </div>
      {loading && <p role="status">{t('gitStaging.loading')}</p>}
      {error && <p role="alert" className="text-danger-100 whitespace-pre-wrap break-words">{error}</p>}
      {notice && <p role="status" className="whitespace-pre-wrap break-words">{notice}</p>}
      {[false, true].map(staged => (
        <div key={String(staged)} className="space-y-1">
          <div className="flex items-center justify-between gap-2">
            <strong>{t(staged ? 'gitStaging.staged' : 'gitStaging.unstaged')}</strong>
            <button type="button" className={buttonClass} disabled={disabled || !!preview || selected(staged).length === 0} onClick={() => void operate(async root => {
              const paths = selected(staged)
              if (staged) await unstageHostGitFiles(root, paths)
              else await stageHostGitFiles(root, paths)
              return t(staged ? 'gitStaging.unstagedSuccess' : 'gitStaging.stagedSuccess', { count: paths.length })
            }, true)}>{t(staged ? 'gitStaging.unstageSelected' : 'gitStaging.stageSelected')}</button>
          </div>
          {items.filter(item => staged ? item.staged : item.unstaged).map(item => {
            const key = `${staged}:${item.path}`
            return <div key={key} className="flex items-center gap-2 min-w-0">
              <input type="checkbox" aria-label={t(staged ? 'gitStaging.selectStaged' : 'gitStaging.selectUnstaged', { path: item.path })} checked={selection.has(key)} disabled={disabled || !!preview} onChange={event => setSelection(current => {
                const next = new Set(current)
                if (event.target.checked) next.add(key)
                else next.delete(key)
                return next
              })} />
              <button type="button" className="text-left truncate hover:underline" disabled={disabled} onClick={() => openPatch(item, staged)} title={item.path}>{item.path}</button>
              <span className="text-text-400 shrink-0">{item.indexStatus}{item.worktreeStatus}</span>
            </div>
          })}
          {!items.some(item => staged ? item.staged : item.unstaged) && <p className="text-text-400">{t('gitStaging.empty')}</p>}
        </div>
      ))}
      {patch && <details open className="space-y-1">
        <summary className="break-all">{patch.file} · {t(patch.mode === 'staged' ? 'gitStaging.staged' : 'gitStaging.unstaged')}</summary>
        {canHunk ? hunkStarts.map((start, hunk) => <div key={hunk} className="border border-border-200 rounded p-1 space-y-1">
          <button type="button" className={buttonClass} disabled={disabled || !!preview} onClick={() => void operate(async root => {
            await changeHostGitHunk(root, patch.file, patch.mode === 'staged', hunk, patch.patch)
            return t('gitStaging.hunkSuccess')
          }, true)}>{t(patch.mode === 'staged' ? 'gitStaging.unstageHunk' : 'gitStaging.stageHunk', { number: hunk + 1 })}</button>
          <pre className="overflow-auto max-h-36 whitespace-pre font-mono">{patch.patch.slice(start, hunkStarts[hunk + 1] ?? patch.patch.length)}</pre>
        </div>) : <p className="text-text-400">{t('gitStaging.wholeFile')}</p>}
      </details>}
      <label className="block space-y-1">
        <span>{t('gitStaging.message')}</span>
        <textarea aria-label={t('gitStaging.message')} rows={2} className="w-full bg-bg-000 border border-border-200 rounded p-2 resize-y" value={message} disabled={disabled || !!preview} onChange={event => setMessage(event.target.value)} />
      </label>
      {preview ? <div className="space-y-2 border border-border-200 rounded p-2" role="group" aria-label={t('gitStaging.confirm')}>
        <p>{t('gitStaging.scope')}</p>
        <ul className="list-disc pl-4">{preview.files.map(file => <li key={file} className="break-all">{file}</li>)}</ul>
        <pre className="whitespace-pre-wrap break-words">{message}</pre>
        <div className="flex gap-2">
          <button type="button" className={buttonClass} disabled={disabled} onClick={() => void operate(async root => {
            const result = await commitHostGit(root, message, preview.fingerprint)
            if (isCurrent() && workspace.current === root) setMessage('')
            return t('gitStaging.commitSuccess', { sha: result.headOid }) + '\n' + result.output
          }, true)}>{t('gitStaging.commit')}</button>
          <button type="button" className={buttonClass} disabled={disabled} onClick={() => { setPreview(null); setNotice(t('gitStaging.cancelled')) }}>{t('gitStaging.cancel')}</button>
        </div>
      </div> : <button type="button" className={buttonClass} disabled={disabled || !message.trim() || !items.some(item => item.staged)} onClick={() => void operate(async root => {
        const next = await previewHostGitCommit(root)
        if (!next.files.length) throw new Error(t('gitStaging.noStaged'))
        if (isCurrent() && workspace.current === root) setPreview(next)
      })}>{t('gitStaging.review')}</button>}
      <p className="text-text-400">{t('gitStaging.safety')}</p>
    </section>
  )
}
