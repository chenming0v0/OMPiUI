import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { StrictMode, useContext, type ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DirectoryProvider } from './DirectoryContext'
import { DirectoryContext } from './DirectoryContext.shared'

const native = vi.hoisted(() => ({ request: null as { directory: string; explicit: boolean } | null, invoke: vi.fn(), setDirectory: vi.fn(), current: undefined as string | undefined }))
vi.mock('../utils/tauri', () => ({ isTauri: () => true }))
vi.mock('@tauri-apps/api/core', () => ({ invoke: native.invoke }))
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn().mockResolvedValue(() => {}) }))
vi.mock('../hooks/useRouter', () => ({ useRouter: () => ({ directory: native.current, setDirectory: native.setDirectory }) }))
vi.mock('../store/layoutStore', () => ({ useLayoutStore: () => ({ sidebarExpanded: true }), layoutStore: { setSidebarExpanded: vi.fn() } }))

function wrapper({ children }: { children: ReactNode }) {
  return <StrictMode><DirectoryProvider>{children}</DirectoryProvider></StrictMode>
}

describe('native launch project precedence', () => {
  beforeEach(() => {
    localStorage.clear()
    native.current = undefined
    native.request = null
    native.invoke.mockReset().mockImplementation(async () => native.request)
    native.setDirectory.mockReset().mockReturnValue(true)
  })
  afterEach(cleanup)

  it('uses shortcut working directory on first launch despite StrictMode consuming the command', async () => {
    native.request = { directory: 'C:/project', explicit: false }
    renderHook(() => useContext(DirectoryContext), { wrapper })
    await waitFor(() => expect(native.setDirectory).toHaveBeenCalledWith('C:/project'))
  })

  it('preserves an existing saved project over an implicit shortcut directory', async () => {
    native.current = 'C:/saved'
    native.request = { directory: 'C:/shortcut', explicit: false }
    renderHook(() => useContext(DirectoryContext), { wrapper })
    await act(async () => { await Promise.resolve(); await Promise.resolve() })
    expect(native.setDirectory).not.toHaveBeenCalled()
  })

  it('honors explicit folder opening over a saved project', async () => {
    native.current = 'C:/saved'
    native.request = { directory: 'C:/explicit', explicit: true }
    renderHook(() => useContext(DirectoryContext), { wrapper })
    await waitFor(() => expect(native.setDirectory).toHaveBeenCalledWith('C:/explicit'))
  })

  it('does not let a delayed launch response replace a project selected by the user', async () => {
    const pending = Promise.withResolvers<{ directory: string; explicit: boolean }>()
    native.invoke.mockImplementation(() => pending.promise)
    const { rerender } = renderHook(() => useContext(DirectoryContext), { wrapper })
    native.current = 'C:/user-choice'
    rerender()
    await act(async () => { pending.resolve({ directory: 'C:/late', explicit: true }); await pending.promise })
    expect(native.setDirectory).not.toHaveBeenCalled()
  })
})
