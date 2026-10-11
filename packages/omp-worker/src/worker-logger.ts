import { appendFileSync, mkdirSync } from "node:fs"
import { homedir } from "node:os"
import { join, resolve } from "node:path"
import { format } from "node:util"

/** Bun 的 console 不经过 stderr.write，需要单独记录并避免 Node 下重复写盘。 */
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
  const write = (chunk: string) => {
    try {
      const day = new Date().toISOString().slice(0, 10)
      if (currentDay !== day) {
        mkdirSync(directory, { recursive: true })
        currentDay = day
        file = join(directory, `ompiui-server-${day}.log`)
      }
      appendFileSync(file, `[${new Date().toISOString()}] ${chunk}`)
    } catch {
      /* 日志写入失败不能中止正在运行的任务。 */
    }
  }
  const stderrWrite = process.stderr.write
  process.stderr.write = ((chunk: unknown, ...rest: unknown[]) => {
    if (!inConsole && (typeof chunk === "string" || Buffer.isBuffer(chunk))) write(chunk.toString())
    return stderrWrite.call(process.stderr, chunk as never, ...(rest as never[]))
  }) as typeof process.stderr.write
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
