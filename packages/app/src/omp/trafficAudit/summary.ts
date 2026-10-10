import { emptyTrafficTotals, type TrafficRecord, type TrafficSnapshot, type TrafficTotals } from './store'

export function formatTrafficBytes(bytes: number | null): string {
  if (bytes === null) return '?'
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`
  return `${(bytes / (1024 * 1024)).toFixed(2)} MiB`
}

export function trafficTotals(snapshot: TrafficSnapshot, server?: string): TrafficTotals {
  if (server) return snapshot.totals[server] ?? emptyTrafficTotals()
  const total = emptyTrafficTotals()
  for (const value of Object.values(snapshot.totals)) {
    for (const key of Object.keys(total) as (keyof TrafficTotals)[]) total[key] += value[key]
  }
  return total
}

export function trafficRanking(records: readonly TrafficRecord[]) {
  const groups = new Map<string, { label: string; count: number; bytes: number }>()
  for (const record of records) {
    if (record.direction === 'connection') continue
    const path = record.path.replace(/(\/sessions\/|\/terminals\/|\/commands\/|\/invite\/)[^/]+/g, '$1:id')
    const label = `${record.protocol.toUpperCase()} ${record.operation} ${path}`
    const group = groups.get(label) ?? { label, count: 0, bytes: 0 }
    group.count++
    group.bytes += (record.sentBytes ?? 0) + (record.receivedBytes ?? 0)
    groups.set(label, group)
  }
  return [...groups.values()].sort((a, b) => b.bytes - a.bytes).slice(0, 5)
}
