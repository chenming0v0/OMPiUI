import { closeSync, existsSync, openSync, readFileSync, readSync } from "node:fs"
import path from "node:path"
import { installedOmpExecutable, resolveInstalledOmpRuntime } from "./omp-runtime.js"

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

/** Search only the supplied PATH; native bundles must work without where/which. */
export function locateExecutable(bin: string, env: NodeJS.ProcessEnv): string | undefined {
  if (path.isAbsolute(bin) || /[/\\]/.test(bin)) return existsSync(path.resolve(bin)) ? path.resolve(bin) : undefined
  const extensions = process.platform === "win32" && !path.extname(bin) ? [".exe", ".cmd", ".bat"] : [""]
  const directories = (env.PATH ?? env.Path ?? "").split(path.delimiter).filter(Boolean)
  for (const extension of extensions) {
    for (const directory of directories) {
      const executable = path.resolve(directory.replace(/^"|"$/g, ""), bin + extension)
      if (existsSync(executable)) return executable
    }
  }
  return undefined
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
  if (runtime === "bun" && (env.OMPI_BUN_BIN?.trim() || resolveInstalledOmpRuntime(env))) return resolveOmpBunCommand(env).command
  if (process.platform !== "win32") return runtime
  const local = path.join(directory, `${runtime}.exe`)
  const executable = existsSync(local) ? local : locateExecutable(runtime, env) ?? runtime
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

export function resolveOmpCommand(bin?: string, env: NodeJS.ProcessEnv = process.env): OmpCommand {
  env = ompCommandEnvironment(env)
  const explicit = bin?.trim() || env.OMPI_OMP_BIN?.trim()
  bin = explicit || "omp"
  if (bin === "omp" || bin === "omp.exe") {
    const runtime = explicit ? undefined : resolveInstalledOmpRuntime(env)
    bin = runtime ? installedOmpExecutable(runtime, "omp") : locateExecutable(bin, env) ?? bin
  }
  if (process.platform === "win32") bin = locateExecutable(bin, env) ?? bin
  if (process.platform === "win32" && !path.extname(bin) && locateExecutable(bin, env) === undefined
    && (env.PATH ?? "").split(path.delimiter).some(directory => directory && existsSync(path.join(directory, bin)))) {
    throw new Error(`Cannot locate a Windows executable for ${bin}. Set OMPI_OMP_BIN to the OMP CLI, npm .cmd shim or native executable.`)
  }
  if (process.platform === "win32" && /\.(?:cmd|bat)$/i.test(bin)) return resolveWindowsNpmShim(bin, env)
  if (/\.(?:[cm]?js|ts)$/i.test(bin)) {
    const script = path.resolve(bin)
    return { command: scriptRuntime(script, path.dirname(script), env), args: [script] }
  }
  return { command: bin, args: [] }
}

export function resolveOmpBunCommand(env: NodeJS.ProcessEnv = process.env): OmpCommand {
  env = ompCommandEnvironment(env)
  const explicit = env.OMPI_BUN_BIN?.trim()
  if (explicit) return resolveOmpCommand(explicit, env)
  const runtime = resolveInstalledOmpRuntime(env)
  return resolveOmpCommand(runtime ? installedOmpExecutable(runtime, "bun") : "bun", env)
}
