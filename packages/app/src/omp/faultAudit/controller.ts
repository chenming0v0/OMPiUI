import { isJsonObject, type FaultReport, type FaultStatus, type FaultNotice } from '@ompiui/protocol'
import { serverStore } from '../../store/serverStore'
import { getApiBase, piFetch } from '../httpClient'
import { faultAuditStore } from './store'
import { FaultMonitor, type ConnectionMemory } from './monitor'

const MEMORY_KEY = 'ompiui-fault-connections'
let monitor: FaultMonitor | undefined
let stopMonitoring: (() => void) | undefined
let resumeProbe: (() => void) | undefined

function serverId(): string {
  return serverStore.getActiveServer()?.id ?? 'default'
}
function loadMemory(id: string): ConnectionMemory {
  try {
    const memory = JSON.parse(localStorage.getItem(MEMORY_KEY) ?? '{}')[id] as ConnectionMemory | undefined
    if (memory && Array.isArray(memory.busySessions) && Date.now() - (memory.checkedAt ?? 0) < 24 * 60 * 60_000)
      return memory
  } catch {
    /* 无持久状态则从当前连接重新建立基线。 */
  }
  return { busySessions: [] }
}
function saveMemory(id: string, memory: ConnectionMemory): void {
  try {
    const all = JSON.parse(localStorage.getItem(MEMORY_KEY) ?? '{}') as Record<string, ConnectionMemory>
    all[id] = memory
    localStorage.setItem(MEMORY_KEY, JSON.stringify(Object.fromEntries(Object.entries(all).slice(-20))))
  } catch {
    /* 本地存储不可用不影响会话连接。 */
  }
}

export async function collectFaultReport(replaceUploaded = false): Promise<void> {
  const saved = faultAuditStore.getSnapshot().saved
  if (!saved || saved.serverId !== serverId()) return
  const id = faultAuditStore.beginCollection(replaceUploaded)
  if (!id) return
  const generation = serverStore.getActiveServerGeneration()
  try {
    const response = await piFetch(`${getApiBase()}/api/v1/host/diagnostics/report`, {
      retry: false,
      signal: AbortSignal.timeout(120_000),
      timeoutMs: 120_000,
    })
    if (!response.ok) throw new Error('REPORT_UNAVAILABLE')
    const raw: unknown = await response.json()
    if (
      !isJsonObject(raw) ||
      typeof raw.content !== 'string' ||
      typeof raw.complete !== 'boolean' ||
      !Array.isArray(raw.unavailable) ||
      typeof raw.files !== 'number'
    )
      throw new Error('REPORT_INVALID')
    if (serverStore.getActiveServerGeneration() !== generation) throw new Error('SERVER_CHANGED')
    faultAuditStore.finishCollection(id, raw as unknown as FaultReport)
  } catch {
    faultAuditStore.finishCollection(id)
  }
}

export function reportRuntimeCrash(sessionId: string, faultId?: string, time?: string, errorCode?: string): void {
  detect({
    id: faultId ?? `runtime:${sessionId}:${Date.now()}`,
    kind: 'runtime_crashed',
    sessionId,
    time: time ?? new Date().toISOString(),
    errorCode: errorCode ?? 'SESSION_RUNTIME_CRASHED',
  })
}

function detect(notice: FaultNotice): void {
  if (!faultAuditStore.detect(notice, serverId())) return
  void collectFaultReport()
  if (notice.sessionId && (notice.kind === 'runtime_crashed' || notice.kind === 'server_restarted')) {
    const sessionId = notice.sessionId
    const generation = serverStore.getActiveServerGeneration()
    // 补到的故障可能属于上一轮；读取当前状态，不能直接覆盖已经重新开始的任务。
    void import('../controllers/index.js')
      .then(async controllers => {
        if (serverStore.getActiveServerGeneration() !== generation) return
        await controllers.refreshPiSessionState(sessionId)
        if (serverStore.getActiveServerGeneration() === generation) await controllers.refreshPiBranch(sessionId)
      })
      .catch(() => {
        /* 后端仍不可达时保留故障提示，由重连继续校准。 */
      })
  }
}

export function recordClientDiagnostic(event: string, fields: Record<string, unknown>): void {
  faultAuditStore.record(event, fields)
  if (event === 'state' && typeof fields.sessionId === 'string' && isJsonObject(fields.state)) {
    monitor?.sessionState(fields.sessionId, fields.state)
  } else if (event === 'activity' && typeof fields.sessionId === 'string') {
    monitor?.sessionState(fields.sessionId, { isStreaming: fields.status !== 'idle' })
  }
}
export function faultSocketOpened(): void {
  monitor?.socketOpened()
  faultAuditStore.record('socket_opened')
  resumeProbe?.()
}
export function faultSocketClosed(code: number): void {
  monitor?.socketClosed(code)
  faultAuditStore.record('socket_closed', { code })
}
export function faultSocketUnused(): void {
  monitor?.socketUnused()
}

export function startFaultAudit(): () => void {
  if (stopMonitoring) return () => {}
  let busy = false
  let stopped = false
  let failures = 0
  let nextProbeAt = 0
  let leader = !navigator.locks
  let leaseController: AbortController | undefined
  let releaseLease: (() => void) | undefined
  const channel = typeof BroadcastChannel === 'undefined' ? undefined : new BroadcastChannel('ompiui-health')
  const key = () => `${getApiBase()}:${serverId()}`
  const recoverReport = () => {
    const saved = faultAuditStore.getSnapshot().saved
    if (
      saved?.serverId === serverId() &&
      saved.report.unavailable.includes('server_unreachable') &&
      saved.upload.links.length === 0
    ) {
      void collectFaultReport()
    }
  }
  if (channel)
    channel.onmessage = event => {
      const data = event.data as { key?: string; status?: FaultStatus; failed?: string }
      if (stopped || data.key !== key()) return
      if (data.status) {
        monitor?.healthy(data.status)
        recoverReport()
      } else if (data.failed) monitor?.failed(data.failed)
    }
  const reset = (restore = false) => {
    failures = 0
    nextProbeAt = 0
    const id = serverId()
    monitor = new FaultMonitor(
      id,
      detect,
      memory => saveMemory(id, memory),
      restore ? loadMemory(id) : { busySessions: [] },
    )
  }
  reset(true)
  const probe = async () => {
    if (busy || stopped) return
    const eligible = navigator.onLine && document.visibilityState !== 'hidden'
    monitor?.tick(eligible)
    if (!eligible || !leader || Date.now() < nextProbeAt) return
    busy = true
    const current = monitor
    try {
      const response = await piFetch(`${getApiBase()}/api/v1/host/diagnostics/status`, {
        retry: false,
        signal: AbortSignal.timeout(4000),
      })
      // 旧服务端没有报告接口，不能把 404 当成整个后端无法连接。
      if (response.status === 404) {
        const health = await piFetch(`${getApiBase()}/api/v1/host/health`, {
          retry: false,
          signal: AbortSignal.timeout(4000),
        })
        if (!health.ok) throw new Error(`HTTP_${health.status}`)
        const body: unknown = await health.json()
        if (!isJsonObject(body) || body.service !== 'ompiui-server') throw new Error('STATUS_INVALID')
        if (monitor === current && !stopped) {
          const status = { runId: `legacy:${String(body.processId ?? 'unknown')}`, version: 'legacy', faults: [] }
          current?.healthy(status)
          channel?.postMessage({ key: key(), status })
          recoverReport()
        }
        failures = 0
        return
      }
      if (!response.ok) throw new Error(`HTTP_${response.status}`)
      const raw: unknown = await response.json()
      if (!isJsonObject(raw) || typeof raw.runId !== 'string' || !Array.isArray(raw.faults))
        throw new Error('STATUS_INVALID')
      if (monitor !== current || stopped) return
      current?.healthy(raw as unknown as FaultStatus)
      channel?.postMessage({ key: key(), status: raw })
      failures = 0
      // 断线报告恢复后补齐日志；已有上传分片不改变内容，避免混接不同报告。
      recoverReport()
    } catch (error) {
      if (monitor !== current || stopped) return
      current?.failed(error instanceof Error && /^HTTP_/.test(error.message) ? error.message : 'CONNECTION_UNAVAILABLE')
      channel?.postMessage({
        key: key(),
        failed: error instanceof Error && /^HTTP_/.test(error.message) ? error.message : 'CONNECTION_UNAVAILABLE',
      })
      failures++
      faultAuditStore.record('health_failed', { errorCode: error instanceof Error ? error.name : 'UNKNOWN' })
    } finally {
      busy = false
      if (monitor === current)
        nextProbeAt =
          Date.now() +
          (failures
            ? Math.min(30_000, 5000 * 2 ** Math.min(failures, 3))
            : loadMemory(serverId()).busySessions.length
              ? 5000
              : 30_000) *
            (0.8 + Math.random() * 0.2)
      if (monitor === current) current?.tick(navigator.onLine && document.visibilityState !== 'hidden')
    }
  }
  const release = () => {
    leaseController?.abort()
    releaseLease?.()
    releaseLease = undefined
    leader = !navigator.locks
  }
  const elect = () => {
    release()
    if (!navigator.locks || document.visibilityState === 'hidden') return
    const controller = new AbortController()
    leaseController = controller
    void navigator.locks
      .request(`ompiui-health:${key()}`, { signal: controller.signal }, async () => {
        if (stopped || controller.signal.aborted) return
        leader = true
        nextProbeAt = 0
        void probe()
        await new Promise<void>(resolve => {
          releaseLease = resolve
        })
        if (leaseController === controller) leader = false
      })
      .catch(() => {
        /* 退出或切换后取消排队选举。 */
      })
  }
  elect()
  const timer = setInterval(() => void probe(), 5000)
  const unsubscribe = serverStore.onServerChange(() => {
    reset()
    elect()
    void probe()
  })
  const visibility = () => {
    if (document.visibilityState !== 'hidden') {
      elect()
      nextProbeAt = 0
      void probe()
    } else {
      release()
      monitor?.suspend()
    }
  }
  document.addEventListener('visibilitychange', visibility)
  const online = () => {
    nextProbeAt = 0
    failures = 0
    void probe()
  }
  resumeProbe = online
  window.addEventListener('online', online)
  void probe()
  stopMonitoring = () => {
    stopped = true
    if (resumeProbe === online) resumeProbe = undefined
    release()
    channel?.close()
    clearInterval(timer)
    unsubscribe()
    document.removeEventListener('visibilitychange', visibility)
    window.removeEventListener('online', online)
    monitor = undefined
    stopMonitoring = undefined
  }
  return stopMonitoring
}
