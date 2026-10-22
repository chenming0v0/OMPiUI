import { spawn, spawnSync } from "node:child_process"
import { existsSync, readFileSync, realpathSync } from "node:fs"
import { createRequire } from "node:module"
import os from "node:os"
import path from "node:path"
import { ompCommandEnvironment, resolveOmpCommand } from "./omp-command.js"

const packageName = "@oh-my-pi/pi-coding-agent"

/** Locate the installed official source without loading it in the worker. */
export function resolveOmpPackageRoot(bin?: string, env: NodeJS.ProcessEnv = process.env): string {
  env = ompCommandEnvironment(env)
  const explicit = env.OMPI_OMP_PACKAGE_ROOT?.trim()
  const selectedBin = bin?.trim() || env.OMPI_OMP_BIN?.trim() || "omp"
  const invocation = explicit ? undefined : resolveOmpCommand(selectedBin, env)
  let executable = invocation?.args[0] ?? invocation?.command ?? ""
  if (!explicit && !path.isAbsolute(executable)) {
    const probe = spawnSync(process.platform === "win32" ? "where.exe" : "which", [executable], {
      env, encoding: "utf8", timeout: 5_000, windowsHide: true,
    })
    executable = probe.status === 0 ? probe.stdout.trim().split(/\r?\n/)[0]! : executable
  }
  if (executable && existsSync(executable)) executable = realpathSync(executable)
  const candidates: string[] = explicit ? [path.resolve(explicit)] : []
  if (!explicit) {
    for (let directory = path.dirname(path.resolve(executable)); ; directory = path.dirname(directory)) {
      candidates.push(directory, path.join(directory, "node_modules", packageName), path.join(directory, "install", "global", "node_modules", packageName))
      if (directory === path.dirname(directory)) break
    }
    if (selectedBin === "omp" || selectedBin === "omp.exe") {
      try {
        const entry = createRequire(import.meta.url).resolve(packageName)
        for (let directory = path.dirname(entry); directory !== path.dirname(directory); directory = path.dirname(directory)) candidates.push(directory)
      } catch { /* Global CLI installations need not be in the worker's module search path. */ }
      const home = (process.platform === "win32" ? env.USERPROFILE : env.HOME) || os.homedir()
      candidates.push(path.join(home, ".bun", "install", "global", "node_modules", packageName))
      if (env.APPDATA) candidates.push(path.join(env.APPDATA, "npm", "node_modules", packageName))
    }
  }
  for (const candidate of candidates) {
    const manifest = path.join(candidate, "package.json")
    if (!existsSync(manifest)) continue
    try {
      if (JSON.parse(readFileSync(manifest, "utf8")).name === packageName && existsSync(path.join(candidate, "src", "config", "settings.ts"))) return realpathSync(candidate)
    } catch { /* Continue to the next independently located installation. */ }
  }
  throw new Error("Cannot locate official OMP public API sources. Set OMPI_OMP_PACKAGE_ROOT to the installed @oh-my-pi/pi-coding-agent package directory.")
}

/** Run trusted bridge source with the official Bun-only APIs in a separate process. */
export async function runOmpNativeScript<T>(cwd: string, source: string, input: unknown, timeoutMs = 120_000): Promise<T> {
  const packageRoot = resolveOmpPackageRoot()
  const runtime = resolveOmpCommand(process.env.OMPI_BUN_BIN?.trim() || "bun")
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
