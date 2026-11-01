import { act, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { usePiSessionTitle, usePiSessionDocumentTitle } from './index'
import { piSessionInfoStore, piSessionStateStore } from '../state/index.js'
import type { SessionInfo } from '../vendor/pi-coding-agent'

const sessionId = 'native-title'
const info = (name?: string): SessionInfo => ({
  id: sessionId, path: '/sessions/native-title.jsonl', cwd: '/workspace', name,
  firstMessage: '修复标题同步问题', allMessagesText: '修复标题同步问题', messageCount: 1,
  created: new Date('2026-11-01T00:00:00Z'), modified: new Date('2026-11-01T00:00:00Z'),
})

afterEach(() => {
  piSessionInfoStore.clear()
  piSessionStateStore.clearAll()
})

describe('usePiSessionTitle native naming', () => {
  it('shows the first message until native assigns a title, then follows auto and manual changes', () => {
    piSessionInfoStore.replaceAll([info()])
    const { result } = renderHook(() => usePiSessionTitle(sessionId))
    expect(result.current).toBe('修复标题同步问题')
    act(() => piSessionStateStore.setState(sessionId, { sessionName: '会话自动命名同步' }))
    expect(result.current).toBe('会话自动命名同步')
    act(() => piSessionStateStore.patchState(sessionId, { sessionName: '用户指定的标题' }))
    expect(result.current).toBe('用户指定的标题')
    act(() => {
      piSessionInfoStore.replaceAll([info('用户指定的标题')])
      piSessionStateStore.clear(sessionId)
    })
    expect(result.current).toBe('用户指定的标题')
  })

  it('updates the browser title only from the focused pane and restores the app name on unmount', () => {
    const focused = renderHook(({ title, active }) => usePiSessionDocumentTitle(title, active), {
      initialProps: { title: '原生标题' as string | null, active: true },
    })
    const other = renderHook(() => usePiSessionDocumentTitle('非聚焦会话', false))
    expect(document.title).toBe('原生标题 - OMPiUI')
    focused.rerender({ title: '更新后的原生标题', active: true })
    expect(document.title).toBe('更新后的原生标题 - OMPiUI')
    focused.rerender({ title: null, active: true })
    expect(document.title).toBe('OMPiUI')
    focused.rerender({ title: '用户标题', active: true })
    other.unmount()
    expect(document.title).toBe('用户标题 - OMPiUI')
    focused.unmount()
    expect(document.title).toBe('OMPiUI')
  })

  it('keeps titles isolated between panes and leaves empty sessions unnamed', () => {
    piSessionInfoStore.replaceAll([info('原生磁盘标题')])
    piSessionStateStore.setState('other-session', { sessionName: '其他会话' })
    const { result, rerender } = renderHook(({ id }) => usePiSessionTitle(id), { initialProps: { id: sessionId as string | null } })
    expect(result.current).toBe('原生磁盘标题')
    rerender({ id: 'other-session' })
    expect(result.current).toBe('其他会话')
    rerender({ id: 'empty-session' })
    expect(result.current).toBeNull()
    rerender({ id: null })
    expect(result.current).toBeNull()
  })
})
