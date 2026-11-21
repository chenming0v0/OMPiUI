import assert from "node:assert/strict"
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { test, type TestContext } from "node:test"
import { resolveOmpPackageRoot } from "./omp-native-script.js"
import { resolveInstalledOmpRuntime } from "./omp-runtime.js"

/**
 * repo 根准备过 omp-runtime/ 时，source 解析会额外扫到 ambient bundle 版本，
 * 「无 ambient 安装」的报错路径不可达；该用例只在没有安装 runtime 的环境（CI）运行。
 */
const ambientRuntimePresent = (() => {
  try {
    return resolveInstalledOmpRuntime({}) !== undefined
  } catch {
    return true
  }
})()

function fixture(t: TestContext) {
  const directory = mkdtempSync(path.join(tmpdir(), "ompiui-native-root-"))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const root = path.join(directory, "selected package")
  mkdirSync(path.join(root, "src", "config"), { recursive: true })
  writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "@oh-my-pi/pi-coding-agent", version: "18.3.1", bin: { omp: "cli.mjs" } }))
  writeFileSync(path.join(root, "src", "config", "settings.ts"), "export {}\n")
  const cli = path.join(root, "cli.mjs")
  writeFileSync(cli, '#!/usr/bin/env node\nconsole.log("omp 18.3.1 (fixture)")\n')
  return { directory, root, cli }
}

test("native source resolver follows selected CLI instead of ambient installations", { skip: ambientRuntimePresent }, async t => {
  const f = fixture(t)
  const env = { ...process.env, OMPI_OMP_RUNTIME_DIR: undefined, OMPI_OMP_PACKAGE_ROOT: undefined, BUN_INSTALL: path.join(f.directory, "absent-bun") }
  assert.equal(await resolveOmpPackageRoot(f.cli, env), realpathSync(f.root))
  const unknown = path.join(f.directory, "unknown.mjs")
  writeFileSync(unknown, '#!/usr/bin/env node\nconsole.log("omp 18.3.1 (fixture)")\n')
  await assert.rejects(resolveOmpPackageRoot(unknown, env), /Cannot locate official OMP 18\.3\.1/)
})

test("explicit package root uses supplied environment and rejects incompatible directories", async t => {
  const f = fixture(t)
  const env = { ...process.env, OMPI_OMP_PACKAGE_ROOT: f.root }
  assert.equal(await resolveOmpPackageRoot(f.cli, env), realpathSync(f.root))
  writeFileSync(path.join(f.root, "package.json"), JSON.stringify({ name: "unrelated-package", version: "18.3.1" }))
  await assert.rejects(resolveOmpPackageRoot(f.cli, env), /Cannot locate official OMP/)
})

test("a standalone CLI cannot use different-version public sources", async t => {
  const f = fixture(t)
  const env = { ...process.env, OMPI_OMP_PACKAGE_ROOT: f.root }
  writeFileSync(path.join(f.root, "package.json"), JSON.stringify({ name: "@oh-my-pi/pi-coding-agent", version: "18.8.0" }))
  await assert.rejects(resolveOmpPackageRoot(f.cli, env), (error: unknown) => {
    assert.ok(error instanceof Error && "code" in error)
    assert.equal(error.code, "OMP_SOURCE_VERSION_MISMATCH")
    assert.match(error.message, /selected CLI is 18\.3\.1/)
    return true
  })
})

test("an explicit source root does not bypass selected CLI version verification", async t => {
  const f = fixture(t)
  await assert.rejects(resolveOmpPackageRoot(path.join(f.directory, "missing.exe"), {
    ...process.env, OMPI_OMP_PACKAGE_ROOT: f.root,
  }), (error: unknown) => error instanceof Error && "code" in error && error.code === "OMP_VERSION_UNVERIFIED")
})

test("bun global installation root is searched when the CLI entry cannot be backtracked", async t => {
  const f = fixture(t)
  const bunPackage = path.join(f.directory, "bun-home", "install", "global", "node_modules", "@oh-my-pi", "pi-coding-agent")
  mkdirSync(path.join(bunPackage, "src", "config"), { recursive: true })
  writeFileSync(path.join(bunPackage, "package.json"), JSON.stringify({ name: "@oh-my-pi/pi-coding-agent", version: "18.3.1" }))
  writeFileSync(path.join(bunPackage, "src", "config", "settings.ts"), "export {}\n")
  const unknown = path.join(f.directory, "unknown.mjs")
  writeFileSync(unknown, '#!/usr/bin/env node\nconsole.log("omp 18.3.1 (fixture)")\n')
  const env = { ...process.env, OMPI_OMP_RUNTIME_DIR: undefined, OMPI_OMP_PACKAGE_ROOT: undefined, BUN_INSTALL: path.join(f.directory, "bun-home") }
  assert.equal(await resolveOmpPackageRoot(unknown, env), realpathSync(bunPackage))
  // 版本不符时落进 incompatible，报错从含糊的 OMP_SOURCE_MISSING 升级为明确的版本不匹配。
  writeFileSync(path.join(bunPackage, "package.json"), JSON.stringify({ name: "@oh-my-pi/pi-coding-agent", version: "18.8.0" }))
  await assert.rejects(resolveOmpPackageRoot(unknown, env), (error: unknown) => {
    assert.ok(error instanceof Error && "code" in error)
    assert.equal(error.code, "OMP_SOURCE_VERSION_MISMATCH")
    return true
  })
})

test("a timed-out CLI uses only the manifest bound to its selected entry", async t => {
  const f = fixture(t)
  t.mock.timers.enable({ apis: ["setTimeout"] })
  const resolving = resolveOmpPackageRoot(f.cli, { ...process.env, OMPI_OMP_PACKAGE_ROOT: f.root })
  t.mock.timers.tick(30_000)
  assert.equal(await resolving, realpathSync(f.root))
})

test("concurrent failures share one probe, back off, and recover without restarting the worker", async t => {
  const f = fixture(t)
  const cli = path.join(f.directory, "standalone.mjs")
  const ready = path.join(f.directory, "ready")
  writeFileSync(cli, `#!/usr/bin/env node\nimport { existsSync } from "node:fs";\nif (existsSync(${JSON.stringify(ready)})) console.log("omp 18.3.1");\nelse process.exitCode = 1;\n`)
  const env = { ...process.env, OMPI_OMP_PACKAGE_ROOT: f.root }
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: Date.now() })
  const timeout = (error: unknown) => error instanceof Error && "code" in error && error.code === "OMP_VERSION_PROBE_TIMEOUT"
  const first = assert.rejects(resolveOmpPackageRoot(cli, env), timeout)
  const concurrent = assert.rejects(resolveOmpPackageRoot(cli, env), timeout)
  t.mock.timers.tick(30_000)
  await Promise.all([first, concurrent])
  // No timer advancement: a fresh blocking probe would never finish this request.
  await assert.rejects(resolveOmpPackageRoot(cli, env), timeout)
  writeFileSync(ready, "ready")
  t.mock.timers.tick(5_000)
  assert.equal(await resolveOmpPackageRoot(cli, env), realpathSync(f.root))
})

test("overlapping successful requests launch the selected CLI only once", async t => {
  const f = fixture(t)
  const launches = path.join(f.directory, "launches")
  writeFileSync(f.cli, `#!/usr/bin/env node\nimport { appendFileSync } from "node:fs";\nappendFileSync(${JSON.stringify(launches)}, "launch\\n");\nconsole.log("omp 18.3.1");\n`)
  const env = { ...process.env, OMPI_OMP_PACKAGE_ROOT: f.root }
  assert.deepEqual(await Promise.all([resolveOmpPackageRoot(f.cli, env), resolveOmpPackageRoot(f.cli, env)]), [realpathSync(f.root), realpathSync(f.root)])
  assert.equal(readFileSync(launches, "utf8"), "launch\n")
})

test("Windows Bun trampoline timeouts follow .bunx and invalidate its cached version when updated", { skip: process.platform !== "win32" }, async t => {
  const f = fixture(t)
  const bunInstall = path.join(f.directory, "bun-home")
  const bin = path.join(bunInstall, "bin")
  const packageRoot = path.join(bunInstall, "install", "global", "node_modules", "@oh-my-pi", "pi-coding-agent")
  mkdirSync(bin, { recursive: true })
  mkdirSync(path.join(packageRoot, "src", "config"), { recursive: true })
  const cli = path.join(packageRoot, "cli.mjs")
  writeFileSync(cli, "console.log('omp 18.3.1')\n")
  writeFileSync(path.join(packageRoot, "package.json"), JSON.stringify({ name: "@oh-my-pi/pi-coding-agent", version: "18.3.1", bin: { omp: "cli.mjs" } }))
  writeFileSync(path.join(packageRoot, "src", "config", "settings.ts"), "export {}\n")
  const executable = path.join(bin, "omp.exe")
  copyFileSync(process.execPath, executable)
  const bunx = path.join(bin, "omp.bunx")
  const bind = (entry: string) => writeFileSync(bunx, Buffer.from(`${path.relative(bunInstall, entry)}"\0bun `, "utf16le"))
  bind(cli)
  const env = { ...process.env, BUN_INSTALL: bunInstall, OMPI_OMP_PACKAGE_ROOT: packageRoot }
  t.mock.timers.enable({ apis: ["setTimeout"] })
  const resolving = resolveOmpPackageRoot(executable, env)
  t.mock.timers.tick(30_000)
  assert.equal(await resolving, realpathSync(packageRoot))
  // An unrelated ambient source must not be adopted when the trampoline target changes.
  bind(path.join(f.directory, "different-cli.mjs"))
  const rejected = assert.rejects(resolveOmpPackageRoot(executable, env), (error: unknown) => error instanceof Error && "code" in error && error.code === "OMP_VERSION_PROBE_TIMEOUT")
  t.mock.timers.tick(30_000)
  await rejected
})
