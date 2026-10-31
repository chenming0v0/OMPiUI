import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { openTailscaleLogin } from './tailscaleLogin'

const mocks = vi.hoisted(() => ({
  tauri: vi.fn(), android: vi.fn(), nativeOpen: vi.fn(), desktopOpen: vi.fn(),
}))
vi.mock('./tauri', () => ({ isTauri: mocks.tauri }))
vi.mock('./androidTailscale', () => ({
  isAndroidTailscalePlatform: mocks.android, openAndroidTailscaleLogin: mocks.nativeOpen,
}))
vi.mock('@tauri-apps/plugin-opener', () => ({ openUrl: mocks.desktopOpen }))

beforeEach(() => {
  vi.resetAllMocks()
  mocks.tauri.mockReturnValue(true)
  mocks.android.mockReturnValue(true)
  mocks.nativeOpen.mockResolvedValue(undefined)
  mocks.desktopOpen.mockResolvedValue(undefined)
})
afterEach(() => vi.restoreAllMocks())

describe('Tailscale authorization browser', () => {
  const url = 'https://login.tailscale.com/a/device'
  it('uses the native Android browser request without the Tauri opener', async () => {
    await openTailscaleLogin(url)
    expect(mocks.nativeOpen).toHaveBeenCalledWith(url)
    expect(mocks.desktopOpen).not.toHaveBeenCalled()
  })
  it('returns browser launch failures to the settings panel', async () => {
    mocks.nativeOpen.mockRejectedValue(new Error('No browser is available'))
    await expect(openTailscaleLogin(url)).rejects.toThrow('No browser is available')
    expect(mocks.desktopOpen).not.toHaveBeenCalled()
  })
  it('keeps desktop authorization using the Tauri opener', async () => {
    mocks.android.mockReturnValue(false)
    await openTailscaleLogin(url)
    expect(mocks.desktopOpen).toHaveBeenCalledWith(url)
    expect(mocks.nativeOpen).not.toHaveBeenCalled()
  })
  it('keeps web authorization opening a browser tab', async () => {
    mocks.android.mockReturnValue(false)
    mocks.tauri.mockReturnValue(false)
    const open = vi.spyOn(window, 'open').mockReturnValue(null)
    await openTailscaleLogin(url)
    expect(open).toHaveBeenCalledWith(url, '_blank', 'noopener,noreferrer')
  })
  it.each(['javascript:alert(1)', 'http://login.tailscale.com/a/device', 'https://user:pass@login.tailscale.com/a/device', 'not a url'])(
    'rejects unsafe authorization URLs: %s', async input => {
      await expect(openTailscaleLogin(input)).rejects.toThrow('Invalid Tailscale authorization URL')
      expect(mocks.nativeOpen).not.toHaveBeenCalled()
      expect(mocks.desktopOpen).not.toHaveBeenCalled()
    },
  )
  it('allows self-hosted control server authorization links (Headscale)', async () => {
    const url = 'https://headscale.example.com/a/device'
    await openTailscaleLogin(url)
    expect(mocks.nativeOpen).toHaveBeenCalledWith(url)
    expect(mocks.desktopOpen).not.toHaveBeenCalled()
  })
})
