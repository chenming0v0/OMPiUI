import type {
  CommandRecord,
  ExtensionUiDialogResponse,
  JsonObject,
  JsonValue,
  RegistrySnapshot,
  CommandDescriptor,
  ToolDescriptor,
} from '@ompiui/protocol'
import { isJsonObject } from '@ompiui/protocol'
import type { SessionInfo } from '../vendor/pi-coding-agent'
import type { Model, Api } from '../vendor/pi-ai'
import * as transport from '../transport/index.js'
import { piSessionInfoStore, piBranchStore, piSessionStateStore, piModelsStore } from '../state/index.js'
import { mergeLatestBranchPage } from '../branchMerge.js'
import { windowBranch } from '../branchWindow'
import { historyPagePrefetch, HISTORY_PREFETCH_MAX_PAGES, type HistoryPrefetchMode } from '../historyPagePrefetch'
import { serverStore } from '../../store/serverStore'
import { ompSubagentStore } from '../ompSubagentStore'
import { trackPiSession } from '../ompSessionIndex'
import type { PiBranchPage } from '../domain/index.js'

/**
 * Load a session's native slash commands (extension commands, prompt
 * templates, skills) from the runtime registry.
 */
export async function loadPiSlashCommands(sessionId: string, signal?: AbortSignal): Promise<CommandDescriptor[]> {
  const registry = await loadSessionRegistryCached(sessionId, signal)
  return registry?.commands ?? []
}

/**
 * Load a session's native tool descriptors from the runtime registry.
 */
export async function loadPiSessionTools(sessionId: string, signal?: AbortSignal): Promise<ToolDescriptor[]> {
  const registry = await loadSessionRegistryCached(sessionId, signal)
  return registry?.tools ?? []
}

/**
 * Load all Pi sessions globally.
 */
export async function loadPiSessions(signal?: AbortSignal): Promise<SessionInfo[]> {
  const serverGeneration = serverStore.getActiveServerGeneration()
  const sessions = await sharedSessionList('all', () => transport.listAllPiSessions(signal), signal)
  if (serverStore.getActiveServerGeneration() !== serverGeneration) return sessions
  piSessionInfoStore.replaceAll(sessions)
  return sessions
}

/**
 * Load Pi sessions for specific working directory.
 */
export async function loadPiSessionsForCwd(cwd: string, signal?: AbortSignal): Promise<SessionInfo[]> {
  const serverGeneration = serverStore.getActiveServerGeneration()
  const sessions = await sharedSessionList(cwd, () => transport.listPiSessions({ cwd }, signal), signal)
  if (serverStore.getActiveServerGeneration() !== serverGeneration) return sessions
  piSessionInfoStore.replaceForCwd(cwd, sessions)
  return sessions
}

const listFlights = new Map<string, Promise<SessionInfo[]>>()
const registryCache = new Map<string, { generation: number; expiresAt: number; value: RegistrySnapshot | undefined }>()
const registryFlights = new Map<string, Promise<RegistrySnapshot | undefined>>()
const REGISTRY_CACHE_TTL_MS = 2_000

function loadSessionRegistryCached(sessionId: string, signal?: AbortSignal): Promise<RegistrySnapshot | undefined> {
  const generation = serverStore.getActiveServerGeneration()
  const key = `${generation}:${sessionId}`
  const cached = registryCache.get(key)
  if (cached && cached.expiresAt > Date.now()) return Promise.resolve(cached.value)
  if (signal) return loadSessionRegistryOnce(sessionId, signal)
  const existing = registryFlights.get(key)
  if (existing) return existing
  const flight = loadSessionRegistryOnce(sessionId).finally(() => {
    if (registryFlights.get(key) === flight) registryFlights.delete(key)
  })
  registryFlights.set(key, flight)
  return flight
}

async function loadSessionRegistryOnce(sessionId: string, signal?: AbortSignal): Promise<RegistrySnapshot | undefined> {
  const generation = serverStore.getActiveServerGeneration()
  const value = (await transport.getPiSessionRegistry(sessionId, signal)) as RegistrySnapshot | undefined
  if (serverStore.getActiveServerGeneration() === generation) {
    registryCache.set(`${generation}:${sessionId}`, { generation, expiresAt: Date.now() + REGISTRY_CACHE_TTL_MS, value })
  }
  return value
}

function sharedSessionList(
  key: string,
  load: () => Promise<SessionInfo[]>,
  signal?: AbortSignal,
): Promise<SessionInfo[]> {
  if (signal) return retryUnavailable(load, signal)
  const flightKey = JSON.stringify([serverStore.getActiveServerGeneration(), key])
  const current = listFlights.get(flightKey)
  if (current) return current
  const flight = retryUnavailable(load).finally(() => {
    if (listFlights.get(flightKey) === flight) listFlights.delete(flightKey)
  })
  listFlights.set(flightKey, flight)
  return flight
}

/**
 * Delete a Pi session file.
 */
export async function deletePiSession(cwd: string, sessionFile: string, signal?: AbortSignal): Promise<void> {
  await transport.deletePiSession(cwd, sessionFile, signal)
}

/**
 * 子会话文件 → {运行时 session id, 目录} 的解析缓存。子会话 id 是磁盘身份，
 * 映射不可变；解析走 session.findByFile（只读这一份 jsonl），再加并发合流
 * 和永久缓存，避免长会话里每次展开都把 worker 打满。
 */
const subagentSessionLookups = new Map<string, Promise<{ id: string; directory: string }>>()

/** 子会话解析缓存绑定服务器世代:切换服务器后整表作废,旧世代的在途解析不得写回新世代。 */
let subagentLookupsGeneration = -1

function currentSubagentLookups(): Map<string, Promise<{ id: string; directory: string }>> {
  const generation = serverStore.getActiveServerGeneration()
  if (generation !== subagentLookupsGeneration) {
    subagentSessionLookups.clear()
    subagentLookupsGeneration = generation
  }
  return subagentSessionLookups
}

/** 查看子会话只解析磁盘身份，不启动 Agent runtime，也不争用运行锁。 */
export function openSubagentSession(
  directory: string,
  sessionFile: string,
  signal?: AbortSignal,
): Promise<{ id: string; directory: string }> {
  const normalizedFile = sessionFile.replace(/\\/g, '/')
  const windowsPath = /^[a-z]:\//i.test(normalizedFile) || normalizedFile.startsWith('//')
  const cacheKey = windowsPath ? normalizedFile.toLowerCase() : normalizedFile
  const lookups = currentSubagentLookups()
  const cached = lookups.get(cacheKey)
  if (cached) return cached
  const generation = serverStore.getActiveServerGeneration()
  const lookup = resolveSubagentSession(directory, normalizedFile, signal)
    .then(result => {
      // 解析期间切换过服务器:结果属于旧服务器,既不回填缓存也不登记运行时索引
      if (serverStore.getActiveServerGeneration() !== generation) {
        throw new Error('Server changed during subagent lookup')
      }
      trackPiSession(result.id, result.directory)
      return result
    })
    .catch(error => {
      // 失败不缓存:子会话文件可能稍后才落盘,下次调用重试
      if (lookups.get(cacheKey) === lookup) lookups.delete(cacheKey)
      throw error
    })
  lookups.set(cacheKey, lookup)
  return lookup
}

async function resolveSubagentSession(
  directory: string,
  normalizedFile: string,
  signal?: AbortSignal,
): Promise<{ id: string; directory: string }> {
  const found = await transport.findPiSessionByFile(normalizedFile, signal)
  if (isJsonObject(found) && typeof found.id === 'string') {
    const cwd = typeof found.cwd === 'string' && found.cwd ? found.cwd : directory
    return { id: found.id, directory: cwd }
  }
  throw new Error(`Subagent session not found: ${normalizedFile}`)
}

/**
 * Open a Pi session and load its initial data.
 */
export async function openPiSession(
  cwd: string,
  sessionFile?: string,
  signal?: AbortSignal,
  reuseFromSessionId?: string,
): Promise<transport.PiSessionOpenResult> {
  const result = await transport.openPiSession({ cwd, sessionFile, reuseFromSessionId }, signal)

  if (!result.sessionId) {
    throw new Error('Session open failed: no sessionId returned')
  }

  if (result.sessionFile && result.sessionFileReady !== false) {
    // Existing sessions have a persisted file and can be previewed immediately.
    await loadPiSessionData(result.sessionId, signal)
  } else {
    // A fresh Pi runtime has no session file until its first entry is written.
    // Use the state returned by session.open instead of previewing a path that
    // does not exist yet.
    const state =
      result.state && typeof result.state === 'object' && !Array.isArray(result.state)
        ? (result.state as JsonObject)
        : undefined
    if (state) piSessionStateStore.setState(result.sessionId, state)
    piBranchStore.setData(result.sessionId, {
      head: (state?.head ?? {
        sdkVersion: 'unknown',
        revision: 0,
        header: null,
        leafId: null,
        entryCount: 0,
        epoch: `fresh:${result.sessionId}`,
      }) as PiBranchPage['head'],
      items: [],
      hasMore: false,
    })
  }

  return result
}
export function createPiSession(cwd: string, signal?: AbortSignal): Promise<transport.PiSessionCreateResult> {
  return transport.createPiSession(cwd, signal)
}

/**
 * Load session data (state + branch) for active session.
 */
const BRANCH_PAGE_LIMIT = 100
const BRANCH_PAGE_MAX_BYTES = 128 * 1024
const BRANCH_LARGE_ENTRY_MAX_BYTES = 4 * 1024 * 1024
const sessionRefreshFlights = new Map<string, { promise: Promise<void>; dirty: boolean; includeLive: boolean }>()

/** 普通历史使用小页；单条正文超限时扩大预算，不把原生记录截断或跳过。 */
async function readHistoryPage<T>(
  read: (maxBytes: number) => Promise<T>,
  initialBytes = BRANCH_PAGE_MAX_BYTES,
  signal?: AbortSignal,
): Promise<T> {
  const generation = serverStore.getActiveServerGeneration()
  let maxBytes = initialBytes
  for (;;) {
    signal?.throwIfAborted()
    if (serverStore.getActiveServerGeneration() !== generation) throw new DOMException('Server changed', 'AbortError')
    try {
      const page = await read(maxBytes)
      signal?.throwIfAborted()
      return page
    } catch (error) {
      signal?.throwIfAborted()
      if (serverStore.getActiveServerGeneration() !== generation) throw new DOMException('Server changed', 'AbortError')
      if (!error || typeof error !== 'object' || !('code' in error) ||
        error.code !== 'FILE_TOO_LARGE' || maxBytes >= BRANCH_LARGE_ENTRY_MAX_BYTES) throw error
      maxBytes = Math.min(maxBytes * 2, BRANCH_LARGE_ENTRY_MAX_BYTES)
    }
  }
}

export async function loadPiSessionData(sessionId: string, signal?: AbortSignal): Promise<void> {
  const generation = serverStore.getActiveServerGeneration()
  const flightKey = `${generation}:${sessionId}`
  const existing = sessionRefreshFlights.get(flightKey)
  if (existing) {
    existing.dirty = true
    return existing.promise
  }
  const entry = { promise: Promise.resolve(), dirty: false, includeLive: false }
  const flight = (async () => {
    do {
      entry.dirty = false
      await loadPiSessionDataOnce(sessionId, signal)
    } while (entry.dirty && serverStore.getActiveServerGeneration() === generation)
  })().finally(() => {
    if (sessionRefreshFlights.get(flightKey) === entry) sessionRefreshFlights.delete(flightKey)
  })
  entry.promise = flight
  sessionRefreshFlights.set(flightKey, entry)
  return flight
}

async function loadPiSessionDataOnce(sessionId: string, signal?: AbortSignal): Promise<void> {
  const serverGeneration = serverStore.getActiveServerGeneration()
  const requestVersion = piSessionStateStore.beginRequest(sessionId)
  const branchVersion = piBranchStore.beginRequest(sessionId)
  try {
    const current = piBranchStore.getData(sessionId)
    const preview = await retryUnavailable(
      () =>
        readHistoryPage(maxBytes => transport.previewPiSession(
          sessionId,
          {
            limit: BRANCH_PAGE_LIMIT,
            maxBytes,
            ...(current?.syncCursor ? { syncCursor: current.syncCursor, beforeId: current.items[0]?.id } : {}),
          },
          signal,
        ), undefined, signal),
      signal,
      true,
    )
    if (serverStore.getActiveServerGeneration() !== serverGeneration) return
    piSessionStateStore.setStateIfCurrent(sessionId, preview.state, requestVersion)
    piBranchStore.setDataIfCurrent(
      sessionId,
      mergeLatestBranchPage(piBranchStore.getData(sessionId), preview.branch),
      branchVersion,
    )
  } catch (error) {
    if (serverStore.getActiveServerGeneration() !== serverGeneration) return
    if (piSessionStateStore.isRequestCurrent(sessionId, requestVersion))
      piSessionStateStore.setError(sessionId, error as Error)
    if (piBranchStore.isRequestCurrent(sessionId, branchVersion)) piBranchStore.setError(sessionId, error as Error)
    throw error
  }
}

function isSessionBusyError(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && (error as { code?: unknown }).code === 'SESSION_BUSY')
}

function isTransientServerError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false
  const candidate = error as { status?: unknown; code?: unknown }
  if (candidate.code === 'WORKER_RESULT_UNKNOWN' || candidate.code === 'REQUEST_ABORTED') return false
  return (
    candidate.status === 502 ||
    candidate.status === 503 ||
    candidate.status === 504 ||
    candidate.code === 'BACKEND_UNAVAILABLE'
  )
}

async function waitForRetry(delayMs: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) throw signal.reason ?? new DOMException('The operation was aborted', 'AbortError')
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, delayMs)
    const onAbort = () => {
      clearTimeout(timer)
      reject(signal?.reason ?? new DOMException('The operation was aborted', 'AbortError'))
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

async function retryUnavailable<T>(operation: () => Promise<T>, signal?: AbortSignal, retryBusy = false): Promise<T> {
  const generation = serverStore.getActiveServerGeneration()
  let lastError: unknown
  for (let attempt = 0; attempt < 3; attempt += 1) {
    signal?.throwIfAborted()
    if (serverStore.getActiveServerGeneration() !== generation)
      throw new DOMException('The server changed before retry', 'AbortError')
    try {
      return await operation()
    } catch (error) {
      lastError = error
      if (serverStore.getActiveServerGeneration() !== generation)
        throw new DOMException('The server changed before retry', 'AbortError')
      if ((!isTransientServerError(error) && !(retryBusy && isSessionBusyError(error))) || attempt === 2) throw error
      await waitForRetry(250 * 2 ** attempt, signal)
    }
  }
  throw lastError
}

// 已完成的预取也随原生历史替换释放；checkpoint 更新复用同一 items，不打断阅读。
piBranchStore.subscribe(() => historyPagePrefetch.prune(sessionId => {
  const branch = piBranchStore.getData(sessionId)
  return branch?.hasMore ? branch.items : undefined
}))
serverStore.onServerChange(() => historyPagePrefetch.clear())

/**
 * 快速模式补足两页；空闲模式越过已缓存页，每次再向前预取一页。
 */
export async function prefetchPiBranchEntries(
  sessionId: string,
  mode: HistoryPrefetchMode = 'fast',
  signal?: AbortSignal,
): Promise<boolean> {
  if (signal?.aborted) return false
  const currentBranch = piBranchStore.getData(sessionId)
  const anchor = currentBranch?.items[0]
  if (!currentBranch?.hasMore || !anchor) return false
  const generation = serverStore.getActiveServerGeneration()
  if (!historyPagePrefetch.track(sessionId, generation, currentBranch.items, true)) return false
  const read = (beforeId: string, sharedSignal: AbortSignal) => readHistoryPage(maxBytes => transport.getPiBranchPage(
    sessionId, { beforeId, limit: BRANCH_PAGE_LIMIT, maxBytes }, sharedSignal, false,
  ), undefined, sharedSignal)
  try {
    let boundary = anchor
    for (let depth = 0; depth < HISTORY_PREFETCH_MAX_PAGES; depth++) {
      const latest = piBranchStore.getData(sessionId)
      if (
        signal?.aborted || serverStore.getActiveServerGeneration() !== generation ||
        !latest?.hasMore || !latest.items.some(entry => entry === anchor)
      ) return false
      const cached = historyPagePrefetch.has(sessionId, generation, boundary)
      if (!cached && !historyPagePrefetch.canPrefetch(sessionId, generation)) return false
      const page = await historyPagePrefetch.prefetch(
        sessionId, generation, boundary, sharedSignal => read(boundary.id, sharedSignal), signal,
      )
      const next = page.items[0]
      if (!page.hasMore || !next || next.id === boundary.id) return false
      boundary = next
      if ((mode === 'idle' && !cached) || (mode === 'fast' && depth === 1)) {
        return !signal?.aborted && historyPagePrefetch.canPrefetch(sessionId, generation)
      }
    }
    return false
  } catch {
    // 预取失败不打断阅读；前台加载仍按原有错误提示与重试流程处理。
    return false
  }
}

/**
 * Load more branch entries (pagination).
 * Pages grow backwards: beforeCursor anchors the oldest entry of the current
 * page, so older items must be PREPENDED. checkpoint only exists on the
 * first (latest) page — preserve it when merging older pages.
 */
export async function loadMorePiBranchEntries(sessionId: string, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted()
  const currentBranch = piBranchStore.getData(sessionId)
  if (!currentBranch) {
    throw new Error('No branch data loaded')
  }

  if (!currentBranch.hasMore || !currentBranch.items[0]) {
    return // No more data
  }
  const serverGeneration = serverStore.getActiveServerGeneration()
  const navigation = new AbortController()
  const currentHistory = () => {
    const latest = piBranchStore.getData(sessionId)
    return serverStore.getActiveServerGeneration() === serverGeneration && latest &&
      currentBranch.items.every((entry, index) => latest.items[index]?.id === entry.id)
  }
  const unsubscribe = piBranchStore.subscribe(() => {
    if (!currentHistory()) navigation.abort()
  })
  const consumerSignal = signal ? AbortSignal.any([signal, navigation.signal]) : navigation.signal
  historyPagePrefetch.track(sessionId, serverGeneration, currentBranch.items)

  try {
    const read = (sharedSignal: AbortSignal) => readHistoryPage(maxBytes => transport.getPiBranchPage(
      sessionId,
      { beforeId: currentBranch.items[0].id, limit: BRANCH_PAGE_LIMIT, maxBytes },
      sharedSignal,
      false,
    ), undefined, sharedSignal)
    const rawPage = await historyPagePrefetch.take(
      sessionId, serverGeneration, currentBranch.items[0], read, consumerSignal,
    )
    const olderPage = await transport.hydratePiBranchPage(sessionId, rawPage, consumerSignal, serverGeneration)
    signal?.throwIfAborted()

    const latest = piBranchStore.getData(sessionId)
    if (
      serverStore.getActiveServerGeneration() !== serverGeneration ||
      !latest ||
      !currentBranch.items.every((entry, index) => latest.items[index]?.id === entry.id)
    )
      return

    // Prepend older items; keep latest head/hasMore/cursor from the new page
    piBranchStore.setData(
      sessionId,
      windowBranch(
        {
          ...olderPage,
          head: latest.head,
          syncCursor: latest.syncCursor,
          checkpoint: latest.checkpoint,
          client: latest.client,
          items: [...olderPage.items, ...latest.items],
        },
        true,
      ),
    )
  } catch (error) {
    signal?.throwIfAborted()
    if (!currentHistory()) return
    const code = (error as { code?: string })?.code
    if (code === 'INVALID_REQUEST' || code === 'STALE_CURSOR') {
      const latest = piBranchStore.getData(sessionId)
      if (
        serverStore.getActiveServerGeneration() !== serverGeneration ||
        !latest ||
        !currentBranch.items.every((entry, index) => latest.items[index]?.id === entry.id)
      ) return
      // 光标已失效（worker 重启后密钥变化，或会话被替换/重载）。停掉分页并
      // 重载首页拿新光标，否则每次滚动都会拿同一个坏光标重试、无限刷 400。
      piBranchStore.setData(sessionId, {
        ...latest,
        beforeCursor: undefined,
        hasMore: false,
      })
      void refreshPiBranch(sessionId).catch(() => undefined)
      return
    }
    console.error('Failed to load more branch entries:', error)
    throw error
  } finally {
    unsubscribe()
  }
}

/**
 * Refresh branch with the latest page, merging local pagination history.
 * Used by the event stream when head revision changes.
 */
const branchRefreshFlights = sessionRefreshFlights

export async function returnToLatestPiBranch(sessionId: string): Promise<void> {
  const generation = serverStore.getActiveServerGeneration()
  const version = piBranchStore.beginRequest(sessionId)
  const latest = await readHistoryPage(maxBytes => transport.getPiBranchPage(sessionId, {
    limit: BRANCH_PAGE_LIMIT,
    maxBytes,
  }))
  if (serverStore.getActiveServerGeneration() !== generation) return
  piBranchStore.setDataIfCurrent(sessionId, latest, version)
}

export function refreshPiBranch(
  sessionId: string,
  signal?: AbortSignal,
  options: { includeLiveMessage?: boolean } = {},
): Promise<void> {
  if (signal) return (async () => {
    const invalidatedBySettlement = await refreshPiBranchOnce(sessionId, signal, options.includeLiveMessage)
    if (invalidatedBySettlement) {
      signal.throwIfAborted()
      await refreshPiBranchOnce(sessionId, signal, options.includeLiveMessage)
    }
  })()
  const generation = serverStore.getActiveServerGeneration()
  const key = `${serverStore.getActiveServerGeneration()}:${sessionId}`
  const existing = branchRefreshFlights.get(key)
  if (existing) {
    existing.dirty = true
    existing.includeLive ||= Boolean(options.includeLiveMessage)
    return existing.promise
  }
  const entry = { promise: Promise.resolve(), dirty: false, includeLive: Boolean(options.includeLiveMessage) }
  const flight = (async () => {
    do {
      entry.dirty = false
      const includeLive = entry.includeLive
      entry.includeLive = false
      try {
        await refreshPiBranchOnce(sessionId, undefined, includeLive)
      } catch (error) {
        if (!entry.dirty || serverStore.getActiveServerGeneration() !== generation) throw error
      }
    } while (entry.dirty && serverStore.getActiveServerGeneration() === generation)
  })().finally(() => {
    if (branchRefreshFlights.get(key) === entry) branchRefreshFlights.delete(key)
  })
  entry.promise = flight
  branchRefreshFlights.set(key, entry)
  return flight
}

export function settlePiLiveMessage(sessionId: string): void {
  const changed = piBranchStore.getData(sessionId)?.checkpoint?.liveMessage?.phase === 'streaming'
  piBranchStore.settleLiveMessage(sessionId)
  if (changed) {
    const flight = branchRefreshFlights.get(`${serverStore.getActiveServerGeneration()}:${sessionId}`)
    if (flight) flight.dirty = true
  }
}

async function refreshPiBranchOnce(sessionId: string, signal?: AbortSignal, includeLive = false): Promise<boolean | void> {
  const serverGeneration = serverStore.getActiveServerGeneration()
  const version = piBranchStore.beginRequest(sessionId)
  const current = piBranchStore.getData(sessionId)
  const params = { limit: BRANCH_PAGE_LIMIT, maxBytes: includeLive ? 4 * 1024 * 1024 : BRANCH_PAGE_MAX_BYTES }
  let latest = await readHistoryPage(maxBytes => transport.getPiBranchPage(
    sessionId,
    {
      ...params,
      maxBytes,
      ...(includeLive ? { includeLiveMessage: true } : {}),
      ...(current?.syncCursor ? { syncCursor: current.syncCursor, beforeId: current.items[0]?.id } : {}),
    },
    signal,
  ), params.maxBytes, signal)
  if (serverStore.getActiveServerGeneration() !== serverGeneration) return
  if (!piBranchStore.isRequestCurrent(sessionId, version)) {
    const settled = piBranchStore.getData(sessionId)?.checkpoint?.liveMessage
    return current?.checkpoint?.liveMessage?.phase === 'streaming' &&
      settled?.id === current.checkpoint.liveMessage.id && settled?.phase === 'persisting'
  }
  if (latest.deltaFrom && latest.deltaFrom !== piBranchStore.getData(sessionId)?.syncCursor) {
    latest = await readHistoryPage(maxBytes => transport.getPiBranchPage(sessionId, { ...params, maxBytes }, signal), params.maxBytes, signal)
  }
  if (serverStore.getActiveServerGeneration() !== serverGeneration) return
  piBranchStore.setDataIfCurrent(sessionId, mergeLatestBranchPage(piBranchStore.getData(sessionId), latest), version)
}

/**
 * Refresh runtime state only.
 * Used by the event stream when state-only events arrive.
 */
export async function refreshPiSessionState(sessionId: string, signal?: AbortSignal): Promise<void> {
  const serverGeneration = serverStore.getActiveServerGeneration()
  const requestVersion = piSessionStateStore.beginRequest(sessionId)
  const snapshot = await transport.getPiSessionState(sessionId, signal)
  if (serverStore.getActiveServerGeneration() !== serverGeneration) return
  const currentRequest = piSessionStateStore.isRequestCurrent(sessionId, requestVersion)
  if (!piSessionStateStore.setStateIfCurrent(sessionId, snapshot as JsonObject, requestVersion)) return
  if (!currentRequest) return
  const state = piSessionStateStore.getState(sessionId)
  // worker 的子代理注册表快照并入全局 store：页面刷新 / 重连后 HUD 与
  // TaskRenderer 内联视图据此恢复（运行中的随后由 progress 帧继续推进）
  if (isJsonObject(state)) {
    const settled =
      state.isIdle === true &&
      !state.isStreaming &&
      !state.isCompacting &&
      !state.isRetrying &&
      !state.isBashRunning &&
      !state.hasPendingAsyncWork
    if (settled) settlePiLiveMessage(sessionId)
    if (Array.isArray(state.subagents) || (settled && state.diskPreview === true)) {
      ompSubagentStore.applySnapshot(sessionId, Array.isArray(state.subagents) ? state.subagents : [], settled)
    }
  }
}

/**
 * Send a prompt to Pi session.
 */
export async function sendPiPrompt(
  sessionId: string,
  text: string,
  options?: { streamingBehavior?: 'steer' | 'followUp' },
  signal?: AbortSignal,
): Promise<void> {
  try {
    await transport.promptPi(sessionId, { text, streamingBehavior: options?.streamingBehavior }, signal)
    // State will be updated via events
  } catch (error) {
    console.error('Failed to send prompt:', error)
    throw error
  }
}

/**
 * Compact the session context (native /compact). Serialized — submit, then
 * wait for completion so callers can resolve pending UI.
 */
export async function compactPiSession(
  sessionId: string,
  customInstructions?: string,
  signal?: AbortSignal,
): Promise<JsonValue> {
  try {
    const submitted = await transport.compactPi(sessionId, customInstructions, signal)
    // 压缩经常超过默认 30s 的 waitHostCommand 超时（会误报 Command timed out，
    // 但压缩其实还在跑）。给它 15 分钟，让结果由 compaction_end 事件/轮询正常落地。
    return await transport.waitHostCommand(submitted.id, signal, 15 * 60_000)
  } catch (error) {
    console.error('Failed to compact session:', error)
    throw error
  }
}

/**
 * Reload runtime resources (extensions, skills, prompts, themes). Serialized
 * — submit, then wait for completion.
 */
export async function reloadPiSessionResources(sessionId: string, signal?: AbortSignal): Promise<void> {
  const submitted = await transport.reloadPiSession(sessionId, signal)
  await transport.waitHostCommand(submitted.id, signal)
}

/**
 * Load the session's full runtime registry (tools, commands, extensions,
 * event handlers).
 */
export async function loadPiSessionRegistry(
  sessionId: string,
  signal?: AbortSignal,
): Promise<RegistrySnapshot | undefined> {
  return loadSessionRegistryCached(sessionId, signal)
}

/** Submit a serialized session command and wait for its result. */
async function submitAndWait(
  submit: () => Promise<CommandRecord>,
  signal?: AbortSignal,
  timeoutMs = 30_000,
): Promise<JsonValue> {
  const submitted = await submit()
  return transport.waitHostCommand(submitted.id, signal, timeoutMs)
}

/** Create a new native session from the current runtime (replacement). */
export async function newPiSessionFrom(sessionId: string, signal?: AbortSignal): Promise<transport.PiForkResult> {
  return ((await submitAndWait(() => transport.newPiSession(sessionId, sessionId), signal)) ??
    {}) as transport.PiForkResult
}

export async function cyclePiModel(
  sessionId: string,
  direction?: 'forward' | 'backward',
  signal?: AbortSignal,
): Promise<void> {
  await submitAndWait(() => transport.cyclePiModel(sessionId, direction, signal), signal)
}

export async function cyclePiThinkingLevel(sessionId: string, signal?: AbortSignal): Promise<void> {
  await submitAndWait(() => transport.cyclePiThinkingLevel(sessionId, signal), signal)
}

export async function setPiScopedModels(sessionId: string, patterns: string[], signal?: AbortSignal): Promise<void> {
  await submitAndWait(() => transport.setPiScopedModels(sessionId, patterns, signal), signal)
}

/** Run a one-shot bash command; resolves with the native result. */
export async function executePiBash(
  sessionId: string,
  command: string,
  excludeFromContext?: boolean,
  clientId?: string,
  signal?: AbortSignal,
): Promise<JsonValue> {
  return submitAndWait(() => transport.executePiBash(sessionId, command, excludeFromContext, clientId, signal), signal)
}

export async function abortPiBashExecution(sessionId: string, signal?: AbortSignal): Promise<void> {
  await transport.abortPiBash(sessionId, signal)
}

/** Export the session; resolves with the native result (output path etc.). */
export async function exportPiSession(
  sessionId: string,
  format: 'html' | 'jsonl',
  outputPath: string,
  signal?: AbortSignal,
): Promise<JsonValue> {
  const submit =
    format === 'html'
      ? () => transport.exportPiSessionHtml(sessionId, outputPath, signal)
      : () => transport.exportPiSessionJsonl(sessionId, outputPath, signal)
  return submitAndWait(submit, signal, 15 * 60_000)
}

export async function waitForPiIdle(sessionId: string, signal?: AbortSignal): Promise<void> {
  await submitAndWait(() => transport.waitPiForIdle(sessionId, signal), signal)
}

export async function sendPiCustomMessage(
  sessionId: string,
  params: Parameters<typeof transport.sendPiCustomMessage>[1],
  signal?: AbortSignal,
): Promise<void> {
  await submitAndWait(() => transport.sendPiCustomMessage(sessionId, params, signal), signal)
}

export async function appendPiCustomEntry(
  sessionId: string,
  customType: string,
  data: JsonValue,
  signal?: AbortSignal,
): Promise<void> {
  await submitAndWait(() => transport.appendPiCustomEntry(sessionId, customType, data, signal), signal)
}

/**
 * Send steering input to Pi session.
 */
export async function sendPiSteer(sessionId: string, text: string, signal?: AbortSignal): Promise<void> {
  try {
    await transport.steerPi(sessionId, { text }, signal)
  } catch (error) {
    console.error('Failed to send steer:', error)
    throw error
  }
}

/**
 * Send follow-up input to Pi session.
 */
export async function sendPiFollowUp(sessionId: string, text: string, signal?: AbortSignal): Promise<void> {
  try {
    await transport.followUpPi(sessionId, { text }, signal)
  } catch (error) {
    console.error('Failed to send follow-up:', error)
    throw error
  }
}

/**
 * Send a user message through the unified native entry (sendUserMessage).
 * deliverAs: 'steer' interrupts the current turn, 'followUp' queues after
 * it; omit when idle. Images are native ImageContent blocks.
 */
export async function sendPiUserMessage(
  sessionId: string,
  text: string,
  images?: transport.PiImageInput[],
  deliverAs?: 'steer' | 'followUp',
  signal?: AbortSignal,
): Promise<void> {
  await transport.sendPiUserMessage(sessionId, { text, images, deliverAs }, signal)
}

/**
 * Abort current Pi operation.
 */
export async function abortPiOperation(sessionId: string, signal?: AbortSignal): Promise<void> {
  try {
    await transport.abortPi(sessionId, signal)
  } catch (error) {
    console.error('Failed to abort operation:', error)
    throw error
  }
}

/**
 * Set Pi model.
 */
export async function setPiModel(
  sessionId: string,
  provider: string,
  modelId: string,
  signal?: AbortSignal,
): Promise<void> {
  try {
    await submitAndWait(() => transport.setPiModel(sessionId, { provider, modelId }, signal), signal)
  } catch (error) {
    console.error('Failed to set model:', error)
    throw error
  }
}

/**
 * Set Pi thinking level.
 */
export async function setPiThinkingLevel(sessionId: string, level: string, signal?: AbortSignal): Promise<void> {
  try {
    await submitAndWait(() => transport.setPiThinkingLevel(sessionId, { level }, signal), signal)
  } catch (error) {
    console.error('Failed to set thinking level:', error)
    throw error
  }
}

/**
 * Rename a Pi session.
 */
export async function renamePiSession(sessionId: string, name: string, signal?: AbortSignal): Promise<void> {
  // 序列化命令，等它真正执行完——否则调用方紧接着刷新列表读到的还是旧名字
  const submitted = await transport.setPiSessionName(sessionId, name, signal)
  await transport.waitHostCommand(submitted.id, signal)
}

/**
 * Respond to an extension UI dialog request.
 */
export async function respondPiExtensionUi(
  sessionId: string,
  requestId: string,
  response: ExtensionUiDialogResponse,
  signal?: AbortSignal,
): Promise<void> {
  await transport.respondPiExtensionUi(sessionId, requestId, response, signal)
}

/**
 * Send editor text state to extensions (composer content sync).
 */
export async function setPiExtensionEditorState(sessionId: string, text: string, signal?: AbortSignal): Promise<void> {
  await transport.setPiExtensionEditorState(sessionId, text, signal)
}

/**
 * Fork the session at an entry (native fork: new session file, runtime
 * switches to it). fork is a serialized command — submit, then wait for
 * the result carrying targetSessionId.
 */
export async function forkPiSession(
  sessionId: string,
  entryId: string,
  position: 'before' | 'at' = 'at',
  signal?: AbortSignal,
): Promise<transport.PiForkResult> {
  const submitted = await transport.forkPiSession(sessionId, { entryId, position }, signal)
  const result = await transport.waitHostCommand(submitted.id, signal)
  return (result ?? {}) as transport.PiForkResult
}

/**
 * Navigate the session tree to an entry (branch switch / undo). Serialized —
 * submit, then wait for the result carrying editorText/cancelled.
 */
export async function navigatePiTree(
  sessionId: string,
  params: transport.PiNavigateTreeParams,
  signal?: AbortSignal,
): Promise<transport.PiNavigateTreeResult> {
  const submitted = await transport.navigatePiTree(sessionId, params, signal)
  const result = await transport.waitHostCommand(submitted.id, signal)
  return (result ?? {}) as transport.PiNavigateTreeResult
}

/**
 * Import a session file and switch to it. Same replacement shape as fork.
 */
export async function importPiSession(
  sessionId: string,
  inputPath: string,
  cwdOverride?: string,
  signal?: AbortSignal,
): Promise<transport.PiForkResult> {
  const submitted = await transport.importPiSession(sessionId, inputPath, cwdOverride, signal)
  const result = await transport.waitHostCommand(submitted.id, signal)
  return (result ?? {}) as transport.PiForkResult
}

/**
 * Set an entry label, then refresh session state (tree labels ride along).
 */
export async function setPiEntryLabel(
  sessionId: string,
  entryId: string,
  label?: string,
  signal?: AbortSignal,
): Promise<void> {
  const submitted = await transport.setPiLabel(sessionId, entryId, label, signal)
  await transport.waitHostCommand(submitted.id, signal)
}

export async function setPiActiveTools(sessionId: string, toolNames: string[], signal?: AbortSignal): Promise<void> {
  const submitted = await transport.setPiActiveTools(sessionId, toolNames, signal)
  await transport.waitHostCommand(submitted.id, signal)
}

export async function setPiAutoCompaction(sessionId: string, enabled: boolean, signal?: AbortSignal): Promise<void> {
  const submitted = await transport.setPiAutoCompaction(sessionId, enabled, signal)
  await transport.waitHostCommand(submitted.id, signal)
}

export async function setPiAutoRetry(sessionId: string, enabled: boolean, signal?: AbortSignal): Promise<void> {
  const submitted = await transport.setPiAutoRetry(sessionId, enabled, signal)
  await transport.waitHostCommand(submitted.id, signal)
}

/** Abort an active compaction (immediate). */
export async function abortPiCompaction(sessionId: string, signal?: AbortSignal): Promise<void> {
  await transport.abortPiCompaction(sessionId, signal)
}

/** Abort an active branch summary (immediate). */
export async function abortPiBranchSummary(sessionId: string, signal?: AbortSignal): Promise<void> {
  await transport.abortPiBranchSummary(sessionId, signal)
}

/** Abort an active auto-retry (immediate). */
export async function abortPiRetry(sessionId: string, signal?: AbortSignal): Promise<void> {
  await transport.abortPiRetry(sessionId, signal)
}

/** Clear pending steering/follow-up queues (immediate); returns the cleared snapshot. */
export async function clearPiQueue(
  sessionId: string,
  signal?: AbortSignal,
): Promise<{ steering: string[]; followUp: string[] } | null> {
  return (await transport.clearPiQueue(sessionId, signal)) as { steering: string[]; followUp: string[] } | null
}

export async function setPiSteeringMode(
  sessionId: string,
  mode: 'all' | 'one-at-a-time',
  signal?: AbortSignal,
): Promise<void> {
  await transport.setPiSteeringMode(sessionId, mode, signal)
}

export async function setPiFollowUpMode(
  sessionId: string,
  mode: 'all' | 'one-at-a-time',
  signal?: AbortSignal,
): Promise<void> {
  await transport.setPiFollowUpMode(sessionId, mode, signal)
}

/**
 * Load available models from the Pi model runtime into the models store.
 */
const modelFlights = new Map<string, Promise<Model<Api>[]>>()

export async function loadPiModels(signal?: AbortSignal): Promise<Model<Api>[]> {
  const serverGeneration = serverStore.getActiveServerGeneration()
  const syncVersion = piModelsStore.getSyncVersion()
  const key = `${serverGeneration}:${syncVersion}`
  const existing = modelFlights.get(key)
  if (existing) return existing

  const flight = loadPiModelsOnce(serverGeneration, syncVersion, signal)
  modelFlights.set(key, flight)
  void flight
    .finally(() => {
      if (modelFlights.get(key) === flight) modelFlights.delete(key)
    })
    .catch(() => undefined)
  return flight
}

export async function setPiProjectTrust(cwd: string, decision: boolean | null, signal?: AbortSignal): Promise<void> {
  await transport.setProjectTrust(cwd, decision, signal)
}

export async function logoutPiProvider(providerId: string, signal?: AbortSignal): Promise<void> {
  await transport.logoutProvider(providerId, signal)
}

export async function startPiProviderAuth(
  providerId: string,
  authType?: 'api_key' | 'oauth',
  signal?: AbortSignal,
): Promise<void> {
  await transport.startProviderAuth(providerId, authType, signal)
}

async function loadPiModelsOnce(
  serverGeneration: number,
  syncVersion: number,
  signal?: AbortSignal,
): Promise<Model<Api>[]> {
  piModelsStore.setLoading(true)
  try {
    const result = await retryUnavailable(() => transport.listPiModels(signal), signal)
    const models = (Array.isArray(result) ? result : []) as unknown as Model<Api>[]
    if (serverStore.getActiveServerGeneration() !== serverGeneration || piModelsStore.getSyncVersion() !== syncVersion)
      return models
    piModelsStore.setModels(models)
    return models
  } catch (error) {
    if (serverStore.getActiveServerGeneration() !== serverGeneration || piModelsStore.getSyncVersion() !== syncVersion)
      throw error
    piModelsStore.setError(error as Error)
    throw error
  }
}
