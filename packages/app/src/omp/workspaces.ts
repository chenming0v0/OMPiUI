import { postHostCommand } from './transport/index.js'
import { trackPiWorkspace } from './ompSessionIndex'
import { serverStore } from '../store/serverStore'
import { serverStorage } from '../utils/perServerStorage'
import { STORAGE_KEY_LAST_DIRECTORY } from '../constants/storage'

/**
 * Host workspace commands (workspaces.*). A workspace is just a directory
 * the server remembers; the canonical path is its identity.
 */
export interface HostWorkspace {
  path: string
  displayName?: string
  createdAt?: string
  lastOpenedAt?: string
}

export async function listHostWorkspaces(signal?: AbortSignal): Promise<HostWorkspace[]> {
  const data = await postHostCommand<{ workspaces: HostWorkspace[] }>('workspaces.list', undefined, signal)
  return data.workspaces
}

export async function openHostWorkspace(rootPath?: string, displayName?: string, signal?: AbortSignal): Promise<HostWorkspace> {
  const params: { rootPath?: string; displayName?: string } = {}
  if (rootPath) params.rootPath = rootPath
  if (displayName) params.displayName = displayName
  const data = await postHostCommand<{ workspace: HostWorkspace }>(
    'workspaces.open',
    params,
    signal,
  )
  trackPiWorkspace(data.workspace.path)
  return data.workspace
}

export async function watchHostWorkspace(workspacePath: string, signal?: AbortSignal): Promise<void> {
  await postHostCommand<{ ok: boolean }>('workspaces.watch', { workspacePath }, signal)
}

const workspaceResolutionPromises = new Map<string, Promise<string | null>>()
// 已确认不存在的目录（WORKSPACE_NOT_FOUND）：本代服务内不再重复请求
// workspaces.open，避免各个面板挂载时反复打出注定 404 的请求。key 含
// 服务入口代数，切换地址或凭据后缓存自然失效。
const missingWorkspacePaths = new Set<string>()
let defaultWorkspacePromise: Promise<string | null> | null = null

// Canonical paths survive a same-endpoint restart; the server's watcher registry
// does not. Keep registration flights separate from the read-only path cache.
const workspaceWatchPromises = new Map<string, Promise<void>>()
let workspaceWatchGeneration = 0

export function resetWorkspaceWatchRegistrations(): void {
  workspaceWatchGeneration += 1
  workspaceWatchPromises.clear()
}

export async function ensureHostWorkspaceWatch(
  workspacePath: string,
  generation = serverStore.getActiveServerGeneration(),
): Promise<void> {
  const key = `${generation}:${workspacePath}`
  while (serverStore.getActiveServerGeneration() === generation) {
    const watchGeneration = workspaceWatchGeneration
    let pending = workspaceWatchPromises.get(key)
    if (!pending) {
      pending = watchHostWorkspace(workspacePath).catch(error => {
        if (workspaceWatchPromises.get(key) === pending) workspaceWatchPromises.delete(key)
        throw error
      })
      workspaceWatchPromises.set(key, pending)
    }
    try {
      await pending
    } catch (error) {
      if (serverStore.getActiveServerGeneration() !== generation) return
      if (workspaceWatchGeneration !== watchGeneration) continue
      throw error
    }
    // A registration started before reconnect cannot confirm the new registry.
    if (workspaceWatchGeneration === watchGeneration) return
  }
}

async function ensureDefaultWorkspacePath(): Promise<string | null> {
  const generation = serverStore.getActiveServerGeneration()
  if (!defaultWorkspacePromise) {
    defaultWorkspacePromise = (async () => {
      try {
        const saved = serverStorage.get(STORAGE_KEY_LAST_DIRECTORY)
        if (saved) {
          if (!/^[a-zA-Z]:[\\/]/.test(saved) && !saved.startsWith('/')) return null
          return await resolveWorkspacePath(saved)
        }
        const known = (await listHostWorkspaces())[0]
        if (serverStore.getActiveServerGeneration() !== generation) return null
        if (known) return await resolveWorkspacePath(known.path)
        const fallback = await openHostWorkspace()
        if (serverStore.getActiveServerGeneration() !== generation) return null
        await ensureHostWorkspaceWatch(fallback.path, generation)
        return serverStore.getActiveServerGeneration() === generation ? fallback.path : null
      } catch {
        return null
      }
    })()
  }
  try {
    const result = await defaultWorkspacePromise
    return serverStore.getActiveServerGeneration() === generation ? result : null
  } finally {
    if (serverStore.getActiveServerGeneration() === generation) defaultWorkspacePromise = null
  }
}

/**
 * Return an explicit directory, the saved project, a known workspace, or the
 * server user's home directory when no project has been selected.
 */
export async function resolveWorkspacePath(directory?: string): Promise<string | null> {
  const generation = serverStore.getActiveServerGeneration()
  if (directory && (/^[a-zA-Z]:[\\/]/.test(directory) || directory.startsWith('/'))) {
    const normalized = directory.replace(/\\/g, '/').replace(/\/+$/, '')
    const key = `${serverStore.getActiveServerId()}:${serverStore.getActiveServerGeneration()}:${normalized}`
    if (missingWorkspacePaths.has(key)) return null
    let pending = workspaceResolutionPromises.get(key)
    if (!pending) {
      pending = openHostWorkspace(directory)
        .then(workspace => serverStore.getActiveServerGeneration() === generation ? workspace.path : null)
        .catch(error => {
          workspaceResolutionPromises.delete(key)
          // Saved directory no longer exists on disk — treat as absent
          if (error && typeof error === 'object' && 'code' in error && error.code === 'WORKSPACE_NOT_FOUND') {
            missingWorkspacePaths.add(key)
            return null
          }
          throw error
        })
      workspaceResolutionPromises.set(key, pending)
    }
    const result = await pending
    if (!result || serverStore.getActiveServerGeneration() !== generation) return null
    await ensureHostWorkspaceWatch(result, generation)
    return serverStore.getActiveServerGeneration() === generation ? result : null
  }
  return ensureDefaultWorkspacePath()
}

export function resetWorkspaceResolutionCache(): void {
  workspaceResolutionPromises.clear()
  missingWorkspacePaths.clear()
  defaultWorkspacePromise = null
  resetWorkspaceWatchRegistrations()
}
