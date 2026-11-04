import { execFile } from "node:child_process"
import { accessSync, constants, existsSync, readFileSync, realpathSync, statSync } from "node:fs"
import path from "node:path"
import type { OmpRuntimeCandidate, OmpRuntimeInspection } from "@ompiui/protocol"
import { executablePaths, locateExecutable, ompCommandEnvironment, resolveOmpCommand, type OmpCommand } from "./omp-command.js"
import { installedOmpExecutable, installedOmpRuntimeRoots, resolveInstalledOmpRuntime } from "./omp-runtime.js"
import { isOmpVersionSupported, ompTooOldError, parseOmpVersion } from "./omp-version.js"

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function identity(file: string): string {
  try { file = realpathSync.native(file) } catch { file = path.resolve(file) }
  return process.platform === "win32" ? file.toLowerCase() : file
}

function entryPath(invocation: OmpCommand, env: NodeJS.ProcessEnv): string {
  return path.resolve(invocation.args[0] ?? locateExecutable(invocation.command, env) ?? invocation.command)
}

function checkFile(file: string, executable: boolean): void {
  if (!statSync(file).isFile()) throw new Error(`Not an OMP runtime file: ${file}`)
  accessSync(file, executable && process.platform !== "win32" ? constants.X_OK : constants.R_OK)
}

/** Read only the manifest belonging to this CLI, not an unrelated global package. */
function packageVersion(entry: string): string | null {
  for (let dir = path.dirname(identity(entry)); ; dir = path.dirname(dir)) {
    const manifest = path.join(dir, "package.json")
    if (existsSync(manifest)) {
      try {
        const metadata = JSON.parse(readFileSync(manifest, "utf8"))
        if (metadata.name === "@oh-my-pi/pi-coding-agent" && typeof metadata.version === "string") {
          return /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(metadata.version) ? metadata.version : null
        }
      } catch { /* A CLI without a usable manifest can still answer --version. */ }
    }
    if (dir === path.dirname(dir)) return null
  }
}

function probeVersion(invocation: OmpCommand, env: NodeJS.ProcessEnv, cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    // Fixed version flag only: no RPC, session, worker, shell or network command.
    const child = execFile(invocation.command, [...invocation.args, "--version"], {
      env, cwd, timeout: 10_000, maxBuffer: 64 * 1024, windowsHide: true, shell: false,
    }, (error, stdout, stderr) => {
      if (error) { reject(new Error(`Cannot inspect OMP version (${invocation.command}): ${message(error)}`)); return }
      const version = parseOmpVersion(`${stdout}\n${stderr}`)
      if (!version) { reject(new Error(`OMP --version returned no version: ${invocation.command}`)); return }
      resolve(version)
    })
    child.stdin?.end()
  })
}

/** Snapshot actual launch resolution and local installations; never starts an Agent. */
export async function inspectOmpRuntimes(overrides: NodeJS.ProcessEnv = process.env): Promise<OmpRuntimeInspection> {
  const env = ompCommandEnvironment(overrides)
  const cwd = process.cwd()
  const configuredBin = env.OMPI_OMP_BIN?.trim() || null
  const configuredRuntimeDir = env.OMPI_OMP_RUNTIME_DIR?.trim() || null
  const bundledRoots = installedOmpRuntimeRoots()
  const candidates: OmpRuntimeCandidate[] = []
  const seen = new Map<string, OmpRuntimeCandidate>()
  const pending: Array<() => Promise<void>> = []
  let selectedInvocation: OmpCommand | undefined
  let selectionError: string | null = null
  try { selectedInvocation = resolveOmpCommand(undefined, env) } catch (error) { selectionError = message(error) }

  const add = (bin: string, source: OmpRuntimeCandidate["source"], candidateEnv: NodeJS.ProcessEnv, runtimeRoot: string | null = null, actualInvocation?: OmpCommand) => {
    let invocation: OmpCommand = { command: bin, args: [] }
    let error: string | null = null
    let version: string | null = null
    if (runtimeRoot) {
      try {
        const runtime = resolveInstalledOmpRuntime({ ...candidateEnv, OMPI_OMP_RUNTIME_DIR: runtimeRoot })!
        version = runtime.version
        bin = installedOmpExecutable(runtime, "omp")
        checkFile(installedOmpExecutable(runtime, "bun"), true)
      } catch (failure) { error = message(failure) }
    }
    try { invocation = actualInvocation ?? resolveOmpCommand(bin, candidateEnv) } catch (failure) { error ??= message(failure) }
    const entry = entryPath(invocation, candidateEnv)
    const key = identity(entry)
    const previous = seen.get(key)
    if (previous) {
      if (runtimeRoot) {
        previous.runtimeRoot = runtimeRoot
        previous.version = version
        previous.error ??= error
      }
      return
    }
    const candidate: OmpRuntimeCandidate = { path: entry, source, version, ...invocation, error, runtimeRoot }
    seen.set(key, candidate)
    candidates.push(candidate)
    pending.push(async () => {
      try {
        if (candidate.error) return
        checkFile(entry, invocation.args.length === 0)
        const interpreter = locateExecutable(invocation.command, candidateEnv)
        if (!interpreter) throw new Error(`Cannot locate the OMP executable or interpreter: ${invocation.command}`)
        checkFile(interpreter, true)
        candidate.version ??= packageVersion(entry)
        // Manifest versions remain useful on failure, but never prove this CLI can run.
        candidate.version = await probeVersion(invocation, candidateEnv, cwd)
        if (!isOmpVersionSupported(candidate.version)) throw ompTooOldError(candidate.version)
      } catch (failure) { candidate.error = message(failure) }
    })
  }

  // Inspect the exact selected invocation before independently inspecting alternatives.
  if (selectedInvocation) {
    const entry = entryPath(selectedInvocation, env)
    const runtimeRoots = [...(configuredRuntimeDir ? [path.resolve(configuredRuntimeDir)] : []), ...bundledRoots]
    const runtimeRoot = runtimeRoots.find(root => identity(path.join(root, "bin", process.platform === "win32" ? "omp.exe" : "omp")) === identity(entry)) ?? null
    const source = configuredBin || configuredRuntimeDir && runtimeRoot === path.resolve(configuredRuntimeDir)
      ? "environment" : runtimeRoot ? "bundled" : "path"
    if (existsSync(entry)) add(entry, source, env, runtimeRoot, selectedInvocation)
  }
  // Explicit configuration retains its provenance even when also found on PATH.
  const pathEnv = { ...env, OMPI_OMP_BIN: undefined, OMPI_OMP_RUNTIME_DIR: undefined }
  if (configuredBin) add(locateExecutable(configuredBin, env) ?? configuredBin, "environment", pathEnv)
  if (configuredRuntimeDir) {
    const root = path.resolve(configuredRuntimeDir)
    add(path.join(root, "bin", process.platform === "win32" ? "omp.exe" : "omp"), "environment", { ...env, OMPI_OMP_BIN: undefined, OMPI_OMP_RUNTIME_DIR: root }, root)
  }
  for (const root of bundledRoots) {
    if (existsSync(root)) add(path.join(root, "bin", process.platform === "win32" ? "omp.exe" : "omp"), "bundled", { ...env, OMPI_OMP_BIN: undefined, OMPI_OMP_RUNTIME_DIR: root }, root)
  }
  // A broken environment override must not hide otherwise usable PATH installs.
  for (const bin of executablePaths("omp", pathEnv)) add(bin, "path", pathEnv)
  await Promise.all(pending.map(inspect => inspect()))

  let selected: OmpRuntimeCandidate | null = null
  if (selectedInvocation) {
    const entry = entryPath(selectedInvocation, env)
    if (existsSync(entry)) {
      selected = seen.get(identity(entry)) ?? null
      if (selected) {
        // In particular, keep bare explicit command names exactly as the resolver returns them.
        selected.command = selectedInvocation.command
        selected.args = selectedInvocation.args
        selectionError = selected.error
      }
    }
    if (!selected) selectionError = `Cannot locate the selected OMP runtime: ${selectedInvocation.command}`
  }
  const bundled = bundledRoots.some(root => existsSync(path.join(root, "runtime.json")))
  return { selected, candidates, bundled, error: selectionError, configuredBin, configuredRuntimeDir }
}
