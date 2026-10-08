import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useSessionReplacement } from './useSessionReplacement'
import { useRouter } from './useRouter'
import { paneLayoutStore } from '../store/paneLayoutStore'

// Keep history updates synchronous while exercising the real router/store.
vi.mock('./useIsMobile', () => ({ useIsMobile: () => true }))

function useNavigation() {
  const router = useRouter()
  useSessionReplacement(router.sessionId, router.directory, router.navigateToSession)
  return router
}

function replace(detail: Record<string, unknown>) {
  act(() => { window.dispatchEvent(new CustomEvent('ompiui:session-replaced', { detail })) })
}

describe('App session replacement navigation', () => {
  beforeEach(() => {
    localStorage.clear()
    window.history.replaceState(null, '', '#/session/source?dir=%2Fworkspace')
    window.dispatchEvent(new HashChangeEvent('hashchange'))
    paneLayoutStore.reset()
    paneLayoutStore.setFocusedSession('source')
    paneLayoutStore.splitPane('pane-1', 'horizontal', 'source')
    paneLayoutStore.splitPane('pane-2', 'vertical', 'other')
    paneLayoutStore.focusPane('pane-1')
  })

  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
    paneLayoutStore.reset()
  })

  it('follows a canonical real replacement in every matching pane and the current route exactly once', () => {
    const remap = vi.spyOn(paneLayoutStore, 'remapSession')
    const { result } = renderHook(useNavigation)
    replace({ sourceSessionId: 'source', targetSessionId: 'target', targetCwd: '/fork' })

    expect(paneLayoutStore.allLeaves().map(pane => pane.sessionId)).toEqual(['target', 'target', 'other'])
    expect(paneLayoutStore.getFocusedPaneId()).toBe('pane-1')
    expect(result.current.sessionId).toBe('target')
    expect(result.current.directory).toBe('/fork')
    expect(window.location.hash).toBe('#/session/target?dir=%2Ffork')
    expect(remap).toHaveBeenCalledExactlyOnceWith('source', 'target')
  })

  it('retains the current directory when a replacement has no target cwd', () => {
    const { result } = renderHook(useNavigation)
    replace({ sourceSessionId: 'source', targetSessionId: 'target' })
    expect(result.current.sessionId).toBe('target')
    expect(result.current.directory).toBe('/workspace')
  })

  it('remaps a background pane without stealing the current route', () => {
    const { result } = renderHook(useNavigation)
    replace({ sourceSessionId: 'other', targetSessionId: 'background', targetCwd: '/other' })
    expect(paneLayoutStore.allLeaves().map(pane => pane.sessionId)).toEqual(['source', 'source', 'background'])
    expect(result.current.sessionId).toBe('source')
    expect(result.current.directory).toBe('/workspace')
  })

  it('does not follow runtime reuse even if a replacement event is delivered', () => {
    const remap = vi.spyOn(paneLayoutStore, 'remapSession')
    const { result } = renderHook(useNavigation)
    replace({ sourceSessionId: 'source', targetSessionId: 'target', targetCwd: '/reuse', reason: 'runtime-reuse' })
    act(() => { window.dispatchEvent(new CustomEvent('ompiui:sessions-changed')) })
    expect(remap).not.toHaveBeenCalled()
    expect(paneLayoutStore.allLeaves().map(pane => pane.sessionId)).toEqual(['source', 'source', 'other'])
    expect(result.current.sessionId).toBe('source')
    expect(window.location.hash).toBe('#/session/source?dir=%2Fworkspace')
  })

  it('uses the latest route after navigation rather than an old listener closure', () => {
    const { result } = renderHook(useNavigation)
    act(() => { result.current.navigateToSession('other', '/other') })
    replace({ sourceSessionId: 'source', targetSessionId: 'target' })
    expect(result.current.sessionId).toBe('other')
    replace({ sourceSessionId: 'other', targetSessionId: 'latest' })
    expect(result.current.sessionId).toBe('latest')
    expect(result.current.directory).toBe('/other')
  })

  it('ignores incomplete events and unsubscribes on unmount', () => {
    const remap = vi.spyOn(paneLayoutStore, 'remapSession')
    const { unmount } = renderHook(useNavigation)
    replace({ sourceSessionId: 'source' })
    replace({ targetSessionId: 'target' })
    act(() => { window.dispatchEvent(new CustomEvent('ompiui:session-replaced')) })
    unmount()
    replace({ sourceSessionId: 'source', targetSessionId: 'target' })
    expect(remap).not.toHaveBeenCalled()
    expect(paneLayoutStore.getFocusedSessionId()).toBe('source')
  })
})
