import type {
  FileNodeDto,
  FileReadResponse,
  GitFileStatus,
  GitStatusItem,
  WorkspaceTextSearchMatch,
} from '@ompiui/protocol'
import {
  createHostFileEntry,
  deleteHostFileEntry,
  getHostGitStatus,
  listHostFiles,
  moveHostFileEntry,
  readHostFile,
  searchHostFilesByName,
  searchHostFilesText,
  writeHostFile,
} from './transport/index.js'
import { serverStore } from '../store/serverStore'
import { resolveWorkspacePath } from './workspaces'

/**
 * Workspace file client over native host commands (files and git).
 * Returns protocol types directly — no view-model mapping.
 */

const ROOT_DIRECTORY_CACHE_TTL_MS = 1500
const rootDirectoryCache = new Map<string, { data: FileNodeDto[]; expiresAt: number }>()
type DirectoryFlight = {
  promise: Promise<FileNodeDto[]>
  controller: AbortController
  users: number
  settled: boolean
}
const rootDirectoryInflight = new Map<string, DirectoryFlight>()
const rootDirectoryGeneration = new Map<string, number>()

function getRootDirectoryCacheKey(directory?: string): string {
  return `${serverStore.getActiveServerGeneration()}:${serverStore.getActiveServerId()}:${directory?.replace(/\\/g, '/').replace(/\/+$/, '') ?? ''}`
}

async function requireWorkspacePath(directory?: string): Promise<string> {
  const workspacePath = await resolveWorkspacePath(directory)
  if (!workspacePath) throw new Error('No OMPiUI workspace is available')
  return workspacePath
}

/** Join a workspace-relative entry path to the workspace root for display. */
export function toAbsoluteEntryPath(workspaceDir: string | undefined, entryPath: string): string {
  const entry = entryPath.replace(/\\/g, '/')
  if (/^[a-zA-Z]:\//.test(entry) || entry.startsWith('/')) return entry
  if (!workspaceDir || (!/^[a-zA-Z]:[\\/]/.test(workspaceDir) && !workspaceDir.startsWith('/'))) return entry
  const root = workspaceDir.replace(/\\/g, '/').replace(/\/+$/, '')
  return `${root || '/'}${root ? '/' : ''}${entry.replace(/^\/+/, '')}`
}

function isRootDirectoryPath(path: string): boolean {
  return !path || path === '.' || path === '/'
}

/** Normalize explorer path to workspace-relative for the file commands. */
function toPiRelativePath(path: string, directory?: string): string {
  if (!path || isRootDirectoryPath(path)) return ''
  const p = path.replace(/\\/g, '/')
  if (p === 'ompiui' || p.startsWith('ompiui/') || p === 'piui' || p.startsWith('piui/')) return ''

  const root = directory?.replace(/\\/g, '/').replace(/\/+$/, '')
  if (root && (/^[a-zA-Z]:/.test(root) || root.startsWith('/'))) {
    const caseInsensitive = /^[a-zA-Z]:/.test(root) || root.startsWith('//')
    const lp = caseInsensitive ? p.toLowerCase() : p
    const lr = caseInsensitive ? root.toLowerCase() : root
    if (lp === lr || lp === `${lr}/`) return ''
    if (lp.startsWith(`${lr}/`)) return p.slice(root.length + 1)
    if (/^[a-zA-Z]:/.test(p) || p.startsWith('/')) return ''
  }

  if (/^[a-zA-Z]:/.test(p) || (p.startsWith('/') && p.length > 1 && !directory)) return ''
  return p.replace(/^\//, '')
}

function directoryWorkspace(path: string, directory?: string): string | undefined {
  if (directory && (/^[a-zA-Z]:/.test(directory) || directory.startsWith('/'))) return directory
  if (path && (/^[a-zA-Z]:/.test(path) || path.startsWith('/'))) return path
  return directory
}

async function fetchDirectory(path: string, directory?: string, signal?: AbortSignal): Promise<FileNodeDto[]> {
  const workspaceDir = directoryWorkspace(path, directory)
  const isAbsolute = Boolean(workspaceDir && (/^[a-zA-Z]:[\\/]/.test(workspaceDir) || workspaceDir.startsWith('/')))
  // Browsing a directory must not register it as a watched workspace:
  // requireWorkspacePath -> resolveWorkspacePath fires workspaces.open (spawns a
  // Pi worker prewarm) and workspaces.watch (recursive chokidar watcher). On a
  // huge tree such as E:\dev (tens of thousands of subdirectories) the recursive
  // watcher grinds the server to a halt. files.list auto-registers the workspace
  // record server-side (workspace() find/resolve) without watching or prewarming;
  // the workspace is properly opened + watched only when the user actually picks
  // the directory and the app switches to it.
  const workspacePath = isAbsolute && workspaceDir ? workspaceDir : await requireWorkspacePath(workspaceDir)
  const rel = toPiRelativePath(path, workspaceDir)
  const entries: FileNodeDto[] = []
  let cursor: string | undefined
  let bytes = 0
  do {
    signal?.throwIfAborted()
    const page = await listHostFiles(workspacePath, { path: rel, limit: 2000, cursor }, signal)
    bytes += new TextEncoder().encode(JSON.stringify(page)).byteLength
    if (bytes > 4 * 1024 * 1024 || entries.length + page.entries.length > 20_000) {
      entries.push({ name: '…（目录过大，已截断）', path: rel, type: 'other' })
      break
    }
    entries.push(...page.entries)
    cursor = page.nextCursor
  } while (cursor)
  return entries.filter(e => !e.restricted)
}

export async function searchFiles(
  query: string,
  options: {
    directory?: string
    type?: 'file' | 'directory'
    limit?: number
    signal?: AbortSignal
  } = {},
): Promise<string[]> {
  const workspacePath = await requireWorkspacePath(options.directory)
  const result = await searchHostFilesByName(workspacePath, query, {
    type: options.type,
    limit: options.limit,
  }, options.signal)
  return result.paths
}

export async function listDirectory(path: string, directory?: string, signal?: AbortSignal): Promise<FileNodeDto[]> {
  signal?.throwIfAborted()
  const workspaceDir = directoryWorkspace(path, directory)
  const workspaceKey = getRootDirectoryCacheKey(workspaceDir)
  const key = `${workspaceKey}\0${toPiRelativePath(path, workspaceDir)}`
  const now = Date.now()
  const cached = rootDirectoryCache.get(key)
  if (cached && cached.expiresAt > now) {
    return cached.data
  }

  let inflight = rootDirectoryInflight.get(key)
  if (!inflight) {
    const generation = rootDirectoryGeneration.get(workspaceKey) ?? 0
    const serverGeneration = serverStore.getActiveServerGeneration()
    const controller = new AbortController()
    const created: DirectoryFlight = {
      controller, users: 0, settled: false,
      promise: fetchDirectory(path === '' ? '.' : path, directory, controller.signal)
        .then(data => {
          if (!controller.signal.aborted && serverStore.getActiveServerGeneration() === serverGeneration &&
            (rootDirectoryGeneration.get(workspaceKey) ?? 0) === generation) {
            rootDirectoryCache.set(key, { data, expiresAt: Date.now() + ROOT_DIRECTORY_CACHE_TTL_MS })
            while (rootDirectoryCache.size > 128) rootDirectoryCache.delete(rootDirectoryCache.keys().next().value!)
          }
          return data
        })
        .finally(() => {
          created.settled = true
          if (rootDirectoryInflight.get(key) === created) rootDirectoryInflight.delete(key)
        }),
    }
    rootDirectoryInflight.set(key, created)
    inflight = created
  }
  const shared = inflight
  shared.users++
  return new Promise<FileNodeDto[]>((resolve, reject) => {
    let done = false
    const release = () => {
      if (done) return false
      done = true
      signal?.removeEventListener('abort', abort)
      shared.users--
      return true
    }
    const abort = () => {
      if (!release()) return
      reject(signal?.reason)
      if (!shared.users && !shared.settled) {
        if (rootDirectoryInflight.get(key) === shared) rootDirectoryInflight.delete(key)
        shared.controller.abort()
      }
    }
    signal?.addEventListener('abort', abort, { once: true })
    shared.promise.then(
      data => { if (release()) resolve(data) },
      error => { if (release()) reject(error) },
    )
    if (signal?.aborted) abort()
  })
}

export async function prefetchRootDirectory(directory?: string): Promise<void> {
  await listDirectory('.', directory)
}

export async function getFileContent(path: string, directory?: string, ifNoneMatch?: string, signal?: AbortSignal, maxBytes?: number): Promise<FileReadResponse> {
  const generation = serverStore.getActiveServerGeneration()
  signal?.throwIfAborted()
  const workspacePath = await requireWorkspacePath(directory)
  signal?.throwIfAborted()
  if (generation !== serverStore.getActiveServerGeneration()) throw new DOMException('The server changed', 'AbortError')
  const rel = toPiRelativePath(path, directory)
  return readHostFile(workspacePath, rel, signal, ifNoneMatch, maxBytes)
}

export async function saveFile(path: string, content: Pick<FileReadResponse, 'content'> & Partial<FileReadResponse>, directory?: string): Promise<FileReadResponse> {
  const generation = serverStore.getActiveServerGeneration()
  const workspacePath = await requireWorkspacePath(directory)
  if (generation !== serverStore.getActiveServerGeneration()) {
    throw new Error('The server changed before the file could be saved')
  }
  const relative = toPiRelativePath(path, directory)
  const saved = await writeHostFile(
    workspacePath,
    relative,
    content.content,
    { ifMatch: content.etag, encoding: content.encoding === 'base64' ? 'base64' : 'utf-8', returnContent: false },
  )
  invalidateWorkspaceFileCaches(directory)
  return { ...saved, content: content.content }
}

export async function createFile(path: string, directory?: string, content = ''): Promise<void> {
  const workspacePath = await requireWorkspacePath(directory)
  await createHostFileEntry(workspacePath, { path: toPiRelativePath(path, directory), type: 'file', content })
  invalidateWorkspaceFileCaches(directory)
}

export async function createDirectory(path: string, directory?: string): Promise<void> {
  const workspacePath = await requireWorkspacePath(directory)
  await createHostFileEntry(workspacePath, { path: toPiRelativePath(path, directory), type: 'directory' })
  invalidateWorkspaceFileCaches(directory)
}

export async function moveEntry(from: string, to: string, directory?: string): Promise<void> {
  const workspacePath = await requireWorkspacePath(directory)
  await moveHostFileEntry(workspacePath, {
    from: toPiRelativePath(from, directory),
    to: toPiRelativePath(to, directory),
  })
  invalidateWorkspaceFileCaches(directory)
}

export async function deleteEntry(path: string, directory?: string, recursive = false): Promise<void> {
  const workspacePath = await requireWorkspacePath(directory)
  await deleteHostFileEntry(workspacePath, toPiRelativePath(path, directory), recursive)
  invalidateWorkspaceFileCaches(directory)
}

export async function getFileStatus(directory?: string): Promise<GitStatusItem[]> {
  const workspacePath = await requireWorkspacePath(directory)
  const status = await getHostGitStatus(workspacePath)
  return status.items
}

export function simplifyGitStatus(status: GitFileStatus): 'added' | 'modified' | 'deleted' {
  if (status === 'added' || status === 'untracked' || status === 'copied') return 'added'
  if (status === 'deleted') return 'deleted'
  return 'modified'
}

export function invalidateWorkspaceFileCaches(directory?: string): void {
  const key = getRootDirectoryCacheKey(directory)
  for (const cached of rootDirectoryCache.keys()) if (cached.startsWith(`${key}\0`)) rootDirectoryCache.delete(cached)
  for (const pending of rootDirectoryInflight.keys()) if (pending.startsWith(`${key}\0`)) rootDirectoryInflight.delete(pending)
  rootDirectoryGeneration.set(key, (rootDirectoryGeneration.get(key) ?? 0) + 1)
}

export function clearAllWorkspaceFileCaches(): void {
  const keys = new Set([
    ...[...rootDirectoryCache.keys(), ...rootDirectoryInflight.keys()].map(key => key.split('\0')[0]),
    ...rootDirectoryGeneration.keys(),
  ])
  for (const key of keys) {
    rootDirectoryGeneration.set(key, (rootDirectoryGeneration.get(key) ?? 0) + 1)
  }
  rootDirectoryCache.clear()
  rootDirectoryInflight.clear()
}

export async function searchText(pattern: string, directory?: string, signal?: AbortSignal): Promise<WorkspaceTextSearchMatch[]> {
  const workspacePath = await requireWorkspacePath(directory)
  return signal
    ? (await searchHostFilesText(workspacePath, pattern, 50, signal)).matches
    : (await searchHostFilesText(workspacePath, pattern)).matches
}

export async function searchDirectories(query: string, baseDirectory?: string, limit: number = 50): Promise<string[]> {
  return searchFiles(query, {
    directory: baseDirectory,
    type: 'directory',
    limit,
  })
}
