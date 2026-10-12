import { afterEach, expect, it } from 'vitest'
import { piBranchStore } from './piBranchStore'
import type { PiBranchPage } from '../domain'

const page = (count: number) =>
  ({
    head: { sdkVersion: 'test', epoch: 'test', revision: 1, header: null, leafId: null, entryCount: count },
    items: Array.from({ length: count }, (_, index) => ({ id: String(index), type: 'message' })),
    hasMore: false,
  }) as PiBranchPage
afterEach(() => piBranchStore.clearAll())

it('evicts inactive histories without dropping another active pane', () => {
  piBranchStore.retain('active')
  piBranchStore.setData('active', page(500))
  for (let index = 0; index < 10; index++) piBranchStore.setData(`old-${index}`, page(10))
  expect(piBranchStore.getData('old-0')).toBeNull()
  expect(piBranchStore.getData('old-9')).not.toBeNull()
  expect(piBranchStore.getData('active')?.items.length).toBe(400)
  piBranchStore.release('active')
  expect(piBranchStore.getData('active')).toBeNull()
})
