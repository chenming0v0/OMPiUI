import { expect, it } from 'vitest'
import { windowBranch } from './branchWindow'
import type { PiBranchPage } from './domain'

it('keeps earlier entries for historical reading and recent entries for the live view', () => {
  const page = {
    items: Array.from({ length: 500 }, (_, index) => ({ id: String(index), type: 'message' })),
    hasMore: true,
  } as PiBranchPage
  const historical = windowBranch(page, true)
  expect(historical.items.length).toBe(400)
  expect(historical.items[0].id).toBe('0')
  expect(historical.client?.historyWindowed).toBe(true)
  const live = windowBranch(page)
  expect(live.items[0].id).toBe('100')
  expect(live.items.at(-1)?.id).toBe('499')
})
