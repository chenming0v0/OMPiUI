import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { StrictMode, useContext, type ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DirectoryProvider } from './DirectoryContext'
import { DirectoryContext, type OpenDirectoryRequest } from './DirectoryContext.shared'

const native = vi.hoisted(() => ({ setDirectory: vi.fn(), current: undefined as string | undefined }))
vi.mock('../utils/tauri', () => ({ isTauri: () => true }))
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn().mockResolvedValue(null) }))
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn().mockResolvedValue(() => {}) }))
vi.mock('../hooks/useRouter', () => ({ useRouter: () => ({ directory: native.current, setDirectory: native.setDirectory }) }))
vi.mock('../store/layoutStore', () => ({ useLayoutStore: () => ({ sidebarExpanded: true }), layoutStore: { setSidebarExpanded: vi.fn() } }))
vi.mock('../store/serverStore', () => ({
  serverStore: {
    acceptsLocalDirectory: () => true,
    matchesSavedBackend: () => true,
    getActiveServerId: () => 'local',
    subscribe: () => () => {},
  },
}))

function wrapperFor(startupDirectory: OpenDirectoryRequest | null) {
  return function wrapper({ children }: { children: ReactNode }) {
    return <StrictMode><DirectoryProvider startupDirectory={startupDirectory}>{children}</DirectoryProvider></StrictMode>
  }
}

describe('native launch project precedence', () => {
  beforeEach(() => {
    localStorage.clear()
    native.current = undefined
    native.setDirectory.mockReset().mockReturnValue(true)
  })
  afterEach(cleanup)

  it('uses shortcut working directory on first launch despite StrictMode consuming the command', async () => {
    renderHook(() => useContext(DirectoryContext), { wrapper: wrapperFor({ directory: 'C:/project', explicit: false, source: 'local' }) })
    await waitFor(() => expect(native.setDirectory).toHaveBeenCalledWith('C:/project'))
  })

  it('preserves an existing saved project over an implicit shortcut directory', async () => {
    native.current = 'C:/saved'
    renderHook(() => useContext(DirectoryContext), { wrapper: wrapperFor({ directory: 'C:/shortcut', explicit: false, source: 'local' }) })
    await act(async () => { await Promise.resolve(); await Promise.resolve() })
    expect(native.setDirectory).not.toHaveBeenCalled()
  })

  it('honors explicit folder opening over a saved project', async () => {
    native.current = 'C:/saved'
    renderHook(() => useContext(DirectoryContext), { wrapper: wrapperFor({ directory: 'C:/explicit', explicit: true, source: 'local' }) })
    await waitFor(() => expect(native.setDirectory).toHaveBeenCalledWith('C:/explicit'))
  })

  it('does not let a delayed launch response replace a project selected by the user', async () => {
    let startup: OpenDirectoryRequest | null = null
    const { rerender } = renderHook(() => useContext(DirectoryContext), { wrapper: wrapperFor(startup) })
    native.current = 'C:/user-choice'
    rerender()
    startup = { directory: 'C:/late', explicit: true, source: 'local' }
    rerender()
    await act(async () => { await Promise.resolve() })
    expect(native.setDirectory).not.toHaveBeenCalled()
  })
})
