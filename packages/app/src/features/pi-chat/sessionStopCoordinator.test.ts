import { describe, expect, it } from 'vitest'
import { SessionStopCoordinator } from './sessionStopCoordinator'

function deferred() {
  let resolve!: () => void
  let reject!: (error: Error) => void
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

describe('Stop command ordering', () => {
  it('shares repeated Stop and holds submission through overlapping Stop requests', async () => {
    const coordinator = new SessionStopCoordinator()
    const first = deferred()
    const second = deferred()
    const stop = coordinator.stop('server/session', () => first.promise)
    expect(coordinator.stop('server/session', () => { throw new Error('duplicate abort') })).toBe(stop)
    let accepted = false
    const nextStop = stop.then(() => coordinator.stop('server/session', () => second.promise))
    const submission = coordinator.submit('server/session', async () => { accepted = true })
    first.resolve()
    await stop
    await Promise.resolve()
    expect(accepted).toBe(false)
    second.resolve()
    await Promise.all([nextStop, submission])
    expect(accepted).toBe(true)
  })

  it('does not submit after failed Stop and allows an explicit Stop retry', async () => {
    const coordinator = new SessionStopCoordinator()
    const blocked = deferred()
    const stop = coordinator.stop('server/session', () => blocked.promise)
    let accepted = false
    const submission = coordinator.submit('server/session', async () => { accepted = true })
    const failure = new Error('native abort failed')
    blocked.reject(failure)
    await expect(stop).rejects.toBe(failure)
    await expect(submission).rejects.toBe(failure)
    expect(accepted).toBe(false)
    await coordinator.stop('server/session', async () => undefined)
    await coordinator.submit('server/session', async () => { accepted = true })
    expect(accepted).toBe(true)
  })

  it('does not block another server or session behind an older Stop', async () => {
    const coordinator = new SessionStopCoordinator()
    const blocked = deferred()
    const stop = coordinator.stop('old-server/session', () => blocked.promise)
    const accepted = await coordinator.submit('new-server/session', async () => 'accepted new session')
    expect(accepted).toBe('accepted new session')
    blocked.resolve()
    await stop
  })
})
