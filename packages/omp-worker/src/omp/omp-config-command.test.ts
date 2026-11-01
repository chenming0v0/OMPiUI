import assert from "node:assert/strict"
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { test, type TestContext } from "node:test"
import { OmpCatalog } from "./omp-catalog.js"
import { resolveOmpConfigCommand, resolveWindowsNpmShim } from "./omp-config-command.js"
import { resolveInstalledOmpRuntime } from "./omp-runtime.js"

/**
 * 已安装的 OMP runtime（repo 根的 omp-runtime/）在解析时优先于 PATH shim 与本地解释器，
 * bun 入口脚本尤其永远走已安装 runtime。准备过 runtime 的开发机上这些解析路径不可达，
 * 相关用例只在没有安装 runtime 的环境（CI）运行；runtime 存在或损坏都视为接管。
 */
function installedRuntimeTakesPrecedence(): boolean {
  try {
    return resolveInstalledOmpRuntime({}) !== undefined
  } catch {
    return true
  }
}

/**
 * Windows 临时目录可能带 8.3 短名（CI 的 TEMP 是 RUNNER~1），而 where.exe 返回规范长路径。
 * 入口解析只承诺同一个可执行文件与脚本，不承诺拼写，比较前统一成规范路径。
 */
function canonicalPath(value: string): string {
  let resolved: string
  try {
    resolved = realpathSync.native(value)
  } catch {
    resolved = path.resolve(value)
  }
  return process.platform === "win32" ? resolved.toLowerCase() : resolved
}

function canonicalInvocation(invocation: { command: string; args: string[] }): { command: string; args: string[] } {
  return { command: canonicalPath(invocation.command), args: invocation.args.map(canonicalPath) }
}

function fixture(t: TestContext) {
  const root = mkdtempSync(path.join(tmpdir(), "ompiui-config space-"))
  const binDir = path.join(root, "bin space")
  const script = path.join(root, "cli space.mjs")
  const state = path.join(root, "roles.json")
  const shim = path.join(binDir, "omp.cmd")
  mkdirSync(binDir)
  writeFileSync(path.join(binDir, "omp"), "#!/bin/sh\nexit 99\n")
  const keys = ["OMPI_OMP_BIN", "OMP_AGENT_DIR", "PI_CODING_AGENT_DIR", "OMPI_TEST_ROLES_FILE", "PATH"]
  const previous = Object.fromEntries(keys.map(key => [key, process.env[key]]))
  t.after(() => {
    for (const key of keys) {
      if (previous[key] === undefined) delete process.env[key]
      else process.env[key] = previous[key]
    }
    rmSync(root, { recursive: true, force: true })
  })
  writeFileSync(script, `#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
import assert from "node:assert/strict";
assert.equal(process.env.PI_CODING_AGENT_DIR, ${JSON.stringify(path.join(root, "agent"))});
assert.notEqual(process.env.PI_CODING_AGENT_DIR, process.env.OMP_AGENT_DIR);
const [command, action, key, value] = process.argv.slice(2);
assert.equal(command, "config");
assert.equal(key, "modelRoles");
const file = process.env.OMPI_TEST_ROLES_FILE;
if (action === "set") writeFileSync(file, JSON.stringify(JSON.parse(value)));
else process.stdout.write(JSON.stringify({value: JSON.parse(readFileSync(file, "utf8"))}));
`)
  writeFileSync(shim, [
    "@ECHO off", "SET dp0=%~dp0", 'IF EXIST "%dp0%\\node.exe" (',
    'SET "_prog=%dp0%\\node.exe"', ") ELSE (", 'SET "_prog=node"', ")",
    `"%_prog%" "%dp0%${path.sep}..${path.sep}cli space.mjs" %*`,
  ].join("\r\n"))
  process.env.OMPI_TEST_ROLES_FILE = state
  process.env.OMP_AGENT_DIR = path.join(root, "must-not-use")
  process.env.PI_CODING_AGENT_DIR = path.join(root, "agent")
  return { root, binDir, script, state, shim }
}

test("standard npm shim resolves its script without interpreting JSON through a shell", t => {
  const f = fixture(t)
  assert.equal(resolveWindowsNpmShim(f.shim).args[0], f.script)
})

test("npm shim uses an adjacent runtime when present", { skip: process.platform !== "win32" }, t => {
  const f = fixture(t)
  const runtime = path.join(f.binDir, "node.exe")
  copyFileSync(process.execPath, runtime)
  assert.deepEqual(resolveWindowsNpmShim(f.shim), { command: runtime, args: [f.script] })
})

test("Bun CLI shebang selects Bun even when the host backend runs under Node", t => {
  const f = fixture(t)
  writeFileSync(f.script, "#!/usr/bin/env bun\n")
  assert.match(path.basename(resolveWindowsNpmShim(f.shim).command), /^bun(?:\.exe)?$/i)
})

test("an unknown batch wrapper reports how to configure a direct CLI", t => {
  const f = fixture(t)
  writeFileSync(f.shim, "@echo off\r\ncustom-launcher %*\r\n")
  assert.throws(() => resolveWindowsNpmShim(f.shim), /Set OMPI_OMP_BIN/)
})

test("explicit native executable is not replaced with PATH's OMP", t => {
  const f = fixture(t)
  const executable = path.join(f.binDir, "custom-omp.exe")
  process.env.OMPI_OMP_BIN = executable
  assert.deepEqual(canonicalInvocation(resolveOmpConfigCommand()), canonicalInvocation({ command: executable, args: [] }))
})

test("npm-installed Bun resolves through its executable shim before passing JSON", {
  skip: process.platform !== "win32" || installedRuntimeTakesPrecedence(),
}, async t => {
  const f = fixture(t)
  const runtime = path.join(f.binDir, "node_modules", "bun", "bin", "bun.exe")
  mkdirSync(path.dirname(runtime), { recursive: true })
  copyFileSync(process.execPath, runtime)
  writeFileSync(path.join(f.binDir, "bun.cmd"), [
    "@ECHO off",
    '"%dp0%\\node_modules\\bun\\bin\\bun.exe" %*',
  ].join("\r\n"))
  writeFileSync(path.join(f.binDir, "bun"), "#!/bin/sh\nexit 99\n")
  writeFileSync(f.script, readFileSync(f.script, "utf8").replace("#!/usr/bin/env node", "#!/usr/bin/env bun"))
  process.env.PATH = [f.binDir, path.join(process.env.SystemRoot!, "System32")].join(path.delimiter)
  process.env.OMPI_OMP_BIN = f.shim
  assert.deepEqual(canonicalInvocation(resolveOmpConfigCommand()), canonicalInvocation({ command: runtime, args: [f.script] }))
  const roles = { default: "chengming/[wb]deepseek-v4-flash:high", task: "chengming/[JT]gemini-4-argon" }
  const catalog = new OmpCatalog()
  t.after(() => catalog.dispose())
  assert.deepEqual(await catalog.setModelRoles(roles), roles)
  assert.deepEqual(await catalog.getModelRoles(), roles)
})

test("npm shim pointing directly to a native executable does not select an interpreter", t => {
  const f = fixture(t)
  const executable = path.join(f.binDir, "omp.exe")
  writeFileSync(executable, "")
  writeFileSync(f.shim, '@echo off\r\n"%~dp0omp.exe" %*\r\n')
  assert.deepEqual(canonicalInvocation(resolveWindowsNpmShim(f.shim)), canonicalInvocation({ command: executable, args: [] }))
})

test("unknown runtime wrappers fail before JSON can reach a batch file", {
  skip: process.platform !== "win32" || installedRuntimeTakesPrecedence(),
}, t => {
  const f = fixture(t)
  writeFileSync(f.script, "#!/usr/bin/env bun\n")
  writeFileSync(path.join(f.binDir, "bun.cmd"), "@echo off\r\ncustom-runtime %*\r\n")
  process.env.PATH = [f.binDir, path.join(process.env.SystemRoot!, "System32")].join(path.delimiter)
  process.env.OMPI_OMP_BIN = f.shim
  assert.throws(() => resolveOmpConfigCommand(), /Cannot locate a native runtime/)
})

for (const entry of ["script", "npm-shim", "path-shim"] as const) {
  test(`model roles save and read back through ${entry} with JSON preserved`, {
    skip: entry !== "script" && (process.platform !== "win32"
      || (entry === "path-shim" && installedRuntimeTakesPrecedence())),
  }, async t => {
    const f = fixture(t)
    if (entry === "path-shim") {
      delete process.env.OMPI_OMP_BIN
      copyFileSync(process.execPath, path.join(f.binDir, "node.exe"))
      process.env.PATH = [f.binDir, path.join(process.env.SystemRoot!, "System32")].join(path.delimiter)
      assert.deepEqual(canonicalInvocation(resolveOmpConfigCommand()), canonicalInvocation({ command: path.join(f.binDir, "node.exe"), args: [f.script] }))
    } else {
      process.env.OMPI_OMP_BIN = entry === "script" ? f.script : f.shim
    }
    const roles = {
      default: "provider/model:high",
      plan: 'provider/model with "quotes" & pipe|percent%PATH%^bang!:xhigh',
      task: "provider/model\\variant:max",
    }
    const catalog = new OmpCatalog()
    t.after(() => catalog.dispose())
    assert.deepEqual(await catalog.setModelRoles(roles), roles)
    assert.deepEqual(await catalog.getModelRoles(), roles)
    assert.deepEqual(JSON.parse(readFileSync(f.state, "utf8")), roles)
    await catalog.setModelRoles({})
    assert.deepEqual(await catalog.getModelRoles(), {})
  })
}
