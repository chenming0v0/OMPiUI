import { execFile } from "node:child_process"
import { promisify } from "node:util"

const execFileAsync = promisify(execFile)

export interface OmpProcess {
  pid: number
  name: string
  commandLine: string | null
}

/** 不把终端空闲误判成退出；RPC 子进程与版本探测不属于终端会话。 */
export function isOmpTerminalProcess(process: OmpProcess): boolean {
  const name = process.name.replace(/\.exe$/i, "").toLowerCase()
  const command = process.commandLine
  if (name === "omp" && (command === null || !command.trim())) return true
  const isOmp = name === "omp" ||
    (command !== null && /(?:oh-my-pi|pi-coding-agent|packages[\\/]coding-agent)[\\/].*(?:cli\.(?:[cm]?js|ts)|omp)(?:["'\s]|$)/i.test(command))
  if (!isOmp) return false
  if (command === null) return true
  if (/(?:^|\s)__omp_worker_[a-z_]+(?:\s|$)/.test(command)) return false
  return !/(?:^|\s)--mode(?:=|\s+)["']?rpc(?:-ui)?["']?(?:\s|$)/i.test(command) &&
    !/(?:^|\s)--version(?:\s|$)/.test(command)
}

export async function listOmpProcesses(): Promise<OmpProcess[]> {
  if (process.platform === "win32") {
    const command = [
      "$ErrorActionPreference='Stop'",
      "$items=@(Get-CimInstance Win32_Process -Filter \"Name='omp.exe' OR Name='bun.exe' OR Name='node.exe'\" | Select-Object @{n='pid';e={$_.ProcessId}},@{n='name';e={$_.Name}},@{n='commandLine';e={$_.CommandLine}})",
      "ConvertTo-Json -InputObject $items -Compress",
    ].join("\n")
    const { stdout } = await execFileAsync("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", command], {
      windowsHide: true, timeout: 10_000, maxBuffer: 4 * 1024 * 1024,
    })
    const items: unknown = JSON.parse(stdout.replace(/^\uFEFF/, "").trim())
    if (!Array.isArray(items)) throw new Error("Invalid process inventory")
    return items.map(item => {
      if (!item || typeof item.pid !== "number" || typeof item.name !== "string") throw new Error("Invalid process identity")
      return { pid: item.pid, name: item.name, commandLine: typeof item.commandLine === "string" ? item.commandLine : null }
    })
  }
  const { stdout } = await execFileAsync("ps", ["-axo", "pid=,comm=,args="], { timeout: 10_000, maxBuffer: 4 * 1024 * 1024 })
  return stdout.split("\n").filter(line => line.trim()).map(line => {
    const match = /^\s*(\d+)\s+(\S+)\s+(.*)$/.exec(line)
    if (!match) throw new Error("Invalid process identity")
    return { pid: Number(match[1]), name: match[2]!.split("/").at(-1)!, commandLine: match[3]! }
  })
}

export function assertTerminalInventory(items: OmpProcess[]): void {
  if (items.some(isOmpTerminalProcess)) {
    throw Object.assign(new Error("OMP terminal is still running. You can view its history, but must exit OMP in the terminal before continuing this session in OMPiUI."), { code: "SESSION_BUSY" })
  }
}

// 并发校验共用一次正在执行的探测，但不缓存过期的“终端已退出”结论。
let pending: Promise<void> | undefined

export function assertOmpTerminalStopped(): Promise<void> {
  pending ??= listOmpProcesses().then(assertTerminalInventory).catch(error => {
    if (error?.code === "SESSION_BUSY") throw error
    throw Object.assign(new Error("Cannot verify that the OMP terminal has exited. Session writes are blocked; history remains available."), { code: "SESSION_BUSY" })
  }).finally(() => { pending = undefined })
  return pending
}
