import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { GitWorktree, GitWorktreeCatalog } from '@ompiui/protocol'
import { Button, Dialog } from '../../components/ui'
import { ConfirmDialog } from '../../components/ui/ConfirmDialog'
import { FolderOpenIcon, GitBranchIcon, GitWorktreeIcon, PlusIcon, RetryIcon } from '../../components/Icons'
import { ProjectDialog } from '../chat/ProjectDialog'
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
export function WorktreeManager({ sessionId, directory, variant = 'compact' }: { sessionId?: string; directory?: string; variant?: 'compact' | 'sidebar' }) {
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
  // Location is suggested as `<parent>/<repo>-<branch>` until the user types their own path.
  const [manualPath, setManualPath] = useState<string | null>(null)
  const [pickedParent, setPickedParent] = useState<string | null>(null)
  const [pickerOpen, setPickerOpen] = useState(false)
  const [branch, setBranch] = useState(defaultBranchName)
  // Like Claude's `claude/<name>`: new branches default to `omp/<name>`; an
  // empty prefix means none. Remembered per browser.
  const [branchPrefix, setBranchPrefix] = useState(readBranchPrefix)
  const updateBranchPrefix = (value: string) => {
    setBranchPrefix(value)
    try { localStorage.setItem(BRANCH_PREFIX_KEY, value) } catch { /* storage unavailable */ }
  }
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
    if (!open) return
    // Deferred so the effect body itself never triggers a cascading render.
    const scheduled = setTimeout(() => { void refresh() }, 0)
    const version = readVersion
    const abort = readAbort
    return () => { clearTimeout(scheduled); ++version.current; abort.current?.abort() }
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
        const next = await createHostGitWorktree(cwd, targetPath.trim(), fullBranch)
        if (generation !== serverStore.getActiveServerGeneration()) return
        setCatalog(next)
        setManualPath(null)
        setBranch(defaultBranchName())
      } else if (selected.kind === 'remove') {
        const next = await removeHostGitWorktree(cwd, selected.tree.path)
        if (generation !== serverStore.getActiveServerGeneration()) return
        setCatalog(next)
        resetWorkspaceResolutionCache()
      } else if (!sessionId) {
        const next = await resolveWorkspacePath(selected.tree.path)
        if (generation !== serverStore.getActiveServerGeneration()) return
        if (!next) throw new Error(t('worktrees.unavailableTarget', { defaultValue: 'Selected worktree is no longer available' }))
        if (setDirectory(next)) setOpen(false)
      } else {
        const receipt = await movePiSessionWorktree(sessionId, selected.tree.path)
        if (generation !== serverStore.getActiveServerGeneration()) return
        if (receipt.cancelled || receipt.aborted) return
        if (receipt.targetSessionId !== sessionId || !receipt.targetCwd) throw new Error(t('worktrees.identityMismatch', { defaultValue: 'Native worktree switch did not return the same session identity' }))
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
  const parentDir = pickedParent ?? (catalog ? parentOf(catalog.primaryRoot) : '')
  const repoName = catalog ? baseName(catalog.primaryRoot) : ''
  const branchSlug = slugifyBranch(branch)
  const fullBranch = branch.trim() ? `${branchPrefix.trim()}${branch.trim()}` : ''
  const targetPath = manualPath ?? (parentDir && branchSlug ? `${parentDir}/${repoName ? `${repoName}-` : ''}${branchSlug}` : '')
  const inputClass = 'h-9 w-full min-w-0 rounded-md border border-border-200 bg-bg-000/40 px-3 text-[length:var(--fs-sm)] text-text-100 outline-none placeholder:text-text-400 transition-colors hover:border-border-300 focus:border-accent-main-100/60 disabled:opacity-50'
  const cwdPath = normalizeDir(directory)
  return <>
    {variant === 'sidebar' ? (
      <button type="button" className="flex h-8 w-full items-center overflow-hidden rounded-lg px-1.5 text-text-300 transition-all duration-300 hover:bg-bg-200 hover:text-text-100 active:scale-[0.98]" onClick={() => setOpen(true)} aria-label={label} title={label}>
        <span className="flex size-5 shrink-0 items-center justify-center"><GitWorktreeIcon size={16} aria-hidden="true" /></span>
        <span className="ml-2 min-w-0 flex-1 truncate text-left text-[length:var(--fs-base)]">{label}</span>
      </button>
    ) : (
      <button type="button" className="inline-flex items-center gap-1.5 rounded px-2 py-1 text-xs hover:bg-bg-200" onClick={() => setOpen(true)} aria-label={label}>
        <GitWorktreeIcon size={14} aria-hidden="true" />{label}
      </button>
    )}
    <Dialog isOpen={open} onClose={() => { if (!writing && !pickerOpen) { setAction(null); setOpen(false) } }} title={label} width={640}>

      <div className="mb-2 flex items-center justify-between">
        <h3 className="text-[length:var(--fs-sm)] font-medium text-text-200">
          {t('worktrees.listTitle', { defaultValue: 'Worktrees' })}
          {catalog && <span className="ml-1.5 text-text-400">{catalog.worktrees.length}</span>}
        </h3>
        <Button type="button" variant="ghost" size="sm" onClick={() => void refresh()} disabled={loading || writing} title={t('worktrees.refresh', { defaultValue: 'Refresh (read-only)' })}>
          <RetryIcon size={13} aria-hidden="true" className={loading ? 'animate-spin' : ''} />{t('worktrees.refreshShort', { defaultValue: 'Refresh' })}
        </Button>
      </div>
      {loading && !catalog && <p role="status" className="py-6 text-center text-[length:var(--fs-sm)] text-text-400">{t('worktrees.loading', { defaultValue: 'Reading Git worktrees…' })}</p>}
      {error && <p role="alert" className="mb-3 whitespace-pre-wrap rounded-lg bg-danger-100/10 p-3 text-[length:var(--fs-xs)] text-danger-100">{error}</p>}
      {catalog && catalog.worktrees.length === 0 && <p className="py-6 text-center text-[length:var(--fs-sm)] text-text-400">{t('worktrees.empty', { defaultValue: 'No worktrees found' })}</p>}
      <ul className="max-h-72 space-y-1.5 overflow-auto custom-scrollbar">
        {catalog?.worktrees.map(tree => {
          const treePath = normalizeDir(tree.path) ?? tree.path
          const current = /^[a-z]:\//i.test(treePath) ? treePath.toLowerCase() === cwdPath?.toLowerCase() : treePath === cwdPath
          const primary = tree.path === catalog.primaryRoot
          const protectedTree = primary || tree.bare || tree.locked || tree.prunable || current
          const branchName = tree.branch?.replace(/^refs\/heads\//, '') ?? tree.head?.slice(0, 12) ?? '—'
          const canUse = !current && !tree.bare && !tree.prunable
          return <li key={tree.path} className={`flex items-center gap-3 rounded-lg border px-3 py-2.5 ${current ? 'border-accent-main-100/40 bg-accent-main-100/5' : 'border-border-200/60 bg-bg-000/30'}`}>
            <GitBranchIcon size={15} aria-hidden="true" className={`shrink-0 ${current ? 'text-accent-main-100' : 'text-text-400'}`} />
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-1.5">
                <span className="truncate text-[length:var(--fs-sm)] font-medium text-text-100">{branchName}</span>
                {current && <Badge tone="accent">{t('worktrees.current', { defaultValue: 'current' })}</Badge>}
                {primary && <Badge>{t('worktrees.primary', { defaultValue: 'main' })}</Badge>}
                {tree.detached && <Badge>{t('worktrees.detached', { defaultValue: 'detached' })}</Badge>}
                {tree.locked && <Badge tone="warning" title={tree.lockReason ?? undefined}>{t('worktrees.locked', { defaultValue: 'locked' })}</Badge>}
                {tree.prunable && <Badge tone="danger">{t('worktrees.missing', { defaultValue: 'missing' })}</Badge>}
              </div>
              <div className="mt-0.5 truncate font-mono text-[length:var(--fs-xxs)] text-text-400" title={tree.path}>{treePath}</div>
            </div>
            <div className="flex shrink-0 items-center gap-1">
              {canUse && <Button type="button" variant="secondary" size="sm" disabled={writing || loading || nativeBusy || (Boolean(sessionId) && !capabilities.worktree)} onClick={() => setAction({ kind: 'move', tree })}>{sessionId ? t('worktrees.switch', { defaultValue: 'Switch native session here' }) : t('worktrees.selectWorkspace', { defaultValue: 'Use this workspace' })}</Button>}
              {!protectedTree && <Button type="button" variant="ghost" size="sm" className="hover:!text-danger-100" disabled={writing || loading} title={t('worktrees.removeHint', { defaultValue: 'Only clean linked worktrees can be removed' })} onClick={() => setAction({ kind: 'remove', tree })}>{t('worktrees.remove', { defaultValue: 'Remove…' })}</Button>}
            </div>
          </li>
        })}
      </ul>

      <form className="mt-5 border-t border-border-200/40 pt-4" onSubmit={event => { event.preventDefault(); if (targetPath.trim() && fullBranch) setAction({ kind: 'create' }) }}>
        <h3 className="mb-3 text-[length:var(--fs-sm)] font-medium text-text-200">{t('worktrees.createTitle', { defaultValue: 'New worktree' })}</h3>
        <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,2fr)]">
          <label className="block min-w-0 text-[length:var(--fs-xs)] text-text-300">{t('worktrees.branchPrefix', { defaultValue: 'Branch prefix' })}
            <input className={`${inputClass} mt-1 font-mono`} value={branchPrefix} onChange={event => updateBranchPrefix(event.target.value)} disabled={writing} placeholder={t('worktrees.branchPrefixPlaceholder', { defaultValue: 'None' })} autoComplete="off" spellCheck={false} />
          </label>
          <label className="block min-w-0 text-[length:var(--fs-xs)] text-text-300">{t('worktrees.branch', { defaultValue: 'Branch name' })}
            <input className={`${inputClass} mt-1 font-mono`} value={branch} onChange={event => setBranch(event.target.value)} disabled={writing} placeholder={t('worktrees.branchPlaceholder', { defaultValue: 'e.g. feature/login' })} autoComplete="off" spellCheck={false} required />
          </label>
        </div>
        <label className="mt-3 block min-w-0 text-[length:var(--fs-xs)] text-text-300">{t('worktrees.path', { defaultValue: 'Location' })}
          <div className="mt-1 flex gap-1.5">
            <input className={`${inputClass} font-mono`} value={targetPath} onChange={event => setManualPath(event.target.value)} disabled={writing} placeholder={t('worktrees.pathPlaceholder', { defaultValue: 'Choose or type a folder' })} title={targetPath} autoComplete="off" spellCheck={false} required />
            <Button type="button" variant="secondary" className="h-9 shrink-0" disabled={writing || !catalog} onClick={() => setPickerOpen(true)} title={t('worktrees.browse', { defaultValue: 'Browse…' })}>
              <FolderOpenIcon size={14} aria-hidden="true" />{t('worktrees.browse', { defaultValue: 'Browse…' })}
            </Button>
          </div>
        </label>
        <div className="mt-3 flex items-center justify-between gap-3">
          <p className="min-w-0 truncate text-[length:var(--fs-xxs)] text-text-400" title={fullBranch}>
            {fullBranch && <>{t('worktrees.branchPreview', { defaultValue: 'Branch' })} <span className="font-mono text-text-200">{fullBranch}</span></>}
          </p>
          <Button type="submit" size="sm" className="shrink-0" disabled={writing || loading || !catalog || !targetPath.trim() || !fullBranch}>
            <PlusIcon size={13} aria-hidden="true" />{t('worktrees.create', { defaultValue: 'Create worktree…' })}
          </Button>
        </div>
      </form>
      {nativeBusy && <p className="mt-3 text-[length:var(--fs-xs)] text-warning-100">{t('worktrees.busy', { defaultValue: 'Native session is busy. Browsing is read-only; switching waits for its work to settle.' })}</p>}
      {sessionId && !capabilities.worktree && <p className="mt-3 text-[length:var(--fs-xs)] text-text-400">{t('worktrees.unavailable', { defaultValue: 'This runtime does not advertise native session relocation.' })}</p>}
    </Dialog>
    <ProjectDialog
      isOpen={pickerOpen}
      onClose={() => setPickerOpen(false)}
      onSelect={path => { setPickedParent(normalizeDir(path) ?? path); setManualPath(null) }}
      initialPath={parentDir}
      confirmLabel={t('worktrees.pickCurrent', { defaultValue: 'Use this folder' })}
      itemActionLabel={t('worktrees.pickItem', { defaultValue: 'Select' })}
    />
    <ConfirmDialog isOpen={action !== null} onClose={() => { if (!writing) setAction(null) }} onConfirm={() => void commitAction()} isLoading={writing} variant={action?.kind === 'remove' ? 'danger' : 'info'} title={action?.kind === 'create' ? t('worktrees.confirmCreate', { defaultValue: 'Create linked Git worktree?' }) : action?.kind === 'move' ? (sessionId ? t('worktrees.confirmMove', { defaultValue: 'Move this native session?' }) : t('worktrees.confirmWorkspace', { defaultValue: 'Switch workspace?' })) : t('worktrees.confirmRemove', { defaultValue: 'Remove this clean linked worktree?' })} description={action?.kind === 'create' ? `${targetPath} · ${fullBranch}` : action?.tree.path} />
  </>
}

function normalizeDir(path?: string): string | undefined {
  return path?.replace(/\\/g, '/').replace(/(?<!^[a-zA-Z]:|^)\/+$/, '')
}

function parentOf(path: string): string {
  const normalized = normalizeDir(path) ?? ''
  const index = normalized.lastIndexOf('/')
  if (index <= 0) return normalized
  return /^[a-zA-Z]:$/.test(normalized.slice(0, index)) ? normalized.slice(0, index + 1) : normalized.slice(0, index)
}

function baseName(path: string): string {
  const normalized = normalizeDir(path) ?? ''
  return normalized.slice(normalized.lastIndexOf('/') + 1)
}

/** Folder-safe version of a branch name, used to suggest the worktree directory. */
function slugifyBranch(branch: string): string {
  return branch.trim().replace(/[\\/:*?"<>|\s]+/g, '-').replace(/^[-.]+|[-.]+$/g, '')
}

const BRANCH_PREFIX_KEY = 'ompiui:worktree-branch-prefix'
const DEFAULT_BRANCH_PREFIX = 'omp/'

function readBranchPrefix(): string {
  try { return localStorage.getItem(BRANCH_PREFIX_KEY) ?? DEFAULT_BRANCH_PREFIX } catch { return DEFAULT_BRANCH_PREFIX }
}

/** Prefilled so the location preview works before the user names the branch. */
function defaultBranchName(): string {
  const random = new Uint8Array(3)
  globalThis.crypto.getRandomValues(random)
  return `worktree-${Array.from(random, byte => byte.toString(16).padStart(2, '0')).join('')}`
}

function Badge({ tone = 'neutral', title, children }: { tone?: 'neutral' | 'accent' | 'warning' | 'danger'; title?: string; children: React.ReactNode }) {
  const tones = {
    neutral: 'bg-bg-200/70 text-text-300',
    accent: 'bg-accent-main-100/15 text-accent-main-100',
    warning: 'bg-warning-100/15 text-warning-100',
    danger: 'bg-danger-100/15 text-danger-100',
  }
  return <span title={title} className={`shrink-0 rounded px-1.5 py-px text-[length:var(--fs-xxs)] leading-4 ${tones[tone]}`}>{children}</span>
}
