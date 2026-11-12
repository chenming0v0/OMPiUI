import { createContext, useCallback, useEffect, useMemo, useState } from 'react'

export const TimelineEntryNavigation = createContext<{
  jump: (entryId: string) => void
  pending: string | null
  missing: string | null
} | null>(null)

/** 沿只读历史分页查找目标，复用消息流的加载锁与虚拟滚动。 */
export function useTimelineEntryNavigation({ indexes, hasMore, loading, failed, loadMore, scroll }: {
  indexes: Map<string, number>
  hasMore: boolean
  loading: boolean
  failed: boolean
  loadMore: () => void
  scroll: (index: number) => void
}) {
  const [pending, setPending] = useState<string | null>(null)
  const [missing, setMissing] = useState<string | null>(null)
  const jump = useCallback((entryId: string) => { setMissing(null); setPending(entryId) }, [])
  useEffect(() => {
    if (!pending || loading) return
    const frame = requestAnimationFrame(() => {
      const index = indexes.get(pending)
      if (index !== undefined) {
        scroll(index)
        setPending(null)
      } else if (hasMore && !failed) loadMore()
      else { setMissing(pending); setPending(null) }
    })
    return () => cancelAnimationFrame(frame)
  }, [pending, indexes, hasMore, loading, failed, loadMore, scroll])
  return useMemo(() => ({ jump, pending, missing }), [jump, pending, missing])
}
