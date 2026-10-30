import { describe, expect, it } from 'vitest'
import { hasStoppableSessionActivity } from './sessionActivity'
import type { PiSessionRuntimeState } from '../../omp/domain'

const state = (patch: object) => ({ isStreaming: false, ...patch }) as PiSessionRuntimeState

describe('foreground stop affordance', () => {
  it('shows Send after the foreground stops even when native follow-ups remain queued', () => {
    expect(hasStoppableSessionActivity(state({ isIdle: false, isSettled: false, pendingMessageCount: 1 }), true)).toBe(false)
    expect(hasStoppableSessionActivity(state({ isStreaming: true, pendingMessageCount: 1 }), false)).toBe(true)
  })
  it('does not offer Stop for background-only work even while the sidebar remains active', () => {
    expect(hasStoppableSessionActivity(state({ hasPendingAsyncWork: true, isIdle: false, isSettled: false }), true)).toBe(false)
  })
  it.each(['isStreaming', 'isCompacting', 'isRetrying', 'isBashRunning'])('retains Stop for real foreground %s work alongside background jobs', field => {
    expect(hasStoppableSessionActivity(state({ [field]: true, hasPendingAsyncWork: true }), false)).toBe(true)
  })
  it('uses sidebar activity only when an authoritative runtime streaming flag is unavailable', () => {
    expect(hasStoppableSessionActivity(undefined, true)).toBe(true)
    expect(hasStoppableSessionActivity(undefined, false)).toBe(false)
    expect(hasStoppableSessionActivity(state({ isSettled: true }), true)).toBe(false)
  })
})
