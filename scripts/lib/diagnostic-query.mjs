import { readdirSync } from "node:fs"
import { createReadStream } from "node:fs"
import { createInterface } from "node:readline"
import { join } from "node:path"

export async function queryDiagnostics(directory, { session, since, level, event, limit = 200 } = {}) {
  const levels = { debug: 10, info: 20, warn: 30, error: 40 }
  const sinceMs = since ? Date.parse(since) : -Infinity
  if (Number.isNaN(sinceMs)) throw new Error("--since must be an ISO date/time")
  if (level && !Object.hasOwn(levels, level)) throw new Error("--level must be debug, info, warn or error")
  if (!Number.isInteger(limit) || limit < 1 || limit > 100_000) throw new Error("--limit must be between 1 and 100000")
  let files
  try {
    files = readdirSync(directory).filter(name => /^diagnostic-.*\.jsonl$/.test(name)).sort()
  } catch (error) {
    if (error.code === "ENOENT") return { records: [], malformed: 0 }
    throw error
  }
  let records = []
  let malformed = 0
  for (const file of files) {
    const stream = createReadStream(join(directory, file), { encoding: "utf8" })
    const lines = createInterface({ input: stream, crlfDelay: Infinity })
    // readline 不会转发文件流错误，必须让读盘失败显式结束查询。
    stream.on("error", () => lines.close())
    try {
      for await (const line of lines) {
        if (!line.trim()) continue
        let record
        try {
          record = JSON.parse(line)
          if (record.schemaVersion !== 1 || typeof record.event !== "string" ||
              typeof record.runId !== "string" || !Number.isFinite(record.seq) ||
              !Number.isFinite(Date.parse(record.time))) {
            malformed++
            continue
          }
        } catch {
          malformed++
          continue
        }
        const related = record.sessionId === session || record.sourceSessionId === session ||
          record.targetSessionId === session || record.sessionIds?.includes(session)
        const serverContext = record.event.startsWith("server.") || record.event.startsWith("worker.")
        if (session && !related && !(serverContext && !record.sessionId)) continue
        if (Date.parse(record.time) < sinceMs) continue
        if (level && (levels[record.level] ?? 0) < levels[level]) continue
        if (event && !record.event.includes(event)) continue
        records.push(record)
        // 保留按时间排序的最后 N 条，避免大日志查询占满内存。
        if (records.length >= limit * 2) records = newest(records, limit)
      }
      if (stream.errored) throw stream.errored
    } finally {
      lines.close()
      stream.destroy()
    }
  }
  return { records: newest(records, limit), malformed }
}

function newest(records, limit) {
  return records.sort((a, b) => Date.parse(a.time) - Date.parse(b.time) ||
    a.runId.localeCompare(b.runId) || a.seq - b.seq).slice(-limit)
}
