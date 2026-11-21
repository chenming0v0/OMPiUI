/**
 * 服务端文件日志：把关键日志主动追加写入磁盘文件。
 *
 * 为什么必须主动写而不是捕获 console：桌面壳（Tauri）启动 omp-worker.exe
 * 时 stdout/stderr 是 piped 到内存环形缓冲（只有最近 24 行），进程退出后
 * 全部丢失。而 monkey-patch process.stdout.write 在 bun 下无效——bun 的
 * console.log 直接写底层 fd，不走 JS 层方法（实测 captured=0）。所以这里
 * 提供显式的 logToFile()，由关键日志点（worker 崩溃、启动、shutdown）直接
 * 调用；node 模式下仍附加 console 捕获以覆盖未被显式记录的零散输出。
 *
 * 文件位置：<ompiui 数据目录>/logs/ompiui-server-YYYY-MM-DD.log
 * 按天轮转，保留最近 N 天（OMPIUI_LOG_KEEP_DAYS，默认 7）。
 */

import { appendFileSync, lstatSync, mkdirSync, readdirSync, unlinkSync } from "node:fs"
import { homedir } from "node:os"
import { join, resolve } from "node:path"

let logDir: string | undefined
let logFile: string | undefined
let currentDay = ""
let enabled = false
let lastCaptured: string | undefined

export function dataRoot(): string {
  const env = process.env.OMPIUI_DATA_DIR?.trim()
  if (env) return resolve(env)
  if (process.platform === "win32" && process.env.APPDATA) return join(process.env.APPDATA, "com.ompiui.app")
  return join(homedir(), ".ompiui")
}

function cleanupOldLogs(directory: string, activeName: string): void {
  try {
    const keepDays = Number(process.env.OMPIUI_LOG_KEEP_DAYS ?? 7)
    const cutoff = Date.now() - (Number.isFinite(keepDays) && keepDays > 0 ? keepDays : 7) * 86_400_000
    for (const name of readdirSync(directory)) {
      if (name === activeName || !/^ompiui-server-\d{4}-\d{2}-\d{2}\.log$/.test(name)) continue
      const file = join(directory, name)
      try {
        const stat = lstatSync(file)
        if (stat.isFile() && stat.mtimeMs < cutoff) unlinkSync(file)
      } catch {
        /* worker 也可能正在清理同一个目录。 */
      }
    }
  } catch {
    /* 清理失败不能影响日志写入。 */
  }
}

function ensureLogFile(day: string): string | undefined {
  try {
    if (logFile && currentDay === day) return logFile
    const directory = logDir ?? join(dataRoot(), "logs")
    mkdirSync(directory, { recursive: true })
    const name = `ompiui-server-${day}.log`
    cleanupOldLogs(directory, name)
    logDir = directory
    logFile = join(directory, name)
    currentDay = day
    return logFile
  } catch {
    return undefined
  }
}

function writeLine(message: string): boolean {
  const time = new Date().toISOString()
  const file = ensureLogFile(time.slice(0, 10))
  if (!file) return false
  try {
    appendFileSync(file, `[${time}] ${message}\n`)
    return true
  } catch {
    return false
  }
}

export function logToFile(message: string): void {
  if (!enabled) return
  // Node 上多个调用点先写 console，再显式写同一条；仅合并本轮已成功捕获的同文记录。
  const duplicate = lastCaptured === message
  lastCaptured = undefined
  if (!duplicate) writeLine(message)
}

export function logInfo(message: string): void {
  logToFile(message)
}

export function logError(message: string): void {
  logToFile(message)
}

/** 启用文件日志（幂等）；首次启用和 UTC 换日时清理过期文件。 */
export function enableFileLogging(enable = process.env.OMPIUI_FILE_LOG !== "0"): () => void {
  if (enabled || !enable) return () => undefined
  enabled = true
  ensureLogFile(new Date().toISOString().slice(0, 10))
  const stdout = process.stdout
  const stderr = process.stderr
  const stdoutWrite = stdout.write
  const stderrWrite = stderr.write
  if (!process.versions.bun) {
    let clearScheduled = false
    const capture = (chunk: unknown) => {
      lastCaptured = undefined
      if (typeof chunk !== "string") return
      const message = chunk.replace(/\n$/, "")
      if (!writeLine(message)) return
      lastCaptured = message
      if (clearScheduled) return
      clearScheduled = true
      queueMicrotask(() => {
        clearScheduled = false
        if (stdout.write === captureStdout) lastCaptured = undefined
      })
    }
    const captureStdout = ((chunk: unknown, ...rest: unknown[]) => {
      capture(chunk)
      return stdoutWrite.call(stdout, chunk as never, ...(rest as never[]))
    }) as typeof stdout.write
    const captureStderr = ((chunk: unknown, ...rest: unknown[]) => {
      capture(chunk)
      return stderrWrite.call(stderr, chunk as never, ...(rest as never[]))
    }) as typeof stderr.write
    stdout.write = captureStdout
    stderr.write = captureStderr
  }
  let stopped = false
  return () => {
    if (stopped) return
    stopped = true
    enabled = false
    logDir = logFile = lastCaptured = undefined
    currentDay = ""
    if (!process.versions.bun) {
      stdout.write = stdoutWrite
      stderr.write = stderrWrite
    }
  }
}
