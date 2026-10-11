import { afterEach, describe, expect, it, vi } from 'vitest'
import { scanPairingQr } from './qrScanner'

afterEach(() => {
  delete window.__ompiui_qr_scanner
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('scanPairingQr', () => {
  it('returns decoded text only for the current request and removes its listener', async () => {
    let requestId = ''
    window.__ompiui_qr_scanner = { scan: vi.fn(id => { requestId = id }) }
    const remove = vi.spyOn(window, 'removeEventListener')
    const result = scanPairingQr('Scan pairing QR')
    window.dispatchEvent(new CustomEvent('ompiui-qr-result', { detail: { id: 'other', contents: 'ignored' } }))
    window.dispatchEvent(new CustomEvent('ompiui-qr-result', {
      detail: { id: requestId, contents: 'http://remote.test/?pair=once.secret' },
    }))
    expect(await result).toBe('http://remote.test/?pair=once.secret')
    expect(remove).toHaveBeenCalledWith('ompiui-qr-result', expect.any(Function))
  })

  it('treats cancellation as an empty result', async () => {
    window.__ompiui_qr_scanner = {
      scan: id => { window.dispatchEvent(new CustomEvent('ompiui-qr-result', { detail: { id } })) },
    }
    expect(await scanPairingQr('Scan')).toBeNull()
  })

  it('reports denied permission and cleans up the listener', async () => {
    const remove = vi.spyOn(window, 'removeEventListener')
    window.__ompiui_qr_scanner = {
      scan: id => { window.dispatchEvent(new CustomEvent('ompiui-qr-result', { detail: { id, error: 'scanPermissionDenied' } })) },
    }
    await expect(scanPairingQr('Scan')).rejects.toThrow('scanPermissionDenied')
    expect(remove).toHaveBeenCalledWith('ompiui-qr-result', expect.any(Function))
  })

  it('cleans up if the native launch throws', async () => {
    const remove = vi.spyOn(window, 'removeEventListener')
    window.__ompiui_qr_scanner = { scan: () => { throw new Error('scanFailed') } }
    await expect(scanPairingQr('Scan')).rejects.toThrow('scanFailed')
    expect(remove).toHaveBeenCalledWith('ompiui-qr-result', expect.any(Function))
  })

  it('reports an old build without a scanner bridge', async () => {
    vi.useFakeTimers()
    const result = expect(scanPairingQr('Scan')).rejects.toThrow('scanUnavailable')
    await vi.advanceTimersByTimeAsync(3_000)
    await result
  })
})
