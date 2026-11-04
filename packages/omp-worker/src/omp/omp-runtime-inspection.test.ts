import assert from "node:assert/strict"
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import test, { type TestContext } from "node:test"
import { inspectOmpRuntimes } from "./omp-runtime-inspection.js"
import { resolveOmpCommand } from "./omp-command.js"
import { installedOmpRuntimeRoots } from "./omp-runtime.js"

function fixture(t: TestContext) {
  const root = mkdtempSync(path.join(tmpdir(), "ompiui-inspect-"))
  const cwd = process.cwd()
  process.chdir(root)
  t.after(() => { process.chdir(cwd); rmSync(root, { recursive: true, force: true }) })
  const env = { ...process.env, OMPI_OMP_BIN: undefined, OMPI_OMP_RUNTIME_DIR: undefined, OMPI_BUN_BIN: undefined }
  return { root, env }
}

function cli(root: string, name: string, version = "18.12.6", exit = 0) {
  const dir = path.join(root, name)
  mkdirSync(dir)
  const script = path.join(dir, "cli.mjs")
  writeFileSync(script, `#!/usr/bin/env node\nimport assert from 'node:assert/strict';\nassert.deepEqual(process.argv.slice(2), ['--version']);\nconsole.log('omp ${version}');\nprocess.exitCode = ${exit};\n`)
  chmodSync(script, 0o755)
  const bin = path.join(dir, process.platform === "win32" ? "omp.cmd" : "omp")
  if (process.platform === "win32") {
    copyFileSync(process.execPath, path.join(dir, "node.exe"))
    writeFileSync(bin, '@echo off\r\n"%~dp0cli.mjs" %*\r\n')
  } else symlinkSync(script, bin)
  return { dir, bin, script }
}

function runtime(root: string, version = "18.12.6") {
  mkdirSync(path.join(root, "bin"), { recursive: true })
  writeFileSync(path.join(root, "runtime.json"), JSON.stringify({ version, bunVersion: "1.3.14", platform: process.platform, arch: process.arch }))
  for (const name of ["omp", "bun"]) {
    const bin = path.join(root, "bin", process.platform === "win32" ? `${name}.exe` : name)
    // The native CLI fixture answers --version; its output must override manifest metadata.
    if (name === "omp") copyFileSync(process.execPath, bin)
    else writeFileSync(bin, "companion fixture; only local existence is checked")
    chmodSync(bin, 0o755)
  }
  return root
}

function pathEnv(env: NodeJS.ProcessEnv, directories: string[]) {
  return { ...env, PATH: [...directories, path.dirname(process.execPath)].join(path.delimiter) }
}

function assertSelection(result: Awaited<ReturnType<typeof inspectOmpRuntimes>>, env: NodeJS.ProcessEnv) {
  const invocation = resolveOmpCommand(undefined, env)
  assert.ok(result.selected)
  assert.deepEqual({ command: result.selected.command, args: result.selected.args }, invocation)
}

test("enumerates multiple PATH installations and deduplicates npm shim entries with explicit provenance", async t => {
  const { root, env } = fixture(t)
  const first = cli(root, "first")
  const second = cli(root, "second", "18.13.0")
  // Explicit 'omp' deliberately bypasses the real development bundle, as launch does.
  const configured = { ...pathEnv(env, [first.dir, first.dir.toUpperCase(), second.dir]), OMPI_OMP_BIN: "omp" }
  const result = await inspectOmpRuntimes(configured)
  assertSelection(result, configured)
  const installs = result.candidates.filter(candidate => candidate.path === first.script || candidate.path === first.bin || candidate.path === second.script || candidate.path === second.bin)
  assert.equal(installs.length, 2)
  assert.equal(result.selected!.source, "environment")
  assert.equal(result.selected!.version, "18.12.6")
  assert.equal(result.error, null)
  assert.equal(installs[1]!.version, "18.13.0")
  assert.equal(installs[1]!.source, "path")
  assert.equal(result.configuredRuntimeDir, null)
})

test("bundled runtime wins over PATH, and remains present when explicit external bin overrides it", async t => {
  const { root, env } = fixture(t)
  const bundledRoot = runtime(path.join(root, "omp-runtime"))
  const external = cli(root, "external")
  const configured = pathEnv(env, [external.dir])
  const result = await inspectOmpRuntimes(configured)
  assertSelection(result, configured)
  assert.equal(result.selected!.runtimeRoot, bundledRoot)
  assert.equal(result.selected!.source, "bundled")
  assert.equal(result.selected!.version, process.versions.node)
  assert.equal(result.bundled, true)
  assert.equal(result.error, null)
  const explicit = { ...configured, OMPI_OMP_BIN: external.bin }
  const override = await inspectOmpRuntimes(explicit)
  assertSelection(override, explicit)
  assert.equal(override.selected!.source, "environment")
  assert.equal(override.bundled, true)
})

test("environment runtime is not bundled and keeps its root even when explicitly selecting its bin", async t => {
  const { root, env } = fixture(t)
  const runtimeRoot = runtime(path.join(root, "custom-runtime"))
  const configured = { ...env, OMPI_OMP_RUNTIME_DIR: runtimeRoot, OMPI_OMP_BIN: path.join(runtimeRoot, "bin", process.platform === "win32" ? "omp.exe" : "omp") }
  const result = await inspectOmpRuntimes(configured)
  assertSelection(result, configured)
  assert.equal(result.bundled, installedOmpRuntimeRoots().some(dir => existsSync(path.join(dir, "runtime.json"))))
  assert.equal(result.selected!.runtimeRoot, runtimeRoot)
  assert.equal(result.selected!.source, "environment")
  assert.equal(result.selected!.version, process.versions.node)
  assert.equal(result.selected!.error, null)
  assert.equal(result.candidates.filter(candidate => candidate.runtimeRoot === runtimeRoot).length, 1)
})

test("invalid selected runtime never falls back, but PATH candidates remain independently inspectable", async t => {
  const { root, env } = fixture(t)
  const external = cli(root, "external")
  const invalid = path.join(root, "broken-runtime")
  mkdirSync(invalid)
  writeFileSync(path.join(invalid, "runtime.json"), "{}")
  const configured = { ...pathEnv(env, [external.dir]), OMPI_OMP_RUNTIME_DIR: invalid }
  const result = await inspectOmpRuntimes(configured)
  assert.throws(() => resolveOmpCommand(undefined, configured), /Invalid installed OMP runtime/)
  assert.equal(result.selected, null)
  assert.match(result.error!, /Invalid installed OMP runtime/)
  const candidate = result.candidates.find(candidate => candidate.source === "path")!
  assert.equal(candidate.version, "18.12.6")
  assert.equal(candidate.error, null)
  assert.ok(result.candidates.find(candidate => candidate.runtimeRoot === invalid)!.error)
})

test("missing CLI and nonzero or old version probes report errors instead of false availability", async t => {
  const { root, env } = fixture(t)
  const missing = await inspectOmpRuntimes({ ...env, PATH: "", OMPI_OMP_BIN: "omp" })
  assert.equal(missing.selected, null)
  assert.match(missing.error!, /Cannot locate/)
  const failed = cli(root, "failed", "18.12.6", 1)
  writeFileSync(path.join(failed.dir, "package.json"), JSON.stringify({ name: "@oh-my-pi/pi-coding-agent", version: "18.12.6" }))
  const old = cli(root, "old", "18.12.5")
  for (const [bin, error] of [[failed.bin, /Cannot inspect OMP version/], [old.bin, /too old/]] as const) {
    const configured = { ...pathEnv(env, [failed.dir, old.dir]), OMPI_OMP_BIN: bin }
    const result = await inspectOmpRuntimes(configured)
    assertSelection(result, configured)
    assert.match(result.error!, error)
    assert.match(result.selected!.error!, error)
    if (bin === failed.bin) assert.equal(result.selected!.version, "18.12.6")
  }
})

test("a runtime manifest cannot bypass a failed CLI execution check", async t => {
  const { root, env } = fixture(t)
  const runtimeRoot = runtime(path.join(root, "omp-runtime"))
  const bin = path.join(runtimeRoot, "bin", process.platform === "win32" ? "omp.exe" : "omp")
  writeFileSync(bin, "")
  const configured = { ...env, PATH: "", OMPI_OMP_RUNTIME_DIR: runtimeRoot }
  const result = await inspectOmpRuntimes(configured)
  assertSelection(result, configured)
  assert.equal(result.bundled, true)
  assert.equal(result.selected!.version, "18.12.6")
  assert.match(result.selected!.error!, /Cannot inspect OMP version|returned no version|spawn /)
  assert.equal(result.error, result.selected!.error)
})

test("a manifest version does not hide missing runtime executables", async t => {
  const { root, env } = fixture(t)
  const runtimeRoot = runtime(path.join(root, "custom-runtime"))
  const bun = path.join(runtimeRoot, "bin", process.platform === "win32" ? "bun.exe" : "bun")
  rmSync(bun)
  const configured = { ...env, OMPI_OMP_RUNTIME_DIR: runtimeRoot }
  const result = await inspectOmpRuntimes(configured)
  assertSelection(result, configured)
  assert.equal(result.selected!.version, "18.12.6")
  assert.match(result.error!, /missing .*bun/)
  assert.equal(readFileSync(path.join(runtimeRoot, "runtime.json"), "utf8").includes("18.12.6"), true)
})
