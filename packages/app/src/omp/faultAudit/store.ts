import {
  redactDiagnosticText, uploadFaultReport,
  type FaultNotice, type FaultReport, type FaultUploadProgress,
} from '@ompiui/protocol'
import { getHttpFetch } from '../../utils/tauri'
import { desktopDiagnosticsStore } from '../../store/desktopDiagnosticsStore'
import { readFullSavedFault, readSavedFault, saveFault, type SavedFault } from './storage'
import { auditHttpRequest } from '../trafficAudit/http'

export type ClientFaultEvent = {
  time: string
  event: string
  sessionId?: string
  errorCode?: string
  code?: number
  state?: Record<string, string | boolean | number>
}

export type FaultAuditSnapshot = {
  saved?: SavedFault
  collecting: boolean
  uploading: boolean
  error?: string
  history: ClientFaultEvent[]
}

const SAFE_STATE = ['isStreaming', 'isIdle', 'isCompacting', 'isBashRunning', 'hasPendingAsyncWork', 'readOnly', 'pendingMessageCount', 'goalStatus']
function safeText(value: unknown): string | undefined {
  return typeof value === 'string' ? redactDiagnosticText(value.slice(0, 256)) : undefined
}
function reportRevision(): string {
  return typeof globalThis.crypto?.randomUUID === 'function'
    ? crypto.randomUUID() : `report-${Date.now()}-${Math.random().toString(36).slice(2)}`
}

export class FaultAuditStore {
  private current: FaultAuditSnapshot
  private listeners = new Set<() => void>()
  private readonly seen = new Set<string>()
  private discardedClientEvents = 0

  constructor(restore = true) {
    this.current = { saved: restore ? readSavedFault() : undefined, collecting: false, uploading: false, history: [] }
    const initial = this.current.saved
    if (restore) void readFullSavedFault().then(saved => {
      if (saved && this.current.saved === initial && saved.notice.id === initial?.notice.id &&
        saved.reportRevision === initial?.reportRevision && !this.current.uploading && !this.current.collecting) {
        this.update({ saved: { ...initial, report: saved.report } })
      }
    }).catch(() => undefined)
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }
  getSnapshot = (): FaultAuditSnapshot => this.current
  private update(patch: Partial<FaultAuditSnapshot>): void {
    this.current = { ...this.current, ...patch }
    for (const listener of this.listeners) listener()
  }

  record(event: string, raw: Record<string, unknown> = {}): void {
    if (this.current.history.length >= 300) this.discardedClientEvents++
    const state = raw.state && typeof raw.state === 'object'
      ? Object.fromEntries(Object.entries(raw.state).filter(([key, value]) => SAFE_STATE.includes(key) &&
        ['boolean', 'number', 'string'].includes(typeof value)).map(([key, value]) =>
        [key, typeof value === 'string' ? safeText(value)! : value])) : undefined
    const entry: ClientFaultEvent = {
      time: new Date().toISOString(), event: safeText(event) ?? 'unknown',
      sessionId: safeText(raw.sessionId), errorCode: safeText(raw.errorCode),
      ...(typeof raw.code === 'number' ? { code: raw.code } : {}), ...(state ? { state } : {}),
    }
    // 诊断不向 React 广播每个网络事件，只在故障状态发生变化时通知。
    this.current = { ...this.current, history: [...this.current.history.slice(-299), entry] }
  }

  detect(notice: FaultNotice, serverId: string): boolean {
    if (this.seen.has(notice.id) || this.current.saved?.notice.id === notice.id) return false
    this.seen.add(notice.id)
    if (this.seen.size > 200) this.seen.delete(this.seen.values().next().value!)
    const saved = this.current.saved
    if (this.current.collecting || this.current.uploading) {
      this.record('additional_fault', { sessionId: notice.sessionId, errorCode: notice.errorCode })
      return false
    }
    // 未处理的报告不可被第二次故障覆盖，关联事件仍追加到本地时间线。
    if (saved && saved.serverId === serverId && !saved.upload.indexUrl &&
      Date.parse(notice.time) - Date.parse(saved.notice.time) < 10 * 60_000) {
      this.record('additional_fault', { sessionId: notice.sessionId, errorCode: notice.errorCode })
      return false
    }
    const safeNotice: FaultNotice = { ...notice, errorCode: safeText(notice.errorCode), sessionId: safeText(notice.sessionId) }
    const client = this.clientContent(safeNotice)
    const next: SavedFault = {
      notice: safeNotice, serverId, open: true,
      reportRevision: reportRevision(),
      report: { content: client, complete: false, unavailable: ['server_logs_not_collected'], files: 0 },
      upload: { links: [], total: 0 },
    }
    this.update({ saved: next, error: undefined })
    saveFault(next)
    return true
  }

  private clientContent(notice: FaultNotice): string {
    const desktop = desktopDiagnosticsStore.getSnapshot()
    const startup = desktop.native
    return [
      'OMPiUI client fault report', `App version: ${typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : 'development'}`,
      `Incident: ${JSON.stringify(notice)}`,
      `Platform: ${/Android/i.test(navigator.userAgent) ? 'Android' : /Windows/i.test(navigator.userAgent) ? 'Windows' : 'Web'}`,
      `Online: ${navigator.onLine}; visibility: ${document.visibilityState}`,
      `Client retention: latest 300 metadata events; older events evicted: ${this.discardedClientEvents}`,
      // 仅共享启动阶段和时间；本机输出、错误正文、地址和环境变量不进入报告。
      ...(startup || desktop.commandError ? [`Desktop startup (metadata only): ${JSON.stringify({
        phase: startup?.phase, requestedAt: startup?.requestedAt, spawnedAt: startup?.spawnedAt,
        completedAt: startup?.completedAt, events: startup?.events,
        reachable: startup?.reachable, workerReady: startup?.workerReady,
        commandFailed: !!desktop.commandError,
      })}`] : []),
      'Client events (metadata only):', ...this.current.history.map(event => JSON.stringify(event)),
    ].join('\n')
  }

  beginCollection(replaceUploaded = false): string | undefined {
    if (!this.current.saved || this.current.collecting || this.current.uploading || (this.current.saved.upload.links.length && !replaceUploaded)) return undefined
    this.update({ collecting: true, error: undefined })
    return this.current.saved.notice.id
  }

  cancelCollection(id: string): void {
    if (this.current.saved?.notice.id === id) this.update({ collecting: false })
  }

  finishCollection(id: string, report?: FaultReport, unavailable = 'server_unreachable'): void {
    if (this.current.saved?.notice.id !== id) return
    const saved = this.current.saved
    const next = report ? {
      ...saved,
      reportRevision: reportRevision(),
      report: { ...report, content: redactDiagnosticText(`${this.clientContent(saved.notice)}\n\n${report.content}`) },
      previousLinks: [...new Set([
        ...(saved.previousLinks ?? []), ...(saved.upload.indexUrl ? [saved.upload.indexUrl] : saved.upload.links),
      ])].slice(-20),
      upload: { links: [], total: 0 },
    } : {
      ...saved,
      report: { ...saved.report, complete: false, unavailable: [...new Set([...saved.report.unavailable, unavailable])] },
    }
    this.update({ saved: next, collecting: false })
    saveFault(next)
  }

  dismiss(): void {
    if (!this.current.saved) return
    const saved = { ...this.current.saved, open: false }
    this.update({ saved })
    saveFault(saved)
  }
  reopen(): void {
    if (!this.current.saved) return
    const saved = { ...this.current.saved, open: true }
    this.update({ saved })
    saveFault(saved)
  }
  setError(error: string): void { this.update({ error }) }

  async upload(fetchImpl?: typeof fetch): Promise<void> {
    const saved = this.current.saved
    if (!saved || this.current.uploading || this.current.collecting) return
    if (saved.report.unavailable.includes('full_report_in_indexeddb')) { this.setError('MCLOG_REPORT_NOT_RESTORED'); return }
    this.update({ uploading: true, error: undefined })
    try {
      const send = fetchImpl ?? await getHttpFetch()
      const auditedSend: typeof fetch = (input, init) => auditHttpRequest(
        String(input),
        init,
        () => send(input, init),
      )
      await uploadFaultReport(saved.report.content, auditedSend, saved.upload, (upload: FaultUploadProgress) => {
        if (this.current.saved?.notice.id !== saved.notice.id) return
        const next = { ...this.current.saved, upload }
        this.update({ saved: next })
        saveFault(next)
      })
    } catch (error) {
      this.setError(error instanceof Error && /^MCLOG_/.test(error.message) ? error.message : 'MCLOG_UPLOAD_FAILED')
    } finally { this.update({ uploading: false }) }
  }
}

export const faultAuditStore = new FaultAuditStore()
