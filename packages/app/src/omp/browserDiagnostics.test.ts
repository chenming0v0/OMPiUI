import { describe, expect, it } from 'vitest'
import { BrowserDiagnostics } from './browserDiagnostics'
import type { BrowserDiagnosticMessage } from '@ompiui/protocol'

describe('browser diagnostics', () => {
  it('records only changed state and sends a fresh snapshot after reconnect', () => {
    const records: BrowserDiagnosticMessage[] = []
    const recorder = new BrowserDiagnostics(message => records.push(message))
    const state = { isStreaming: true, pendingMessageCount: 1, text: 'PRIVATE', goal: { status: 'active', objective: 'PRIVATE' } }
    recorder.state('s1', state)
    recorder.state('s1', state)
    expect(records).toHaveLength(1)
    expect(records[0].state).toEqual({ isStreaming: true, pendingMessageCount: 1, goalStatus: 'active' })
    recorder.connected(1006)
    recorder.state('s1', state)
    expect(records.map(row => row.event)).toEqual(['state', 'connected', 'state'])
    expect(records[1].code).toBe(1006)
    expect(JSON.stringify(records)).not.toContain('PRIVATE')
  })

  it('diagnostic send failures do not interrupt application behavior', () => {
    const recorder = new BrowserDiagnostics(() => { throw new Error('closed socket') })
    expect(() => recorder.connected()).not.toThrow()
    expect(() => recorder.error('state_error', 's1', Object.assign(new Error('PRIVATE'), { code: 'WORKER_RESULT_UNKNOWN' }))).not.toThrow()
  })
})
