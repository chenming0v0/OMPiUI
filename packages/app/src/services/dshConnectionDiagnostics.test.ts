import { afterEach, describe, expect, it, vi } from 'vitest'
import { exportDshDiagnostics, recordDshDiagnostic } from './dshConnectionDiagnostics'

afterEach(() => vi.unstubAllGlobals())

describe('DS Remote connection diagnostics', () => {
  it('records known close reasons but never arbitrary close text', () => {
    vi.stubGlobal('__APP_VERSION__', 'test')
    recordDshDiagnostic('connect.socket.closed', {
      attemptId: '00d3c03b-9ee0-430c-aef5-89f817f44b1c', closeCode: 4010, closeReason: 'AUTH_INVALID',
    })
    recordDshDiagnostic('connect.socket.closed', {
      attemptId: '00d3c03b-9ee0-430c-aef5-89f817f44b1c', closeCode: 4010, closeReason: 'Bearer secret-token',
    })

    const diagnostics = exportDshDiagnostics()
    expect(diagnostics).toContain('"closeReason":"AUTH_INVALID"')
    expect(diagnostics).not.toContain('secret-token')
  })
})
