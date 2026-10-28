import { expect, it } from 'vitest'
import { windowBranch } from './branchWindow'
import type { PiBranchPage } from './domain'

it('keeps both ends of explicitly loaded history beyond the latest-page cache limit', () => {
  const page = {
    items: Array.from({ length: 500 }, (_, index) => ({ id: String(index), type: 'message' })),
    hasMore: false,
  } as PiBranchPage
  const historical = windowBranch(page, true)
  expect(historical.items).toEqual(page.items)
  expect(historical.hasMore).toBe(false)
  expect(historical.client?.historyWindowed).toBe(true)
})
