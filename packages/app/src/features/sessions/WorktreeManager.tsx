import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { GitWorktree, GitWorktreeCatalog } from '@ompiui/protocol'
import { Dialog } from '../../components/ui'
import { ConfirmDialog } from '../../components/ui/ConfirmDialog'
import { GitWorktreeIcon, RetryIcon } from '../../components/Icons'
import { usePiCapabilities } from '../../omp/capabilities'
import { createHostGitWorktree, getHostGitWorktrees, movePiSessionWorktree, removeHostGitWorktree } from '../../omp/transport'
import { resolveWorkspacePath, resetWorkspaceResolutionCache } from '../../omp/workspaces'
import { requestGitWorkspaceCatalogRefresh } from '../../hooks/useGitWorkspaceCatalog'
import { useBusySessions } from '../../store/activeSessionStore'
import { confirmDiscardUnsavedFileChanges } from '../../store/unsavedFileStore'
import { serverStore } from '../../store/serverStore'
import { useRouter } from '../../hooks/useRouter'

type Action = { kind: 'move' | 'remove'; tree: GitWorktree } | { kind: 'create' }

/** Read-only browser until the user confirms an explicit Git/session write. */
export function WorktreeManager({ sessionId, directory }: { sessionId?: string; directory?: string }) {
  const { t } = useTranslation('components')
  const capabilities = usePiCapabilities()
  const { setDirectory } = useRouter()
  const busySessions = useBusySessions()
  const nativeBusy = busySessions.some(session => session.sessionId === sessionId)
  const [open, setOpen] = useState(false)
  const [catalog, setCatalog] = useState<GitWorktreeCatalog | null>(null)
  const [loading, setLoading] = useState(false)
  const [writing, setWriting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [action, setAction] = useState<Action | null>(null)
  const [targetPath, setTargetPath] = useState('')
  const [branch, setBranch] = useState('')
  const readVersion = useRef(0)
  const readAbort = useRef<AbortController | null>(null)
  const workspace = useRef<string | null>(null)
  const endpointGeneration = useRef(serverStore.getActiveServerGeneration())
  const refresh = useCallback(async (preserveError = false) => {
    const version = ++readVersion.current
    readAbort.current?.abort()
    const controller = new AbortController()
    readAbort.current = controller
    setLoading(true)
    if (!preserveError) setError(null)
    try {
      const cwd = await resolveWorkspacePath(directory)
      if (!cwd) throw new Error(t('worktrees.noWorkspace', { defaultValue: 'No workspace is available' }))
      const next = await getHostGitWorktrees(cwd, controller.signal)
      if (version !== readVersion.current || controller.signal.aborted) return
      workspace.current = cwd
      setCatalog(next)
    } catch (failure) {
      if (version === readVersion.current && !controller.signal.aborted) setError(String(failure instanceof Error ? failure.message : failure))
    } finally { if (version === readVersion.current) setLoading(false) }
  }, [directory, t])
  useEffect(() => {
    if (open) void refresh()
    return () => { ++readVersion.current; readAbort.current?.abort() }
  }, [open, refresh])
  useEffect(() => serverStore.onServerChange(() => {
    endpointGeneration.current = serverStore.getActiveServerGeneration()
    ++readVersion.current
    readAbort.current?.abort()
    workspace.current = null
    setCatalog(null)
    setAction(null)
    setOpen(false)
  }), [])

  async function commitAction() {
    if (!action || !workspace.current || writing) return
    if (action.kind === 'move' && !confirmDiscardUnsavedFileChanges()) { setAction(null); return }
    const selected = action
    const cwd = workspace.current
    const generation = endpointGeneration.current
    setWriting(true)
    setError(null)
    try {
      if (selected.kind === 'create') {
        const next = await createHostGitWorktree(cwd, targetPath.trim(), branch.trim())
        if (generation !== serverStore.getActiveServerGeneration()) return
        setCatalog(next)
        setTargetPath('')
        setBranch('')
      } else if (selected.kind === 'remove') {
        const next = await removeHostGitWorktree(cwd, selected.tree.path)
        if (generation !== serverStore.getActiveServerGeneration()) return
        setCatalog(next)
        resetWorkspaceResolutionCache()
      } else if (!sessionId) {
        const next = await resolveWorkspacePath(selected.tree.path)
        if (generation !== serverStore.getActiveServerGeneration()) return
        if (!next) throw new Error('Selected worktree is no longer available')
        if (setDirectory(next)) setOpen(false)
      } else {
        const receipt = await movePiSessionWorktree(sessionId, selected.tree.path)
        if (generation !== serverStore.getActiveServerGeneration()) return
        if (receipt.cancelled || receipt.aborted) return
        if (receipt.targetSessionId !== sessionId || !receipt.targetCwd) throw new Error('Native worktree switch did not return the same session identity')
        await resolveWorkspacePath(receipt.targetCwd)
        if (generation !== serverStore.getActiveServerGeneration()) return
        if (receipt.projectionError) setError(receipt.projectionError)
        else setOpen(false)
      }
      if (generation === serverStore.getActiveServerGeneration()) {
        setAction(null)
        requestGitWorkspaceCatalogRefresh()
      }
    } catch (failure) {
      if (generation === serverStore.getActiveServerGeneration()) {
        setAction(null)
        setError(failure instanceof Error ? failure.message : String(failure))
        // An interrupted Git write has unknown outcome; inspect real Git before
        // offering another mutation rather than replaying it automatically.
        void refresh(true)
      }
    } finally { setWriting(false) }
  }

  const label = t('worktrees.title', { defaultValue: 'Git worktrees' })
  return <>
    <button type="button" className="inline-flex items-center gap-1.5 rounded px-2 py-1 text-xs hover:bg-bg-200" onClick={() => setOpen(true)} aria-label={label}>
      <GitWorktreeIcon size={14} aria-hidden="true" />{label}
    </button>
    <Dialog isOpen={open} onClose={() => { if (!writing) { setAction(null); setOpen(false) } }} title={label} width={680}>
      <p className="mb-3 text-xs text-text-300">{sessionId ? t('worktrees.nativeContract', { defaultValue: 'Switch moves this native session and its artifacts to the selected checkout, retaining its ID. Other sessions are not copied or moved. Branches and user changes are never force-deleted.' }) : t('worktrees.workspaceContract', { defaultValue: 'Choose the checkout for your next native session. Browsing and workspace selection do not start an Agent or save chat history.' })}</p>
      <button type="button" className="mb-3 inline-flex items-center gap-1 text-sm" onClick={() => void refresh()} disabled={loading || writing}>
        <RetryIcon size={14} aria-hidden="true" />{t('worktrees.refresh', { defaultValue: 'Refresh (read-only)' })}
      </button>
      {loading && <p role="status">{t('worktrees.loading', { defaultValue: 'Reading Git worktrees…' })}</p>}
      {error && <p role="alert" className="mb-3 whitespace-pre-wrap text-sm text-error">{error}</p>}
      <ul className="max-h-72 overflow-auto divide-y divide-border-100">
        {catalog?.worktrees.map(tree => {
          const treePath = tree.path.replace(/\\/g, '/').replace(/\/+$/, '')
          const cwdPath = directory?.replace(/\\/g, '/').replace(/\/+$/, '')
          const current = /^[a-z]:\//i.test(treePath) ? treePath.toLowerCase() === cwdPath?.toLowerCase() : treePath === cwdPath
          const protectedTree = tree.path === catalog.primaryRoot || tree.bare || tree.locked || tree.prunable || current
          return <li key={tree.path} className="py-3">
            <div className="break-all font-mono text-xs">{tree.path}</div>
            <div className="my-1 text-xs text-text-300">{tree.branch?.replace(/^refs\/heads\//, '') ?? tree.head?.slice(0, 12)}{tree.detached ? ' · detached' : ''}{current ? ' · current' : ''}{tree.locked ? ` · locked${tree.lockReason ? ': ' + tree.lockReason : ''}` : ''}{tree.prunable ? ' · missing' : ''}</div>
            <div className="flex gap-3 text-sm">
              <button type="button" disabled={writing || loading || nativeBusy || current || tree.bare || tree.prunable || (Boolean(sessionId) && !capabilities.worktree)} onClick={() => setAction({ kind: 'move', tree })}>{sessionId ? t('worktrees.switch', { defaultValue: 'Switch native session here' }) : t('worktrees.selectWorkspace', { defaultValue: 'Use this workspace' })}</button>
              <button type="button" disabled={writing || loading || protectedTree} onClick={() => setAction({ kind: 'remove', tree })}>{t('worktrees.remove', { defaultValue: 'Remove clean worktree…' })}</button>
            </div>
          </li>
        })}
      </ul>
      <form className="mt-4 border-t border-border-100 pt-3 space-y-2" onSubmit={event => { event.preventDefault(); setAction({ kind: 'create' }) }}>
        <label className="block text-sm">{t('worktrees.path', { defaultValue: 'New worktree path (absolute or relative to current workspace)' })}<input className="mt-1 w-full rounded border border-border-100 bg-bg-000 p-2" value={targetPath} onChange={event => setTargetPath(event.target.value)} disabled={writing} required /></label>
        <label className="block text-sm">{t('worktrees.branch', { defaultValue: 'New branch name' })}<input className="mt-1 w-full rounded border border-border-100 bg-bg-000 p-2" value={branch} onChange={event => setBranch(event.target.value)} disabled={writing} required /></label>
        <button type="submit" className="rounded bg-bg-200 px-3 py-2 text-sm" disabled={writing || loading || !catalog || !targetPath.trim() || !branch.trim()}>{t('worktrees.create', { defaultValue: 'Create worktree…' })}</button>
      </form>
      {nativeBusy && <p className="mt-2 text-xs">{t('worktrees.busy', { defaultValue: 'Native session is busy. Browsing is read-only; switching waits for its work to settle.' })}</p>}
      {sessionId && !capabilities.worktree && <p className="mt-2 text-xs">{t('worktrees.unavailable', { defaultValue: 'This runtime does not advertise native session relocation.' })}</p>}
    </Dialog>
    <ConfirmDialog isOpen={action !== null} onClose={() => { if (!writing) setAction(null) }} onConfirm={() => void commitAction()} isLoading={writing} variant={action?.kind === 'remove' ? 'danger' : 'info'} title={action?.kind === 'create' ? t('worktrees.confirmCreate', { defaultValue: 'Create linked Git worktree?' }) : action?.kind === 'move' ? (sessionId ? t('worktrees.confirmMove', { defaultValue: 'Move this native session?' }) : t('worktrees.confirmWorkspace', { defaultValue: 'Switch workspace?' })) : t('worktrees.confirmRemove', { defaultValue: 'Remove this clean linked worktree?' })} description={action?.kind === 'create' ? `${targetPath} · ${branch}` : action?.tree.path} />
  </>
}
