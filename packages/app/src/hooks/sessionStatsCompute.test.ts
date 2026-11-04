import { describe, expect, it } from 'vitest'
import { computeSessionStats, isSameSessionStats } from './sessionStatsCompute'

describe('computeSessionStats', () => {
  it('reuses equality when numeric fields are unchanged', () => {
    const a = computeSessionStats([], 200000)
    const b = computeSessionStats([], 200000)
    expect(isSameSessionStats(a, b)).toBe(true)
    expect(isSameSessionStats(a, { ...b, contextUsed: b.contextUsed + 1 })).toBe(false)
  })
})
