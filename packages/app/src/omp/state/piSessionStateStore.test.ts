import { afterEach, describe, expect, it } from 'vitest'
import type { ExtensionUiDialogRequest, JsonObject } from '@ompiui/protocol'
import { extensionUiStore } from '../extensionUiStore.js'
import { extensionTuiStore } from '../extensionTuiStore.js'
import { activeSessionStore } from '../../store/activeSessionStore.js'
import { piSessionStateStore } from './piSessionStateStore.js'

function dialogRequest(overrides: Partial<ExtensionUiDialogRequest> = {}): ExtensionUiDialogRequest {
  return {
    requestId: 'dialog-1',
    sessionId: 'session-1',
    workerGeneration: 'gen-1',
    kind: 'confirm',
    title: 'Allow?',
    message: 'Proceed?',
    createdAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  } as ExtensionUiDialogRequest
}

function stateWith(pending: unknown): JsonObject {
  return { sessionId: 'session-1', isStreaming: false, pendingExtensionUiRequests: pending } as unknown as JsonObject
}

describe('piSessionStateStore pending dialog recovery', () => {
  afterEach(() => {
    piSessionStateStore.clearAll()
    extensionUiStore.reset()
    extensionTuiStore.reset()
    activeSessionStore.reset()
  })

  it('restores pending dialogs from state.get after a refresh', () => {
    piSessionStateStore.setState('session-1', stateWith([dialogRequest()]))

    expect(extensionUiStore.getSnapshot().sessions['session-1']?.pending).toHaveLength(1)
    expect(extensionUiStore.getSnapshot().sessions['session-1']?.pending[0]?.requestId).toBe('dialog-1')
    const busy = activeSessionStore.getBusySessionsSnapshot()
    expect(busy.some(entry => entry.sessionId === 'session-1' && entry.pendingAction?.type === 'permission')).toBe(true)
  })

  it('does not restore for another session or when absent', () => {
    piSessionStateStore.setState('session-1', stateWith([dialogRequest()]))
    piSessionStateStore.setState('session-2', stateWith(undefined))

    expect(extensionUiStore.getSnapshot().sessions['session-1']?.pending).toHaveLength(1)
    expect(extensionUiStore.getSnapshot().sessions['session-2']?.pending ?? []).toHaveLength(0)
  })

  it('is idempotent across repeated state refreshes (live event + recovery overlap)', () => {
    const request = dialogRequest()
    // Live event already rendered the dialog; recovery must not duplicate it.
    extensionUiStore.requestOpened(request)
    activeSessionStore.addPendingRequest(request.requestId, 'session-1', 'permission', request.title)

    piSessionStateStore.setState('session-1', stateWith([request]))
    piSessionStateStore.setState('session-1', stateWith([request]))

    expect(extensionUiStore.getSnapshot().sessions['session-1']?.pending).toHaveLength(1)
    expect(activeSessionStore.getBusySessionsSnapshot().some(entry => entry.sessionId === 'session-1')).toBe(true)
  })

  it('skips malformed entries', () => {
    piSessionStateStore.setState('session-1', stateWith([{ requestId: 42 }, null, 'x']))

    expect(extensionUiStore.getSnapshot().sessions['session-1']?.pending ?? []).toHaveLength(0)
  })

  it('restores the extension UI state mirror (status/widget/editorText)', () => {
    piSessionStateStore.setState('session-1', {
      pendingExtensionUiRequests: [],
      extensionUiState: {
        patches: [
          { kind: 'status', key: 'mode', text: 'Planning' },
          { kind: 'widget', key: 'plan', lines: ['1. Inspect', '2. Fix'], placement: 'aboveEditor' },
        ],
        editorText: 'prefill',
        toolsExpanded: false,
      },
    } as unknown as JsonObject)

    const snapshot = extensionUiStore.getSnapshot().sessions['session-1']
    expect(snapshot?.state.statuses.mode).toBe('Planning')
    expect(snapshot?.state.widgets.plan?.lines).toEqual(['1. Inspect', '2. Fix'])
    expect(snapshot?.state.editorText).toBe('prefill')
  })

  it('restores the array mirror returned by the OMP worker without clearing current editor text', () => {
    extensionUiStore.editorCommand('session-1', { kind: 'set', text: 'draft' })
    piSessionStateStore.setState('session-1', {
      extensionUiState: [
        { kind: 'status', key: 'mode', text: 'Planning' },
        { kind: 'widget', key: 'plan', lines: ['Inspect'], placement: 'aboveEditor' },
        { kind: 'toolsExpanded', expanded: true },
      ],
    })
    const state = extensionUiStore.getSnapshot().sessions['session-1']?.state
    expect(state?.statuses.mode).toBe('Planning')
    expect(state?.widgets.plan?.lines).toEqual(['Inspect'])
    expect(state?.editorText).toBe('draft')
    expect(state?.toolsExpanded).toBe(true)
  })

  it('does not reopen a settled dialog from a delayed response or cached lifecycle state', () => {
    const request = dialogRequest()
    piSessionStateStore.setState('session-1', stateWith([request]))
    const version = piSessionStateStore.beginRequest('session-1')
    extensionUiStore.requestSettled('session-1', request.requestId)
    activeSessionStore.resolvePendingRequest(request.requestId)
    piSessionStateStore.setStateIfCurrent('session-1', stateWith([request]), version)
    piSessionStateStore.patchState('session-1', { isStreaming: false })
    expect(extensionUiStore.getSnapshot().sessions['session-1']?.pending).toEqual([])
    expect(activeSessionStore.getBusySessionsSnapshot().some(entry => entry.pendingAction)).toBe(false)
  })

  it('allows a new worker generation to reuse a request id after the old one settled', () => {
    const oldRequest = dialogRequest({ workerGeneration: 'old' })
    const newRequest = dialogRequest({ workerGeneration: 'new' })
    piSessionStateStore.setState('session-1', stateWith([oldRequest]))
    extensionUiStore.requestSettled('session-1', oldRequest.requestId)
    expect(extensionUiStore.requestOpened(newRequest)).toBe(true)
    expect(extensionUiStore.getSnapshot().sessions['session-1']?.pending[0]?.workerGeneration).toBe('new')
  })

  it('does not replay an old extension mirror when lifecycle state changes', () => {
    piSessionStateStore.setState('session-1', {
      extensionUiState: [{ kind: 'status', key: 'mode', text: 'Old' }],
    })
    extensionUiStore.statePatched('session-1', { kind: 'status', key: 'mode', text: 'New' })
    piSessionStateStore.patchState('session-1', { isStreaming: false })
    expect(extensionUiStore.getSnapshot().sessions['session-1']?.state.statuses.mode).toBe('New')
  })

  it('keeps pending dialogs when restoring the state mirror (live events first)', () => {
    extensionUiStore.requestOpened(dialogRequest())
    piSessionStateStore.setState('session-1', {
      pendingExtensionUiRequests: [],
      extensionUiState: { patches: [{ kind: 'status', key: 'mode', text: 'Planning' }], editorText: '', toolsExpanded: false },
    } as unknown as JsonObject)

    const snapshot = extensionUiStore.getSnapshot().sessions['session-1']
    expect(snapshot?.pending).toHaveLength(1)
    expect(snapshot?.state.statuses.mode).toBe('Planning')
  })

  it('restores offscreen extension TUI panels after a refresh', () => {
    const tuiStore = extensionTuiStore
    piSessionStateStore.setState('session-1', {
      extensionTuiPanels: [
        { key: 'plan', kind: 'widget', placement: 'aboveEditor', width: 64, height: 10 },
        { key: 'custom', kind: 'custom', width: 64, height: 10 },
      ],
    } as unknown as JsonObject)

    const panels = tuiStore.getSnapshot().sessions['session-1']?.panels ?? []
    expect(panels.map(panel => panel.key).sort()).toEqual(['custom', 'plan'])
    // 重复恢复（多次 state 落地）幂等
    piSessionStateStore.setState('session-1', {
      extensionTuiPanels: [{ key: 'plan', kind: 'widget', placement: 'aboveEditor', width: 64, height: 10 }],
    } as unknown as JsonObject)
    const after = tuiStore.getSnapshot().sessions['session-1']?.panels ?? []
    expect(after.map(panel => panel.key)).toEqual(['plan'])
  })
})

describe('piSessionStateStore request versions', () => {
  afterEach(() => piSessionStateStore.clearAll())

  it('does not restore state from a response belonging to a cleared session', () => {
    const version = piSessionStateStore.beginRequest('session-1')
    piSessionStateStore.clear('session-1')
    piSessionStateStore.beginRequest('session-1')
    expect(piSessionStateStore.setStateIfCurrent('session-1', { thinkingLevel: 'low' }, version)).toBe(false)
    expect(piSessionStateStore.getState('session-1')).toBeNull()
  })

  it('patches lifecycle state without replacing the session model and thinking level', () => {
    piSessionStateStore.setState('session-1', {
      model: { provider: 'custom', id: 'correct' }, thinkingLevel: 'xhigh', isStreaming: true,
    })
    piSessionStateStore.patchState('session-1', { isStreaming: false, isIdle: true })
    expect(piSessionStateStore.getState('session-1')).toEqual({
      model: { provider: 'custom', id: 'correct' }, thinkingLevel: 'xhigh', isStreaming: false, isIdle: true,
    })
  })
})
