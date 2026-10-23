import { beforeEach, describe, expect, it } from 'vitest'
import { extensionUiStore } from './extensionUiStore'

describe('extensionUiStore', () => {
  beforeEach(() => extensionUiStore.reset())

  it('restores snapshots and settles pending dialogs', () => {
    extensionUiStore.replace({
      sessionId: 'session-1',
      workerGeneration: 'generation-1',
      state: {
        revision: 2,
        statuses: { mode: 'planning' },
        workingVisible: true,
        widgets: {},
        editorText: 'draft',
        toolsExpanded: false,
      },
      pending: [],
    })
    extensionUiStore.requestOpened({
      requestId: 'request-1',
      sessionId: 'session-1',
      workerGeneration: 'generation-1',
      kind: 'select',
      title: 'Mode',
      options: ['plan', 'build'],
      createdAt: '2026-01-01T00:00:00.000Z',
    })
    expect(extensionUiStore.getSnapshot().sessions['session-1']?.pending).toHaveLength(1)
    extensionUiStore.editorCommand('session-1', { kind: 'paste', text: ' more' })
    expect(extensionUiStore.getSnapshot().sessions['session-1']?.state.editorText).toBe('draft more')
    extensionUiStore.requestSettled('session-1', 'request-1')
    expect(extensionUiStore.getSnapshot().sessions['session-1']?.pending).toHaveLength(0)
  })

  it('does not reopen a settled dialog from a late snapshot but accepts the same native ID in a new runtime generation', () => {
    const request = { requestId: 'dialog', sessionId: 'session', workerGeneration: 'old', kind: 'input' as const, title: 'Question', createdAt: '2026-01-01T00:00:00.000Z' }
    extensionUiStore.requestOpened(request)
    const stale = structuredClone(extensionUiStore.getSnapshot().sessions.session!)
    extensionUiStore.requestSettled('session', 'dialog')
    extensionUiStore.replace(stale)
    expect(extensionUiStore.getSnapshot().sessions.session?.pending).toEqual([])
    expect(extensionUiStore.requestOpened(request)).toBe(false)
    extensionUiStore.requestOpened({ ...request, workerGeneration: 'new' })
    expect(extensionUiStore.getSnapshot().sessions.session?.pending).toEqual([{ ...request, workerGeneration: 'new' }])
  })

  it('does not retire a settlement while an older snapshot can still contain the request', () => {
    const request = { requestId: 'first', sessionId: 'session', kind: 'input' as const, title: 'First', createdAt: '2026-01-01T00:00:00.000Z' }
    extensionUiStore.requestOpened(request)
    const stale = structuredClone(extensionUiStore.getSnapshot().sessions.session!)
    extensionUiStore.requestSettled('session', 'first')
    for (let index = 0; index < 1025; index++) extensionUiStore.requestSettled('session', `later-${index}`)
    extensionUiStore.replace(stale)
    expect(extensionUiStore.getSnapshot().sessions.session?.pending).toEqual([])
    expect(extensionUiStore.requestOpened(request)).toBe(false)
  })

  it('keeps same-ID dialogs in another session or generation when an old answer completes', () => {
    const request = { requestId: 'dialog', sessionId: 'first', workerGeneration: 'old', kind: 'input' as const, title: 'Question', createdAt: '2026-01-01T00:00:00.000Z' }
    extensionUiStore.requestOpened(request)
    extensionUiStore.requestOpened({ ...request, sessionId: 'second' })
    extensionUiStore.requestOpened({ ...request, workerGeneration: 'new' })
    extensionUiStore.requestSettled('first', 'dialog', 'old')
    expect(extensionUiStore.getSnapshot().sessions.first?.pending).toEqual([{ ...request, workerGeneration: 'new' }])
    expect(extensionUiStore.getSnapshot().sessions.second?.pending).toEqual([{ ...request, sessionId: 'second' }])
  })

  it('an explicit empty editor update clears the draft and widget move/removal do not leave an old placement', () => {
    extensionUiStore.editorCommand('session', { kind: 'set', text: 'draft' })
    extensionUiStore.editorCommand('session', { kind: 'set', text: '' })
    expect(extensionUiStore.getSnapshot().sessions.session?.state.editorText).toBe('')
    extensionUiStore.statePatched('session', { kind: 'widget', key: 'status', lines: ['first'], placement: 'aboveEditor' })
    extensionUiStore.statePatched('session', { kind: 'widget', key: 'status', lines: ['moved'], placement: 'belowEditor' })
    expect(extensionUiStore.getSnapshot().sessions.session?.state.widgets).toEqual({ status: { lines: ['moved'], placement: 'belowEditor' } })
    extensionUiStore.statePatched('session', { kind: 'widget', key: 'status' })
    expect(extensionUiStore.getSnapshot().sessions.session?.state.widgets).toEqual({})
  })
})
