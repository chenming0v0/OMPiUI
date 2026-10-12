import { spawnSync } from "node:child_process"
import { closeSync, existsSync, openSync, readFileSync, readSync } from "node:fs"
import path from "node:path"

export interface OmpConfigCommand {
  command: string
  args: string[]
}

function windowsExecutable(bin: string): string {
  if (path.isAbsolute(bin) || /[/\\]/.test(bin)) return path.resolve(bin)
  const probe = spawnSync("where.exe", [bin], { encoding: "utf8", windowsHide: true })
  const candidates = probe.status === 0 ? probe.stdout.split(/\r?\n/).map(line => line.trim()).filter(Boolean) : []
  return candidates.find(candidate => /\.exe$/i.test(candidate)) ?? candidates[0] ?? bin
}

function scriptRuntime(script: string, directory: string): string {
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
  return existsSync(local) ? local : windowsExecutable(runtime)
}

/** 标准 npm shim 只用于定位脚本；JSON 参数不经过 cmd.exe 重解析。 */
export function resolveWindowsNpmShim(bin: string): OmpConfigCommand {
  const directory = path.dirname(bin)
  const source = readFileSync(bin, "utf8")
  for (const match of source.matchAll(/"([^"\r\n]+\.(?:[cm]?js|ts))"\s+%\*/gi)) {
    const target = match[1]!
      .replace(/%~dp0/gi, `${directory}${path.sep}`)
      .replace(/%dp0%/gi, directory)
    if (/%[^%]+%/.test(target)) continue
    const script = path.resolve(directory, target)
    if (existsSync(script)) return { command: scriptRuntime(script, directory), args: [script] }
  }
  throw new Error(`Cannot locate the OMP CLI in npm shim: ${bin}. Set OMPI_OMP_BIN to the OMP CLI or native executable.`)
}

export function resolveOmpConfigCommand(): OmpConfigCommand {
  let bin = process.env.OMPI_OMP_BIN?.trim() || "omp"
  if (process.platform === "win32") bin = windowsExecutable(bin)
  if (process.platform === "win32" && /\.(?:cmd|bat)$/i.test(bin)) return resolveWindowsNpmShim(bin)
  if (/\.(?:[cm]?js|ts)$/i.test(bin)) {
    const script = path.resolve(bin)
    return { command: scriptRuntime(script, path.dirname(script)), args: [script] }
  }
  return { command: bin, args: [] }
}
