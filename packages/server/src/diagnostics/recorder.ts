import { randomUUID } from "node:crypto"
import { appendFileSync, mkdirSync, readdirSync, statSync, unlinkSync } from "node:fs"
import { join } from "node:path"
import { dataRoot } from "../logger.ts"
import type { DiagnosticRunState } from "@ompiui/protocol"

export type DiagnosticLevel = "debug" | "info" | "warn" | "error"
export type RunState = DiagnosticRunState
export type DiagnosticFields = {
  sessionId?: string
  sessionIds?: string[]
  sourceSessionId?: string
  targetSessionId?: string
  commandId?: string
  requestId?: string
  connectionId?: string
  clientId?: string
  workerPid?: number
  command?: string
  status?: string
  previousStatus?: string
  reason?: string
  errorCode?: string
  eventType?: string
  toolName?: string
  toolCallId?: string
  durationMs?: number
  timeoutMs?: number
  misses?: number
  code?: number
  signal?: string | null
  sequence?: number
  epoch?: string
  count?: number
  port?: number
  driver?: string
  visibility?: string
  navigation?: string
  state?: RunState
}

const LEVELS: Record<DiagnosticLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 }
const FILE_PATTERN = /^diagnostic-\d{4}-\d{2}-\d{2}_[a-f0-9-]+_\d+\.jsonl$/
const STRING_FIELDS = [
  "sessionId", "sourceSessionId", "targetSessionId", "commandId", "requestId",
  "connectionId", "clientId", "command", "status", "previousStatus", "reason",
  "errorCode", "eventType", "toolName", "toolCallId", "signal", "epoch",
  "driver", "visibility", "navigation",
] as const
const NUMBER_FIELDS = [
  "workerPid", "durationMs", "timeoutMs", "misses", "code", "sequence", "count", "port",
] as const

export function summarizeRunState(value: unknown): RunState {
  if (!value || typeof value !== "object") return {}
  const state = value as Record<string, unknown>
  const result: RunState = {}
  for (const key of ["isStreaming", "isIdle", "isCompacting", "isBashRunning", "hasPendingAsyncWork", "readOnly"] as const) {
    if (typeof state[key] === "boolean") result[key] = state[key]
  }
  if (typeof state.pendingMessageCount === "number" && Number.isFinite(state.pendingMessageCount)) result.pendingMessageCount = state.pendingMessageCount
  const goal = state.goal as { status?: unknown } | undefined
  if (goal && typeof goal.status === "string") result.goalStatus = safeText(goal.status)
  if (typeof state.goalStatus === "string") result.goalStatus = safeText(state.goalStatus)
  return result
}

export function diagnosticErrorCode(error: unknown): string {
  if (error && typeof error === "object") {
    const candidate = error as { code?: unknown; name?: unknown }
    if (typeof candidate.code === "string") return candidate.code
    if (typeof candidate.name === "string") return candidate.name
  }
  return "UNKNOWN"
}

function safeText(value: string): string {
  return value.slice(0, 256)
    .replace(/\bBearer\s+\S+/gi, "Bearer [REDACTED]")
    .replace(/((?:token|api[_-]?key|password|secret)=)[^&\s]+/gi, "$1[REDACTED]")
    .replace(/\bsk-[a-zA-Z0-9_-]+/g, "[REDACTED]")
}

// 只接受诊断元数据，绝不序列化命令参数、正文、URL、工具输出或错误堆栈。
function selectFields(fields: DiagnosticFields): Record<string, unknown> {
  const result: Record<string, unknown> = {}
  for (const key of STRING_FIELDS) {
    if (typeof fields[key] === "string") result[key] = safeText(fields[key])
  }
  for (const key of NUMBER_FIELDS) {
    if (typeof fields[key] === "number" && Number.isFinite(fields[key])) result[key] = fields[key]
  }
  if (Array.isArray(fields.sessionIds)) {
    result.sessionIds = fields.sessionIds.filter(id => typeof id === "string").slice(0, 256).map(safeText)
  }
  if (fields.state) result.state = summarizeRunState(fields.state)
  return result
}

export interface RecorderOptions {
  directory: string
  enabled?: boolean
  level?: DiagnosticLevel
  maxBytes?: number
  maxFiles?: number
  keepDays?: number
  now?: () => number
}

export class DiagnosticRecorder {
  readonly runId = randomUUID()
  private sequence = 0
  private part = 0
  private day = ""
  private file = ""
  private bytes = 0
  private warned = false

  constructor(private readonly options: RecorderOptions) {}

  record(event: string, fields: DiagnosticFields = {}, level: DiagnosticLevel = "info"): void {
    if (this.options.enabled === false || LEVELS[level] < LEVELS[this.options.level ?? "info"]) return
    try {
      const now = this.options.now?.() ?? Date.now()
      const time = new Date(now).toISOString()
      const line = JSON.stringify({
        schemaVersion: 1, time, level, event: safeText(event),
        runId: this.runId, pid: process.pid, seq: ++this.sequence, ...selectFields(fields),
      }) + "\n"
      const size = Buffer.byteLength(line)
      const day = time.slice(0, 10)
      if (!this.file || this.day !== day || this.bytes + size > (this.options.maxBytes ?? 5 * 1024 * 1024)) {
        mkdirSync(this.options.directory, { recursive: true })
        this.day = day
        this.file = join(this.options.directory, `diagnostic-${day}_${this.runId}_${String(++this.part).padStart(6, "0")}.jsonl`)
        this.bytes = 0
        // 低频生命周期事件同步落盘，进程被 watch 重启时不依赖缓冲区排空。
        appendFileSync(this.file, "", { mode: 0o600 })
        this.prune(now)
      }
      appendFileSync(this.file, line, { mode: 0o600 })
      this.bytes += size
    } catch {
      if (!this.warned) {
        this.warned = true
        console.warn("[ompiui-diagnostics] cannot write diagnostic log; application continues")
      }
    }
  }

  private prune(now: number): void {
    const cutoff = now - (this.options.keepDays ?? 7) * 86_400_000
    const files = readdirSync(this.options.directory)
      .filter(name => FILE_PATTERN.test(name))
      .map(name => {
        const path = join(this.options.directory, name)
        return { path, time: statSync(path).mtimeMs }
      })
      .sort((a, b) => b.time - a.time)
    let kept = 1
    for (const file of files) {
      if (file.path === this.file) continue
      if (file.time < cutoff || kept >= (this.options.maxFiles ?? 20)) unlinkSync(file.path)
      else kept++
    }
  }
}

function positiveNumber(value: string | undefined, fallback: number): number {
  const number = Number(value)
  return Number.isFinite(number) && number > 0 ? number : fallback
}

const configuredLevel = process.env.OMPIUI_DIAGNOSTIC_LEVEL
export const diagnostics = new DiagnosticRecorder({
  directory: join(dataRoot(), "logs", "diagnostics"),
  enabled: process.env.OMPIUI_DIAGNOSTICS !== "0",
  level: configuredLevel && Object.hasOwn(LEVELS, configuredLevel) ? configuredLevel as DiagnosticLevel : "info",
  maxBytes: positiveNumber(process.env.OMPIUI_DIAGNOSTIC_MAX_MB, 5) * 1024 * 1024,
  maxFiles: Math.floor(positiveNumber(process.env.OMPIUI_DIAGNOSTIC_MAX_FILES, 20)),
  keepDays: positiveNumber(process.env.OMPIUI_LOG_KEEP_DAYS, 7),
})
