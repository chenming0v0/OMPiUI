import { beforeEach, describe, expect, it, vi } from 'vitest'
import { FaultAuditStore } from './store'
import type { FaultNotice } from '@ompiui/protocol'
import { desktopDiagnosticsStore } from '../../store/desktopDiagnosticsStore'
import { trafficAuditStore } from '../trafficAudit/store'

const persistence = vi.hoisted(() => ({ save: vi.fn(), read: vi.fn() }))
vi.mock('./storage', () => ({
  readSavedFault: () => undefined,
  readFullSavedFault: () => Promise.resolve(undefined),
  saveFault: persistence.save,
}))

const fault: FaultNotice = { id: 'crash-1', kind: 'runtime_crashed', time: '2026-10-11T02:10:41.000Z', sessionId: 's1' }

describe('local fault reports', () => {
  beforeEach(() => vi.clearAllMocks())
  it('audits encoded third-party uploads without backend credentials or retained previews', async () => {
    trafficAuditStore.setEnabled(true)
    trafficAuditStore.setPreviews(false)
    trafficAuditStore.clear()
    try {
      const store = new FaultAuditStore(false)
      store.detect(fault, 'server-a')
      store.finishCollection(store.beginCollection()!, { content: '中文'.repeat(4096), complete: true, unavailable: [], files: 1 })
      let sentBytes = 0
      const responseBody = JSON.stringify({ success: true, id: 'audited', url: 'https://mclo.gs/audited' })
      await store.upload(async (input, init) => {
        expect(String(input)).toBe('https://api.mclo.gs/1/log')
        expect(init?.credentials).toBe('omit')
        expect(init?.redirect).toBe('error')
        expect(new Headers(init?.headers).has('authorization')).toBe(false)
        sentBytes += new TextEncoder().encode(String(init?.body)).byteLength
        return new Response(responseBody)
      })
      const [record] = trafficAuditStore.getSnapshot().records
      expect(record).toMatchObject({
        sentBytes, receivedBytes: new TextEncoder().encode(responseBody).byteLength,
        status: 'complete', requestPreview: undefined, responsePreview: undefined,
      })
      expect(trafficAuditStore.getSnapshot().records).toHaveLength(1)
    } finally { trafficAuditStore.setEnabled(false) }
  })
  it('keeps client metadata offline without secrets, chat bodies, raw errors or URLs', () => {
    const store = new FaultAuditStore(false)
    store.record('state', {
      sessionId: 's1', state: { isStreaming: true, body: 'PRIVATE_CHAT' },
      token: 'PRIVATE_TOKEN', url: 'https://secret.example', message: 'PRIVATE_MESSAGE',
    })
    store.record('failure', { errorCode: 'Bearer PRIVATE_AUTH' })
    expect(store.detect(fault, 'server-a')).toBe(true)
    const report = store.getSnapshot().saved!.report
    expect(report.complete).toBe(false)
    expect(report.content).toContain('isStreaming')
    expect(report.content).not.toContain('PRIVATE_')
    expect(report.content).not.toContain('secret.example')
    expect(persistence.save).toHaveBeenCalled()
    expect(store.detect(fault, 'server-a')).toBe(false)
    store.dismiss()
    expect(store.getSnapshot().saved?.open).toBe(false)
    store.reopen()
    expect(store.getSnapshot().saved?.open).toBe(true)
  })

  it('does not upload until explicitly requested and keeps the full report after upload failure', async () => {
    const fetch = vi.fn(async () => new Response('{}', { status: 503 }))
    const store = new FaultAuditStore(false)
    store.detect(fault, 'server-a')
    expect(fetch).not.toHaveBeenCalled()
    const id = store.beginCollection()!
    store.finishCollection(id, { content: 'retained backend logs', complete: true, files: 3, unavailable: [] })
    const before = store.getSnapshot().saved?.report.content
    await store.upload(fetch)
    expect(store.getSnapshot().error).toBe('MCLOG_UPLOAD_HTTP_503')
    expect(store.getSnapshot().saved?.report.content).toBe(before)
    expect(store.getSnapshot().uploading).toBe(false)
  })

  it('includes desktop launch timing offline without exporting native output or error text', () => {
    desktopDiagnosticsStore.receive({
      revision: 3, phase: 'failed', requestedAt: 1000, spawnedAt: null, completedAt: 2000,
      pid: null, error: 'PRIVATE_ERROR', output: ['PRIVATE_OUTPUT'],
      events: [{ time: 1000, phase: 'preparing' }, { time: 2000, phase: 'failed' }],
      reachable: false, workerReady: null, healthError: 'unreachable',
    })
    desktopDiagnosticsStore.finish('PRIVATE_COMMAND_ERROR')
    const store = new FaultAuditStore(false)
    store.detect(fault, 'local')
    const content = store.getSnapshot().saved!.report.content
    expect(content).toContain('Desktop startup (metadata only)')
    expect(content).toContain('"requestedAt":1000')
    expect(content).toContain('"commandFailed":true')
    expect(content).not.toContain('PRIVATE_')
    desktopDiagnosticsStore.finish()
  })

  it('records failed collection, can collect again after reconnecting and persists successful links', async () => {
    const store = new FaultAuditStore(false)
    store.detect(fault, 'server-a')
    store.finishCollection(store.beginCollection()!)
    expect(store.getSnapshot().saved?.report.unavailable).toContain('server_unreachable')
    store.finishCollection(store.beginCollection()!, { content: 'complete logs', complete: true, unavailable: [], files: 5 })
    await store.upload(async () => new Response(JSON.stringify({ success: true, id: 'testLink', url: 'https://mclo.gs/testLink' })))
    expect(store.getSnapshot().saved?.upload.indexUrl).toBe('https://mclo.gs/testLink')
    expect(store.beginCollection()).toBeUndefined()
  })

  it('never silently replaces an unresolved report with a repeated failure', () => {
    const store = new FaultAuditStore(false)
    store.detect(fault, 'server-a')
    const repeat = { ...fault, id: 'crash-2', time: '2026-10-11T02:10:42.000Z' }
    expect(store.detect(repeat, 'server-a')).toBe(false)
    expect(store.getSnapshot().saved?.notice.id).toBe('crash-1')
  })

  it('can replace an already uploaded incomplete report without losing its old link', async () => {
    const store = new FaultAuditStore(false)
    store.detect(fault, 'server-a')
    await store.upload(async () => new Response(JSON.stringify({ success: true, id: 'oldLink', url: 'https://mclo.gs/oldLink' })))
    expect(store.beginCollection()).toBeUndefined()
    const id = store.beginCollection(true)!
    store.finishCollection(id, { content: 'recovered server log', complete: true, unavailable: [], files: 4 })
    expect(store.getSnapshot().saved?.previousLinks).toEqual(['https://mclo.gs/oldLink'])
    expect(store.getSnapshot().saved?.upload.links).toEqual([])
    expect(store.getSnapshot().saved?.report.complete).toBe(true)
  })

  it('does not reopen an already uploaded crash when the same canonical id arrives by polling', async () => {
    const store = new FaultAuditStore(false)
    store.detect(fault, 'server-a')
    await store.upload(async () => new Response(JSON.stringify({ success: true, id: 'done', url: 'https://mclo.gs/done' })))
    store.dismiss()
    expect(store.detect(fault, 'server-a')).toBe(false)
    expect(store.getSnapshot().saved?.open).toBe(false)
  })

  it('can retain reports in an insecure HTTP browser without crypto.randomUUID', () => {
    vi.stubGlobal('crypto', { randomUUID: undefined })
    try {
      const store = new FaultAuditStore(false)
      expect(store.detect(fault, 'server-a')).toBe(true)
      expect(store.getSnapshot().saved?.reportRevision).toMatch(/^report-/)
      store.finishCollection(store.beginCollection()!, { content: 'logs', complete: true, unavailable: [], files: 1 })
      expect(store.getSnapshot().saved?.report.complete).toBe(true)
    } finally { vi.unstubAllGlobals() }
  })
})
