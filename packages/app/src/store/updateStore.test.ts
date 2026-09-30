import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RELEASES_API_URL, UpdateStore, compareVersions, hasUpdateAvailable, shouldShowUpdateToast } from './updateStore'

describe('updateStore helpers', () => {
  it('compares versions with optional v prefix', () => {
    expect(compareVersions('v0.5.2', '0.5.1')).toBeGreaterThan(0)
    expect(compareVersions('0.5.1', 'v0.5.1')).toBe(0)
    expect(compareVersions('0.5', '0.5.1')).toBeLessThan(0)
  })

  it('detects whether an update toast should be shown', () => {
    const baseState = {
      currentVersion: '0.5.1',
      latestRelease: {
        version: '0.5.2',
        tagName: 'v0.5.2',
        url: 'https://example.com',
        publishedAt: null,
        name: null,
      },
      lastCheckedAt: Date.now(),
      dismissedVersion: null,
      hiddenToastVersion: null,
      checking: false,
      error: null,
    }

    expect(hasUpdateAvailable(baseState)).toBe(true)
    expect(shouldShowUpdateToast(baseState)).toBe(true)
    expect(shouldShowUpdateToast({ ...baseState, hiddenToastVersion: '0.5.2' })).toBe(false)
    expect(shouldShowUpdateToast({ ...baseState, dismissedVersion: '0.5.2' })).toBe(false)
  })
})

describe('UpdateStore', () => {
  beforeEach(() => {
    localStorage.clear()
    vi.restoreAllMocks()
  })

  afterEach(() => {
    localStorage.clear()
  })

  it('loads the latest release and persists dismissal', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          tag_name: 'v0.5.2',
          html_url: 'https://github.com/chenming0v0/OMPiUI/releases/tag/v0.5.2',
          published_at: '2026-04-15T00:00:00Z',
          name: 'OMPiUI v0.5.2',
        }),
      }),
    )

    const store = new UpdateStore('0.5.1')
    await store.checkForUpdates({ force: true })

    expect(store.getSnapshot().latestRelease?.version).toBe('0.5.2')
    expect(fetch).toHaveBeenCalledWith(RELEASES_API_URL, {
      headers: { Accept: 'application/vnd.github+json' },
    })
    expect(hasUpdateAvailable(store.getSnapshot())).toBe(true)

    store.dismissCurrentVersion()

    expect(store.getSnapshot().dismissedVersion).toBe('0.5.2')
    expect(shouldShowUpdateToast(store.getSnapshot())).toBe(false)
    expect(localStorage.getItem('ompiui:update-check')).toContain('0.5.2')
  })

  it('ignores a cached OMPiUI release', () => {
    localStorage.setItem(
      'piui:update-check',
      JSON.stringify({
        latestRelease: {
          version: '0.6.21',
          tagName: 'v0.6.21',
          url: 'https://github.com/lehhair/OMPiUI/releases/tag/v0.6.21',
          publishedAt: '2026-08-23T13:29:50Z',
          name: 'v0.6.21',
        },
        lastCheckedAt: 1,
        dismissedVersion: null,
      }),
    )

    const store = new UpdateStore('0.1.0')

    expect(store.getSnapshot().latestRelease).toBeNull()
    expect(hasUpdateAvailable(store.getSnapshot())).toBe(false)
    expect(localStorage.getItem('piui:update-check')).toBeNull()
  })

  it('drops a persisted release from another repository', () => {
    localStorage.setItem(
      'ompiui:update-check',
      JSON.stringify({
        latestRelease: {
          version: '0.6.21',
          tagName: 'v0.6.21',
          url: 'https://github.com/lehhair/OMPiUI/releases/tag/v0.6.21',
          publishedAt: '2026-08-23T13:29:50Z',
          name: null,
        },
        lastCheckedAt: 1,
        dismissedVersion: null,
      }),
    )

    const store = new UpdateStore('0.1.0')

    expect(store.getSnapshot().latestRelease).toBeNull()
    expect(hasUpdateAvailable(store.getSnapshot())).toBe(false)
  })

  it('clears the cached release when OMPiUI has not published one', async () => {
    localStorage.setItem(
      'ompiui:update-check',
      JSON.stringify({
        latestRelease: {
          version: '0.2.0',
          tagName: 'v0.2.0',
          url: 'https://github.com/chenming0v0/OMPiUI/releases/tag/v0.2.0',
          publishedAt: '2026-09-01T00:00:00Z',
          name: 'v0.2.0',
        },
        lastCheckedAt: 1,
        dismissedVersion: null,
      }),
    )
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 404,
        json: async () => ({}),
      }),
    )

    const store = new UpdateStore('0.1.0')
    expect(hasUpdateAvailable(store.getSnapshot())).toBe(true)

    await store.checkForUpdates({ force: true })

    expect(store.getSnapshot().latestRelease).toBeNull()
    expect(store.getSnapshot().error).toBeNull()
    expect(hasUpdateAvailable(store.getSnapshot())).toBe(false)
    expect(fetch).toHaveBeenCalledWith(RELEASES_API_URL, {
      headers: { Accept: 'application/vnd.github+json' },
    })
  })
})
