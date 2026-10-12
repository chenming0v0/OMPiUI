import type { PiBranchPage } from './domain'

const sizes = new WeakMap<object, number>()
const encoder = new TextEncoder()

/** 历史窗口只限制浏览器缓存；向前阅读保留较早一侧，实时视图保留最新一侧。 */
export function windowBranch(page: PiBranchPage, older = false): PiBranchPage {
  let bytes = 0
  let count = 0
  const ordered = older ? page.items : [...page.items].reverse()
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
  const items = older ? page.items.slice(0, count) : page.items.slice(-count)
  const ids = new Set(items.map(entry => entry.id))
  return {
    ...page,
    items,
    hasMore: older ? page.hasMore : true,
    client: {
      ...page.client,
      historyWindowed: older || page.client?.historyWindowed,
      stableEntryIds: page.client?.stableEntryIds
        ? Object.fromEntries(Object.entries(page.client.stableEntryIds).filter(([id]) => ids.has(id)))
        : undefined,
    },
  }
}
