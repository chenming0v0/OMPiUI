import type { PiBranchPage } from './domain'

const sizes = new WeakMap<object, number>()
const encoder = new TextEncoder()

/** 最新页缓存有界；主动加载历史后保留完整连续区间，不能丢掉仍需下滚阅读的后缀。 */
export function windowBranch(page: PiBranchPage, older = false): PiBranchPage {
  if (older) {
    return page.client?.historyWindowed
      ? page
      : { ...page, client: { ...page.client, historyWindowed: true } }
  }
  let bytes = 0
  let count = 0
  const ordered = [...page.items].reverse()
  for (const entry of ordered) {
    let size = sizes.get(entry)
    if (size === undefined) {
      size = encoder.encode(JSON.stringify(entry)).byteLength
      sizes.set(entry, size)
    }
    if (count && (count >= 400 || bytes + size > 8 * 1024 * 1024)) break
    bytes += size
    count++
  }
  if (count === page.items.length) return page
  const items = page.items.slice(-count)
  const ids = new Set(items.map(entry => entry.id))
  return {
    ...page,
    items,
    hasMore: true,
    client: {
      ...page.client,
      stableEntryIds: page.client?.stableEntryIds
        ? Object.fromEntries(Object.entries(page.client.stableEntryIds).filter(([id]) => ids.has(id)))
        : undefined,
    },
  }
}
