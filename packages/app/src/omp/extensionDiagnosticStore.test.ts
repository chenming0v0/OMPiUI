import { beforeEach, describe, expect, it, vi } from 'vitest'
import { extensionDiagnosticStore } from './extensionDiagnosticStore'

const payload = (error: string, runtimeId = 'runtime-a') => ({
  workerGeneration: 'worker-a', runtimeId,
  frame: { type: 'extension_error', extensionPath: '<timer>', event: 'timeout_callback', error },
})

describe('extension host diagnostics', () => {
  beforeEach(() => extensionDiagnosticStore.reset())

  it('retains complete errors from distinct hosts without claiming a session identity', () => {
    const raw = 'original error\nlast line\n'
    extensionDiagnosticStore.addNativeEvent(payload(raw))
    extensionDiagnosticStore.addNativeEvent(payload('other host', 'runtime-b'))
    expect(extensionDiagnosticStore.getSnapshot().map(entry => entry.runtimeId)).toEqual(['runtime-b', 'runtime-a'])
    const entry = extensionDiagnosticStore.getSnapshot()[1]
    expect(entry).toMatchObject({ message: raw, source: '<timer>', originalType: 'extension_error', context: 'event: timeout_callback' })
    expect(entry).not.toHaveProperty('sessionId')
  })

  it('bounds retained entries without truncating the last retained error', () => {
    for (let i = 0; i < 101; i++) extensionDiagnosticStore.addNativeEvent(payload(`error ${i}\nlast line`))
    expect(extensionDiagnosticStore.getSnapshot()).toHaveLength(100)
    expect(extensionDiagnosticStore.getSnapshot().at(-1)?.message).toBe('error 1\nlast line')
  })

  it('still records distinct entries on non-secure HTTP hosts without randomUUID', () => {
    vi.stubGlobal('crypto', {})
    try {
      const first = extensionDiagnosticStore.addNativeEvent(payload('first'))
      const second = extensionDiagnosticStore.addNativeEvent(payload('second'))
      expect(first?.id).toBeTruthy()
      expect(first?.id).not.toBe(second?.id)
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('rejects malformed events and notifies subscribers when cleared', () => {
    expect(extensionDiagnosticStore.addNativeEvent({ frame: { error: 'unidentified host' } })).toBeNull()
    let updates = 0
    const off = extensionDiagnosticStore.subscribe(() => { updates++ })
    extensionDiagnosticStore.addNativeEvent(payload('retained'))
    extensionDiagnosticStore.reset()
    expect(updates).toBe(2)
    expect(extensionDiagnosticStore.getSnapshot()).toEqual([])
    off()
  })
})
