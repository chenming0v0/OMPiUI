import { createReadStream, readFileSync } from "node:fs"
import { lstat, readdir } from "node:fs/promises"
import { join } from "node:path"
import { homedir, platform, release, arch } from "node:os"
import { createInterface } from "node:readline"
import { redactDiagnosticText, type FaultReport, type FaultNotice, type FaultStatus } from "@ompiui/protocol"
import { dataRoot } from "../logger.ts"
import { diagnostics } from "./recorder.ts"

const DIAGNOSTIC_FILE = /^diagnostic-\d{4}-\d{2}-\d{2}_[a-f0-9-]+_\d+\.jsonl$/
const SYSTEM_LOG = /^(?:ompiui|piui)-server-\d{4}-\d{2}-\d{2}\.log$/
const SAFE_FIELDS = new Set([
  "schemaVersion", "time", "level", "event", "runId", "pid", "seq", "sessionId", "sessionIds",
  "sourceSessionId", "targetSessionId", "commandId", "requestId", "connectionId", "clientId",
  "workerPid", "command", "status", "previousStatus", "reason", "errorCode", "eventType",
  "toolName", "toolCallId", "durationMs", "timeoutMs", "misses", "code", "signal", "sequence",
  "epoch", "count", "port", "driver", "visibility", "navigation",
])
const STATE_FIELDS = new Set(["isStreaming", "isIdle", "isCompacting", "isBashRunning", "hasPendingAsyncWork", "readOnly", "pendingMessageCount", "goalStatus"])
// 系统日志行只输出“时间戳 + 固定生命周期标签”:冒号之后的错误正文、会话 ID、绝对路径、UNC/私有地址与控制台正文一律不进入报告。
const LOG_LINE = /^(?:\[(\d{4}-\d{2}-\d{2}T[\d:.]+Z)\]\s+)?\[(omp-worker|piui-worker|ompiui-server)\]\s+(.*)$/
const SAFE_LIFECYCLE_LABELS: ReadonlyArray<readonly [RegExp, string]> = [
  [/^heartbeat missing\b/i, "heartbeat missing"],
  [/^worker process exited unexpectedly\b/i, "worker process exited unexpectedly"],
  [/^worker process stopped\b/i, "worker process stopped"],
  [/^command [\w.]+ timed out\b/i, "command timed out"],
  [/^listening\b/i, "listening"],
  [/^events\s/i, "events endpoint"],
  [/^terminal stream\b/i, "terminal stream endpoint"],
  [/^driver=/i, "driver selected"],
  [/^runtime recovery failed for\b/i, "runtime recovery failed"],
  [/^idle reaper:/i, "idle reaper"],
  [/^graceful shutdown hook failed\b/i, "graceful shutdown hook failed"],
  [/^shutdown failed\b/i, "shutdown failed"],
  [/^unexpected exception; shutting down gracefully\b/i, "unexpected exception; shutting down gracefully"],
  [/^graceful shutdown\b/i, "graceful shutdown"],
  [/^shutting down\b/i, "shutting down"],
  [/^shutdown\b/i, "shutdown"],
  [/^worker cleanup\b/i, "worker cleanup"],
]
function safeSystemSummary(line: string): string | undefined {
  const match = LOG_LINE.exec(line)
  if (!match) return undefined
  const [, time, source, rest] = match
  const entry = SAFE_LIFECYCLE_LABELS.find(([pattern]) => pattern.test(rest ?? ""))
  if (!entry) return undefined
  return `${time ? `[${time}] ` : ""}[${source}] ${entry[1]}`
}
const MAX_REPORT_BYTES = 64 * 1024 * 1024
const VERSION = (() => {
  try { return String(JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")).version) }
  catch { return process.env.npm_package_version ?? "unknown" }
})()

function safeRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined
  const raw = value as Record<string, unknown>
  if (raw.schemaVersion !== 1 || typeof raw.time !== "string" || typeof raw.event !== "string") return undefined
  const result: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(raw)) {
    if (SAFE_FIELDS.has(key) && (value === null || ["string", "number", "boolean"].includes(typeof value))) result[key] = value
    if (key === "sessionIds" && Array.isArray(value)) result[key] = value.filter(item => typeof item === "string")
    if (key === "state" && value && typeof value === "object" && !Array.isArray(value)) {
      result.state = Object.fromEntries(Object.entries(value).filter(([field, value]) =>
        STATE_FIELDS.has(field) && ["string", "number", "boolean"].includes(typeof value)))
    }
  }
  return result
}

async function* readLines(file: string): AsyncGenerator<string> {
  const stream = createReadStream(file, { encoding: "utf8" })
  const lines = createInterface({ input: stream, crlfDelay: Infinity })
  stream.on("error", () => lines.close())
  try {
    for await (const line of lines) yield line
    if (stream.errored) throw stream.errored
  } finally {
    lines.close()
    stream.destroy()
  }
}

export class FaultReportService {
  private cached?: { time: number; faultId?: string; report: FaultReport; status: FaultStatus }
  private collecting?: Promise<{ report: FaultReport; status: FaultStatus }>

  constructor(private readonly root = dataRoot(), private readonly extraLogDirs = [
    ...(process.platform === "win32" && process.env.APPDATA ? [join(process.env.APPDATA, "com.ompiui.desktop", "logs")] : []),
    join(homedir(), ".ompiui", "logs"),
  ]) {}

  status(): FaultStatus {
    return { runId: diagnostics.runId, version: VERSION, faults: diagnostics.recentFaults() }
  }

  async collect(): Promise<{ report: FaultReport; status: FaultStatus }> {
    const faultId = diagnostics.recentFaults().at(-1)?.id
    if (this.cached && this.cached.faultId === faultId && Date.now() - this.cached.time < 10_000) return this.cached
    if (this.collecting) return this.collecting
    this.collecting = this.read().then(result => {
      this.cached = { time: Date.now(), faultId, ...result }
      return result
    }).finally(() => { this.collecting = undefined })
    return this.collecting
  }

  private async read(): Promise<{ report: FaultReport; status: FaultStatus }> {
    const sections: string[] = []
    const unavailable: string[] = []
    const faults: FaultNotice[] = []
    let files = 0
    let bytes = 0
    let filtered = 0
    const append = (line: string): boolean => {
      const safe = redactDiagnosticText(line)
      const size = Buffer.byteLength(safe) + 1
      if (bytes + size > MAX_REPORT_BYTES) return false
      sections.push(safe)
      bytes += size
      return true
    }
    const diagnosticsDir = join(this.root, "logs", "diagnostics")
    const logDirs = [...new Set([join(this.root, "logs"), ...this.extraLogDirs])]
    for (const [directory, pattern] of [[diagnosticsDir, DIAGNOSTIC_FILE], ...logDirs.map(dir => [dir, SYSTEM_LOG] as const)] as const) {
      let names: string[]
      try {
        names = (await readdir(directory)).filter(name => pattern.test(name)).sort()
      } catch {
        if (directory === diagnosticsDir) unavailable.push("diagnostic_directory_unavailable")
        continue
      }
      for (const name of names) {
        const file = join(directory, name)
        try {
          const stat = await lstat(file)
          if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_REPORT_BYTES) {
            unavailable.push(`${name}: unsafe_file_or_size_limit`)
            continue
          }
          if (!append(`\n--- ${name} ---`)) {
            unavailable.push(`${name}: report_size_limit`)
            continue
          }
          files++
          for await (const line of readLines(file)) {
            if (pattern === DIAGNOSTIC_FILE) {
              let record: Record<string, unknown> | undefined
              try { record = safeRecord(JSON.parse(line)) } catch { /* 尾部未刷完的行不当作有效记录。 */ }
              if (!record) {
                filtered++
                unavailable.push(`${name}: incomplete_records`)
                continue
              }
              if (record.event === "session.crashed" && typeof record.sessionId === "string" && typeof record.time === "string") {
                faults.push({
                  id: `${String(record.runId)}:${String(record.seq)}`,
                  kind: "runtime_crashed", time: record.time, sessionId: record.sessionId,
                  errorCode: typeof record.errorCode === "string" ? record.errorCode : undefined,
                })
              }
              if (!append(JSON.stringify(record))) { unavailable.push(`${name}: report_size_limit`); break }
            } else {
              const summary = safeSystemSummary(line)
              if (!summary) filtered++
              else if (!append(summary)) { unavailable.push(`${name}: report_size_limit`); break }
            }
          }
        } catch {
          unavailable.push(`${name}: read_failed`)
        }
      }
    }
    if (!sections.some(line => line.includes('"schemaVersion":1'))) unavailable.push("no_retained_diagnostic_records")
    const uniqueUnavailable = [...new Set(unavailable)]
    const header = [
      "OMPiUI fault report", `Generated: ${new Date().toISOString()}`,
      `Version: ${VERSION}; protocol: 1; OS: ${platform()} ${release()} ${arch()}; runtime: ${process.version}`,
      `Server run: ${diagnostics.runId}; pid: ${process.pid}`,
      `Files: ${files}; filtered unsafe or incomplete lines: ${filtered}`,
      `Unavailable: ${uniqueUnavailable.join(", ") || "none"}`,
      "Scope: all retained diagnostic metadata and fixed server/worker lifecycle labels.",
      "Excluded: session transcripts, tool output, tokens, cookies, private URLs, error messages and arbitrary console text. Server/worker log lines keep only fixed lifecycle labels.",
    ].join("\n")
    return {
      report: { content: `${header}\n${sections.join("\n")}`, complete: uniqueUnavailable.length === 0, unavailable: uniqueUnavailable, files },
      status: {
        runId: diagnostics.runId, version: VERSION,
        faults: faults.filter(fault => Date.parse(fault.time) >= Date.now() - 24 * 60 * 60 * 1000)
          .sort((a, b) => Date.parse(a.time) - Date.parse(b.time)).slice(-20),
      },
    }
  }
}
