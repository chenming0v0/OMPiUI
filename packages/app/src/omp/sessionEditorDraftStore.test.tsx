import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { clearSessionEditorDraft, configureSessionEditorDraftSync, setSessionEditorDraft, syncSessionEditorDraft, useSessionEditorDraft } from './sessionEditorDraftStore'

describe('editor draft synchronization', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => {
    configureSessionEditorDraftSync(undefined)
    clearSessionEditorDraft('draft')
    vi.useRealTimers()
  })
  it('coalesces input without modifying the restoration marker or its attachments', async () => {
    const sync = vi.fn()
    configureSessionEditorDraftSync(sync)
    const { result } = renderHook(() => useSessionEditorDraft('draft'))
    act(() => setSessionEditorDraft('draft', 'restored', { sync: false, attachments: [] }))
    const marker = result.current
    for (let i = 0; i < 100; i++) syncSessionEditorDraft('draft', `edited-${i}`)
    expect(result.current).toBe(marker)
    await act(async () => { vi.advanceTimersByTime(500) })
    expect(sync).toHaveBeenCalledExactlyOnceWith('draft', 'edited-99')
  })
  it('unmounting one pane leaves another pane able to synchronize', () => {
    const first = vi.fn()
    const second = vi.fn()
    const removeFirst = configureSessionEditorDraftSync(first)
    const removeSecond = configureSessionEditorDraftSync(second)
    removeSecond()
    syncSessionEditorDraft('draft', 'still active')
    vi.advanceTimersByTime(500)
    expect(first).toHaveBeenCalledExactlyOnceWith('draft', 'still active')
    removeFirst()
    syncSessionEditorDraft('draft', 'closed')
    vi.advanceTimersByTime(500)
    expect(first).toHaveBeenCalledTimes(1)
  })
  it('clearing or replacing a draft read-only cancels older scheduled uploads', () => {
    const sync = vi.fn()
    configureSessionEditorDraftSync(sync)
    syncSessionEditorDraft('draft', 'old slash command')
    clearSessionEditorDraft('draft')
    vi.advanceTimersByTime(500)
    expect(sync).not.toHaveBeenCalled()
    syncSessionEditorDraft('draft', 'older')
    setSessionEditorDraft('draft', 'mirror', { sync: false })
    vi.advanceTimersByTime(500)
    expect(sync).not.toHaveBeenCalled()
  })
})
