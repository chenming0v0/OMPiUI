import { describe, expect, it } from 'vitest'
import type { FaultNotice } from '@ompiui/protocol'
import { FaultMonitor } from './monitor'

function fixture(busySessions: string[] = []) {
  let now = 100_000
  const faults: FaultNotice[] = []
  const monitor = new FaultMonitor('server-a', notice => faults.push(notice), () => {},
    { runId: 'run-a', checkedAt: now, busySessions }, () => now)
  return { monitor, faults, advance: (ms: number) => { now += ms }, time: () => new Date(now).toISOString() }
}

describe('fault detection', () => {
  it('does not report a short disconnect, normal idle restart or initial connection', () => {
    const { monitor, faults, advance } = fixture()
    monitor.socketClosed(1006)
    advance(3000)
    monitor.socketOpened()
    advance(11_000)
    monitor.tick()
    monitor.healthy({ runId: 'run-b', version: 'test', faults: [] })
    expect(faults).toEqual([])
  })

  it('reports persistent failure once and suppresses background/offline false alarms', () => {
    const { monitor, faults, advance } = fixture(['active-session'])
    monitor.failed()
    advance(46_000)
    monitor.tick(false)
    expect(faults).toEqual([])
    monitor.failed('HTTP_503')
    advance(46_000)
    monitor.tick()
    monitor.tick()
    expect(faults).toHaveLength(1)
    expect(faults[0]).toMatchObject({ kind: 'connection_lost', errorCode: 'HTTP_503', sessionId: 'active-session' })
  })

  it('repeatedly opening and closing a socket does not reset the outage grace period', () => {
    const { monitor, faults, advance } = fixture()
    for (let index = 0; index < 10; index++) {
      monitor.socketClosed(1006)
      advance(5000)
      monitor.socketOpened()
      monitor.healthy({ runId: 'run-a', version: 'test', faults: [] })
      monitor.tick()
    }
    expect(faults).toHaveLength(1)
    expect(faults[0]?.kind).toBe('connection_lost')
  })

  it('detects a restart with remembered work and ignores stale crash notices', () => {
    const { monitor, faults, advance, time } = fixture(['running-session'])
    monitor.failed()
    monitor.sessionState('running-session', { isIdle: true, isStreaming: false })
    advance(1000)
    monitor.healthy({
      runId: 'run-b', version: 'test',
      faults: [
        { id: 'stale', kind: 'runtime_crashed', time: new Date(1).toISOString() },
        { id: 'new-crash', kind: 'runtime_crashed', time: time(), sessionId: 'another-session' },
      ],
    })
    expect(faults.map(fault => fault.kind)).toEqual(['server_restarted', 'runtime_crashed'])
    expect(faults[0]?.sessionId).toBe('running-session')
  })

  it('keeps pre-reload work until the backend run is checked, then adopts its authoritative activity', () => {
    const { monitor, faults } = fixture(['was-running'])
    monitor.sessionState('was-running', { isIdle: true, isStreaming: false })
    monitor.healthy({ runId: 'run-b', version: 'test', faults: [], activeSessionIds: [] })
    expect(faults).toHaveLength(1)
    monitor.healthy({ runId: 'run-c', version: 'test', faults: [], activeSessionIds: [] })
    expect(faults, 'the next idle restart is not another interrupted task').toHaveLength(1)
  })

  it('does not report a disconnected subscription after the user leaves that view', () => {
    const { monitor, faults, advance } = fixture()
    monitor.socketClosed(1006)
    monitor.socketUnused()
    advance(60_000)
    monitor.tick()
    expect(faults).toEqual([])
  })
})
