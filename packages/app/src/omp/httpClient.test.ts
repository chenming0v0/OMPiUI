import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getApiBase, piFetch } from './httpClient'
import { LOCAL_SERVER_ID, serverStore } from '../store/serverStore'

const mocks = vi.hoisted(() => ({ isTauri: false }))

const nativeFetchMock = vi.hoisted(() => vi.fn())

vi.mock('../utils/tauri', () => ({
  isTauri: () => mocks.isTauri,
  getHttpFetch: () => Promise.resolve(nativeFetchMock),
}))

const restoreOriginalLocalServer = () => {
  const original = serverStore.getStoredServers().find(server => server.id === LOCAL_SERVER_ID)
  if (original) serverStore.updateServer(LOCAL_SERVER_ID, { url: original.url, token: original.token })
}

describe('Tauri HTTP transport', () => {
  const original = serverStore.getStoredServers().find(server => server.id === LOCAL_SERVER_ID)

  beforeEach(() => {
    mocks.isTauri = true
  })

  afterEach(() => {
    vi.unstubAllEnvs()
    nativeFetchMock.mockReset()
    if (original) serverStore.updateServer(LOCAL_SERVER_ID, { url: original.url, token: original.token })
  })

  it('uses the selected desktop server instead of a build-time VITE_OMPIUI_API', () => {
    vi.stubEnv('VITE_OMPIUI_API', 'https://build-time.invalid')
    serverStore.updateServer(LOCAL_SERVER_ID, { url: 'https://settings.example.test' })

    expect(getApiBase()).toBe('https://settings.example.test')
  })

  it('uses plugin-http with the selected server Bearer token on Android', async () => {
    serverStore.updateServer(LOCAL_SERVER_ID, {
      url: 'http://192.168.1.10:8787',
      token: 'mobile-token',
    })
    nativeFetchMock.mockResolvedValueOnce(new Response('{}', { status: 200 }))

    await piFetch(`${getApiBase()}/api/v1/host/health`)

    expect(nativeFetchMock).toHaveBeenCalledWith(
      'http://192.168.1.10:8787/api/v1/host/health',
      expect.objectContaining({ headers: expect.any(Headers) }),
    )
    const headers = nativeFetchMock.mock.calls[0]?.[1]?.headers as Headers
    expect(headers.get('authorization')).toBe('Bearer mobile-token')
  })
})

describe('browser HTTP transport', () => {
  beforeEach(() => {
    mocks.isTauri = false
  })

  afterEach(() => {
    vi.unstubAllEnvs()
    restoreOriginalLocalServer()
    serverStore.setActiveServer(LOCAL_SERVER_ID)
  })

  it('keeps same-origin for the untouched default local server', () => {
    serverStore.updateServer(LOCAL_SERVER_ID, { url: 'http://127.0.0.1:8787' })

    expect(getApiBase()).toBe('')
  })

  it('directs an edited default local server at its saved address', () => {
    serverStore.updateServer(LOCAL_SERVER_ID, { url: 'http://192.168.1.5:8787' })

    expect(getApiBase()).toBe('http://192.168.1.5:8787')
  })

  it('follows a selected remote server instead of the build-time endpoint', () => {
    const remote = serverStore.addServer({ name: 'Remote', url: 'http://remote.test' })
    serverStore.setActiveServer(remote.id)

    expect(getApiBase()).toBe('http://remote.test')
  })
})
