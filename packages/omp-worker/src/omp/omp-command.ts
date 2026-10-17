import { spawnSync } from "node:child_process"
import { closeSync, existsSync, openSync, readFileSync, readSync } from "node:fs"
import path from "node:path"

export interface OmpCommand {
  command: string
  args: string[]
}

export function ompCommandEnvironment(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env = { ...process.env, ...overrides }
  // Windows 环境键不区分大小写，避免 Path 与 PATH 并存时 Bun 选中旧值。
  return process.platform === "win32"
    ? Object.fromEntries(Object.entries(env).map(([key, value]) => [key.toUpperCase(), value]))
    : env
}

function windowsExecutable(bin: string, env: NodeJS.ProcessEnv): string {
  if (path.isAbsolute(bin) || /[/\\]/.test(bin)) return path.resolve(bin)
  const probe = spawnSync("where.exe", [bin], { encoding: "utf8", windowsHide: true, env })
  const candidates = probe.status === 0 ? probe.stdout.split(/\r?\n/).map(line => line.trim()).filter(Boolean) : []
  const executable = candidates.find(candidate => /\.exe$/i.test(candidate))
    ?? candidates.find(candidate => /\.(?:cmd|bat)$/i.test(candidate))
  if (executable) return executable
  if (candidates.length) {
    throw new Error(`Cannot locate a Windows executable for ${bin}. Set OMPI_OMP_BIN to the OMP CLI, npm .cmd shim or native executable.`)
  }
  return bin
}

function scriptRuntime(script: string, directory: string, env: NodeJS.ProcessEnv): string {
  const descriptor = openSync(script, "r")
  const header = Buffer.alloc(256)
  let length: number
  try {
    length = readSync(descriptor, header, 0, header.length, 0)
  } finally {
    closeSync(descriptor)
  }
  const runtime = header.toString("utf8", 0, length).match(/^#![^\r\n]*\b(bun|node)(?:\.exe)?\b/i)?.[1]?.toLowerCase()
    ?? (/\.ts$/i.test(script) ? "bun" : "node")
  // 打包后端的 process.execPath 是应用本身，不能当作 Node/Bun 解释器。
  if (process.platform !== "win32") return runtime
  const local = path.join(directory, `${runtime}.exe`)
  const executable = existsSync(local) ? local : windowsExecutable(runtime, env)
  // npm 安装的 Bun 也有 .cmd 包装器，解释器必须继续解析到真实 exe。
  return /\.(?:cmd|bat)$/i.test(executable) ? windowsNpmShimTarget(executable, true) : executable
}

function windowsNpmShimTarget(bin: string, executableOnly = false): string {
  const directory = path.dirname(bin)
  const source = readFileSync(bin, "utf8")
  for (const match of source.matchAll(/"([^"\r\n]+\.(?:exe|[cm]?js|ts))"\s+%\*/gi)) {
    const target = match[1]!
      .replace(/%~dp0/gi, `${directory}${path.sep}`)
      .replace(/%dp0%/gi, directory)
    if (/%[^%]+%/.test(target)) continue
    if (executableOnly && !/\.exe$/i.test(target)) continue
    const script = path.resolve(directory, target)
    if (existsSync(script)) return script
  }
  if (executableOnly) {
    throw new Error(`Cannot locate a native runtime in npm shim: ${bin}. Install Bun/Node with a directly accessible .exe.`)
  }
  throw new Error(`Cannot locate the OMP CLI in npm shim: ${bin}. Set OMPI_OMP_BIN to the OMP CLI or native executable.`)
}

/** 标准 npm shim 只用于定位入口；JSON 参数不经过 cmd.exe 重解析。 */
export function resolveWindowsNpmShim(bin: string, env: NodeJS.ProcessEnv = process.env): OmpCommand {
  const target = windowsNpmShimTarget(bin)
  return /\.exe$/i.test(target)
    ? { command: target, args: [] }
    : { command: scriptRuntime(target, path.dirname(bin), env), args: [target] }
}

export function resolveOmpCommand(bin = "omp", env: NodeJS.ProcessEnv = process.env): OmpCommand {
  env = ompCommandEnvironment(env)
  bin = bin.trim() || "omp"
  if (process.platform === "win32") bin = windowsExecutable(bin, env)
  if (process.platform === "win32" && /\.(?:cmd|bat)$/i.test(bin)) return resolveWindowsNpmShim(bin, env)
  if (/\.(?:[cm]?js|ts)$/i.test(bin)) {
    const script = path.resolve(bin)
    return { command: scriptRuntime(script, path.dirname(script), env), args: [script] }
  }
  return { command: bin, args: [] }
}
