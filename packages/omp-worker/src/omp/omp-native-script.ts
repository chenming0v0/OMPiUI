import { spawn, type ChildProcess } from "node:child_process"
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs"
import { homedir } from "node:os"
import path from "node:path"
import { locateExecutable, ompCommandEnvironment, resolveOmpBunCommand, resolveOmpCommand } from "./omp-command.js"
import { installedOmpExecutable, resolveInstalledOmpRuntime } from "./omp-runtime.js"
import { parseOmpVersion } from "./omp-version.js"

const packageName = "@oh-my-pi/pi-coding-agent"
type VersionProbe = { version: string } | { error: Error & { code: string }; retryAt: number }
const selectedVersions = new Map<string, VersionProbe>()
const pendingVersions = new Map<string, Promise<VersionProbe>>()
const versionProbeTimeoutMs = 30_000
const versionProbeBackoffMs = 5_000

function probeSelectedVersion(executable: string, args: string[], env: NodeJS.ProcessEnv, identity: string): Promise<VersionProbe> {
  const cached = selectedVersions.get(identity)
  if (cached && ("version" in cached || Date.now() < cached.retryAt)) return Promise.resolve(cached)
  const pending = pendingVersions.get(identity)
  if (pending) return pending
  const { promise, resolve } = Promise.withResolvers<VersionProbe>()
  pendingVersions.set(identity, promise)
  void promise.then(() => pendingVersions.delete(identity))
  let settled = false
  let timer: NodeJS.Timeout | undefined
  const finish = (result: VersionProbe) => {
    if (settled) return
    settled = true
    clearTimeout(timer)
    selectedVersions.set(identity, result)
    resolve(result)
  }
  const fail = (reason: string, code = "OMP_VERSION_UNVERIFIED") => finish({
    error: Object.assign(new Error(`Cannot verify the selected official OMP CLI version (${executable}): ${reason}. The probe is temporarily unavailable; retry shortly.`), { code }),
    retryAt: Date.now() + versionProbeBackoffMs,
  })
  let child: ChildProcess
  try {
    child = spawn(executable, [...args, "--version"], {
      env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true, shell: false,
    })
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error))
    return promise
  }
  let output = ""
  let timedOut = false
  child.stdout?.setEncoding("utf8")
  child.stderr?.setEncoding("utf8")
  child.stdout?.on("data", chunk => { output = (output + chunk).slice(-65_536) })
  child.stderr?.on("data", chunk => { output = (output + "\n" + chunk).slice(-65_536) })
  child.on("error", error => fail(timedOut ? `version probe timed out after ${versionProbeTimeoutMs}ms` : error.message, timedOut ? "OMP_VERSION_PROBE_TIMEOUT" : "OMP_VERSION_UNVERIFIED"))
  child.on("close", code => {
    if (timedOut) { fail(`version probe timed out after ${versionProbeTimeoutMs}ms`, "OMP_VERSION_PROBE_TIMEOUT"); return }
    const version = code === 0 ? parseOmpVersion(output) : null
    if (version) finish({ version })
    else fail(output.trim() || `exit ${code}, missing version`)
  })
  timer = setTimeout(() => {
    timedOut = true
    child.kill()
  }, versionProbeTimeoutMs)
  return promise
}

/** Windows 版 Bun 启动垫片会在相邻的 .bunx 文件开头记录所选脚本。 */
function selectedSourceEntry(executable: string, args: string[], bunInstall: string): string | undefined {
  if (args[0]) return args[0]
  if (process.platform !== "win32" || path.resolve(executable).toLowerCase() !== path.resolve(bunInstall, "bin", "omp.exe").toLowerCase()) return undefined
  try {
    const target = readFileSync(path.join(bunInstall, "bin", "omp.bunx")).toString("utf16le").match(/^([^"\0\r\n]+\.[cm]?js)"\0/)?.[1]
    return target ? path.resolve(bunInstall, target) : undefined
  } catch {
    return undefined
  }
}

function packageVersionForEntry(candidate: string, entry: string | undefined): string | undefined {
  if (!entry || !existsSync(entry)) return undefined
  try {
    const metadata: unknown = JSON.parse(readFileSync(path.join(candidate, "package.json"), "utf8"))
    if (!metadata || typeof metadata !== "object" || !("name" in metadata) || metadata.name !== packageName
      || !("version" in metadata) || typeof metadata.version !== "string" || parseOmpVersion(metadata.version) !== metadata.version
      || !("bin" in metadata)) return undefined
    const bins = typeof metadata.bin === "string" ? [metadata.bin]
      : metadata.bin && typeof metadata.bin === "object" ? Object.values(metadata.bin).filter((bin): bin is string => typeof bin === "string") : []
    return bins.some(bin => realpathSync(path.resolve(candidate, bin)) === realpathSync(entry)) ? metadata.version : undefined
  } catch {
    return undefined
  }
}

/** The public source package must belong to the selected CLI, never an ambient global install. */
export async function resolveOmpPackageRoot(bin?: string, env: NodeJS.ProcessEnv = process.env): Promise<string> {
  env = ompCommandEnvironment(env)
  const invocation = resolveOmpCommand(bin, env)
  const executable = locateExecutable(invocation.command, env) ?? invocation.command
  const bunInstall = env.BUN_INSTALL?.trim() || path.join(homedir(), ".bun")
  const sourceEntry = selectedSourceEntry(executable, invocation.args, bunInstall)
  const files = [executable, ...invocation.args, ...(sourceEntry ? [sourceEntry] : []), path.join(bunInstall, "bin", "omp.bunx")]
  const identity = files.map(file => {
    try { const stat = statSync(file); return `${file}:${stat.size}:${stat.mtimeMs}` } catch { return file }
  }).join("\n") + `\n${env.PATH ?? ""}`
  const probe = await probeSelectedVersion(executable, invocation.args, env, identity)
  let version = "version" in probe ? probe.version : undefined
  const explicit = env.OMPI_OMP_PACKAGE_ROOT?.trim()
  const candidates: string[] = explicit ? [path.resolve(explicit)] : []
  const runtime = explicit ? undefined : resolveInstalledOmpRuntime(env)
  if (!explicit) {
    let entry = invocation.args[0] ?? executable
    if (existsSync(entry)) entry = realpathSync(entry)
    for (let directory = path.dirname(path.resolve(entry)); ; directory = path.dirname(directory)) {
      candidates.push(directory, path.join(directory, "node_modules", packageName))
      if (directory === path.dirname(directory)) break
    }
    // bun 全局安装的 CLI 是 trampoline（$BUN_INSTALL/bin/omp.exe），回溯不到包体；
    // 按文档化的安装布局直接补上 install/global 根。
    // 仅当 .bunx 明确将此 CLI 绑定到对应入口时，才允许以全局清单作为超时回退。
    candidates.push(path.join(bunInstall, "install", "global", "node_modules", packageName))
    if (runtime) candidates.push(path.join(runtime.root, "node_modules", packageName))
  }
  if (!version && "error" in probe && probe.error.code === "OMP_VERSION_PROBE_TIMEOUT") {
    for (const candidate of new Set(candidates)) {
      version = packageVersionForEntry(candidate, sourceEntry)
      if (version) break
    }
    if (!version && runtime && path.resolve(executable) === path.resolve(installedOmpExecutable(runtime, "omp"))) version = runtime.version
  }
  if (!version && "error" in probe) throw probe.error
  const incompatible: string[] = []
  for (const candidate of new Set(candidates)) {
    const manifest = path.join(candidate, "package.json")
    if (!existsSync(manifest)) continue
    let metadata: { name?: string; version?: string }
    try { metadata = JSON.parse(readFileSync(manifest, "utf8")) } catch { continue }
    if (metadata.name !== packageName || !existsSync(path.join(candidate, "src", "config", "settings.ts"))) continue
    if (metadata.version !== version) {
      incompatible.push(`${candidate} (${metadata.version ?? "unversioned"})`)
      continue
    }
    if (runtime && candidate === path.join(runtime.root, "node_modules", packageName) && runtime.version !== version) {
      incompatible.push(`${runtime.root} (bundle ${runtime.version})`)
      continue
    }
    return realpathSync(candidate)
  }
  throw Object.assign(new Error(incompatible.length
    ? `OMP public API version mismatch: selected CLI is ${version}; available sources: ${incompatible.join(", ")}. Prepare the runtime with --version ${version}, or select the bundled official CLI.`
    : `Cannot locate official OMP ${version} public API sources with their dependencies. Sessions still work with a standalone OMP binary; only features that need these sources (such as OMP settings read/write) are unavailable. Install/prepare the OMPiUI runtime bundle with --version ${version}. An external npm installation may be selected with OMPI_OMP_PACKAGE_ROOT.`), { code: incompatible.length ? "OMP_SOURCE_VERSION_MISMATCH" : "OMP_SOURCE_MISSING" })
}

/** Run trusted bridge source with the official Bun-only APIs in a separate process. */
export async function runOmpNativeScript<T>(cwd: string, source: string, input: unknown, timeoutMs = 120_000): Promise<T> {
  const packageRoot = await resolveOmpPackageRoot()
  const runtime = resolveOmpBunCommand()
  const payload = JSON.stringify({ cwd: path.resolve(cwd), packageRoot, input })
  const marker = "\nOMPI_NATIVE_RESULT="
  const wrapper = `
    import path from "node:path";
    import { pathToFileURL } from "node:url";
    const { input, cwd, packageRoot } = JSON.parse(await Bun.stdin.text());
    const nativeModule = relative => import(pathToFileURL(path.join(packageRoot, relative)).href);
    try {
      const value = await (async () => { ${source}\n })();
      process.stdout.write(${JSON.stringify(marker)} + JSON.stringify({ value }) + "\\n");
    } catch (error) {
      process.stdout.write(${JSON.stringify(marker)} + JSON.stringify({ error: error instanceof Error ? error.message : String(error) }) + "\\n");
      process.exitCode = 1;
    }
  `
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  const child = spawn(runtime.command, [...runtime.args, "-e", wrapper], {
    cwd, env: ompCommandEnvironment(), stdio: ["pipe", "pipe", "pipe"], shell: false, windowsHide: true,
  })
  let stdout = ""
  let stderr = ""
  let failure: Error | undefined
  const timer = setTimeout(() => { failure = new Error(`OMP public API operation timed out after ${timeoutMs}ms`); child.kill() }, timeoutMs)
  child.stdout.setEncoding("utf8")
  child.stderr.setEncoding("utf8")
  child.stdout.on("data", (chunk: string) => { stdout += chunk })
  child.stderr.on("data", (chunk: string) => { stderr = (stderr + chunk).slice(-65_536) })
  child.on("error", error => { clearTimeout(timer); reject(error) })
  child.stdin.on("error", error => { failure ??= error })
  child.on("close", code => {
    clearTimeout(timer)
    if (failure) { reject(failure); return }
    try {
      const index = stdout.lastIndexOf(marker)
      if (index < 0) throw new Error(`OMP public API exited with ${code}: ${stderr.trim() || "missing result"}`)
      const result = JSON.parse(stdout.slice(index + marker.length).split("\n")[0]!) as { value: T; error?: string }
      if (result.error) throw new Error(result.error)
      if (code !== 0) throw new Error(`OMP public API exited with ${code}: ${stderr.trim()}`)
      resolve(result.value)
    } catch (error) { reject(error) }
  })
  child.stdin.end(payload)
  return promise
}
