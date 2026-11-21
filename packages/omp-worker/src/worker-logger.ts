import { appendFileSync, lstatSync, mkdirSync, readdirSync, unlinkSync } from "node:fs"
import { homedir } from "node:os"
import { join, resolve } from "node:path"
import { format } from "node:util"

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
        /* server 也可能正在清理同一个目录。 */
      }
    }
  } catch {
    /* 清理失败不能影响日志写入。 */
  }
}

/** Bun 的 console 不经过 stderr.write，需要单独记录。 */
export function installWorkerFileLogging(): () => void {
  if (process.env.OMPIUI_FILE_LOG === "0") return () => {}
  const root = process.env.OMPIUI_DATA_DIR?.trim()
  const directory = join(root ? resolve(root)
    : process.platform === "win32" && process.env.APPDATA
      ? join(process.env.APPDATA, "com.ompiui.app")
      : join(homedir(), ".ompiui"), "logs")
  let currentDay = ""
  let file = ""
  let inConsole = false
  const rotate = (day: string) => {
    if (currentDay === day) return
    mkdirSync(directory, { recursive: true })
    const name = `ompiui-server-${day}.log`
    cleanupOldLogs(directory, name)
    file = join(directory, name)
    currentDay = day
  }
  try {
    rotate(new Date().toISOString().slice(0, 10))
  } catch {
    /* 目录暂时不可用时，实际写入再尝试。 */
  }
  const write = (chunk: string) => {
    try {
      const time = new Date().toISOString()
      rotate(time.slice(0, 10))
      appendFileSync(file, `[${time}] ${chunk}`)
    } catch {
      /* 日志写入失败不能中止正在运行的任务。 */
    }
  }
  const stderrWrite = process.stderr.write
  process.stderr.write = ((chunk: unknown, ...rest: unknown[]) => {
    if (!inConsole && (typeof chunk === "string" || Buffer.isBuffer(chunk))) write(chunk.toString())
    return stderrWrite.call(process.stderr, chunk as never, ...(rest as never[]))
  }) as typeof process.stderr.write
  if (!process.versions.bun) return () => { process.stderr.write = stderrWrite }

  const error = console.error
  const warn = console.warn
  for (const method of ["error", "warn"] as const) {
    const original = console[method]
    console[method] = (...args: unknown[]) => {
      write(`${format(...args)}\n`)
      inConsole = true
      try { original.apply(console, args) } finally { inConsole = false }
    }
  }
  return () => {
    process.stderr.write = stderrWrite
    console.error = error
    console.warn = warn
  }
}
