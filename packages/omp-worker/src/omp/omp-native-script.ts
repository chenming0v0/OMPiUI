import { spawn, spawnSync } from "node:child_process"
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs"
import { homedir } from "node:os"
import path from "node:path"
import { locateExecutable, ompCommandEnvironment, resolveOmpBunCommand, resolveOmpCommand } from "./omp-command.js"
import { resolveInstalledOmpRuntime } from "./omp-runtime.js"
import { parseOmpVersion } from "./omp-version.js"

const packageName = "@oh-my-pi/pi-coding-agent"
const selectedVersions = new Map<string, string>()

/** The public source package must belong to the selected CLI, never an ambient global install. */
export function resolveOmpPackageRoot(bin?: string, env: NodeJS.ProcessEnv = process.env): string {
  env = ompCommandEnvironment(env)
  const invocation = resolveOmpCommand(bin, env)
  const executable = locateExecutable(invocation.command, env) ?? invocation.command
  const files = [executable, ...invocation.args]
  const identity = files.map(file => {
    try { const stat = statSync(file); return `${file}:${stat.size}:${stat.mtimeMs}` } catch { return file }
  }).join("\n") + `\n${env.PATH ?? ""}`
  let version = selectedVersions.get(identity)
  if (!version) {
    const probe = spawnSync(invocation.command, [...invocation.args, "--version"], {
      env, encoding: "utf8", timeout: 10_000, windowsHide: true, shell: false,
    })
    const detected = probe.status === 0 ? parseOmpVersion(`${probe.stdout ?? ""}\n${probe.stderr ?? ""}`) : null
    if (!detected) {
      throw Object.assign(new Error(`Cannot verify the selected official OMP CLI version (${executable}): ${probe.error?.message ?? probe.stderr?.trim() ?? "missing version"}. Install the OMPiUI runtime bundle or select a working official CLI.`), { code: "OMP_VERSION_UNVERIFIED" })
    }
    version = detected
    selectedVersions.set(identity, version)
  }
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
    const bunInstall = env.BUN_INSTALL?.trim() || path.join(homedir(), ".bun")
    candidates.push(path.join(bunInstall, "install", "global", "node_modules", packageName))
    if (runtime) candidates.push(path.join(runtime.root, "node_modules", packageName))
  }
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
  const packageRoot = resolveOmpPackageRoot()
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
