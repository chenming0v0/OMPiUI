import assert from "node:assert/strict"
import { copyFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import test from "node:test"
import { resolveOmpCommand } from "./omp-command.js"
import { resolveInstalledOmpRuntime } from "./omp-runtime.js"
import { OmpRpcClient } from "./rpc-client.js"

/**
 * 已安装的 OMP runtime（repo 根的 omp-runtime/）在解析时永远优先于 PATH shim。
 * 准备过 runtime 的开发机上无法到达「裸名走 PATH/npm shim」的解析路径，
 * 这组用例只在没有安装 runtime 的环境（CI）运行；runtime 存在或损坏都视为接管。
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

for (const entry of ["script", "environment-script", "npm-shim", "path-shim", "runtime-shim"] as const) {
  test(`RPC launches through ${entry} without shell interpretation`, {
    skip: process.platform !== "win32" || installedRuntimeTakesPrecedence(),
    timeout: 15_000,
  }, async t => {
    const root = mkdtempSync(path.join(tmpdir(), "ompiui rpc space-"))
    let client: OmpRpcClient | undefined
    t.after(async () => {
      await client?.close()
      // 刚退出的子进程或 Defender 可能短暂锁住临时目录；重试清理，避免把
      // 成功的用例误报成失败（EBUSY/EPERM/ENOTEMPTY 只在锁竞争时出现）。
      for (let attempt = 0; ; attempt++) {
        try {
          rmSync(root, { recursive: true, force: true })
          return
        } catch (error) {
          const code = (error as NodeJS.ErrnoException).code
          if (attempt >= 10 || code !== "EBUSY" && code !== "EPERM" && code !== "ENOTEMPTY") throw error
          await new Promise(resolve => setTimeout(resolve, 100))
        }
      }
    })
    const binDir = path.join(root, "bin space")
    mkdirSync(binDir)
    writeFileSync(path.join(root, "package.json"), '{"type":"commonjs"}')
    const script = path.join(root, "cli space.js")
    const shim = path.join(binDir, "omp.cmd")
    writeFileSync(script, `#!/usr/bin/env bun
const readline = require("node:readline");
const args = process.argv.slice(2);
const lines = readline.createInterface({ input: process.stdin });
lines.on("line", line => {
  const command = JSON.parse(line);
  process.stdout.write(JSON.stringify({
    type: "response", id: command.id, command: command.type, success: true,
    data: { args, cwd: process.cwd(), marker: process.env.OMPI_LAUNCH_MARKER }
  }) + "\\n");
});
`)
    writeFileSync(path.join(binDir, "omp"), "#!/bin/sh\nexit 99\n")
    writeFileSync(shim, '@echo off\r\n"%~dp0..\\cli space.js" %*\r\n')
    let runtime = path.join(binDir, "bun.exe")
    if (entry === "runtime-shim") {
      runtime = path.join(binDir, "node_modules", "bun", "bin", "bun.exe")
      mkdirSync(path.dirname(runtime), { recursive: true })
      writeFileSync(path.join(binDir, "bun"), "#!/bin/sh\nexit 99\n")
      writeFileSync(path.join(binDir, "bun.cmd"), '@echo off\r\n"%~dp0node_modules\\bun\\bin\\bun.exe" %*\r\n')
    }
    copyFileSync(process.execPath, runtime)
    const env = {
      ...process.env,
      PATH: [binDir, path.join(process.env.SystemRoot!, "System32")].join(path.delimiter),
      OMPI_LAUNCH_MARKER: "child environment",
      NODE_TEST_CONTEXT: undefined,
      OMPI_OMP_BIN: entry === "environment-script" ? script : undefined,
    }
    const bin = entry === "script" ? script : entry === "path-shim" || entry === "environment-script" ? undefined : shim
    assert.deepEqual(canonicalInvocation(resolveOmpCommand(bin ?? env.OMPI_OMP_BIN, env)), canonicalInvocation({ command: runtime, args: [script] }))
    const session = path.join(root, "session & percent%value! space.jsonl")
    const extra = ["--session", session, "--settings", '{"name":"quoted & value"}']
    client = new OmpRpcClient({ cwd: root, bin, args: extra, env })
    const result = await client.request({ type: "get_state" }, 5_000)
    const data = result.data as { args: string[]; cwd: string; marker: string }
    assert.deepEqual(data.args.slice(0, 2), ["--mode", "rpc"])
    assert.deepEqual(data.args.slice(-extra.length), extra)
    assert.equal(canonicalPath(data.cwd), canonicalPath(root))
    assert.equal(data.marker, env.OMPI_LAUNCH_MARKER)
  })
}

test("Windows rejects a PATH containing only the POSIX npm shim", {
  skip: process.platform !== "win32",
}, t => {
  const root = mkdtempSync(path.join(tmpdir(), "ompiui posix shim-"))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  writeFileSync(path.join(root, "omp"), "#!/bin/sh\nexit 99\n")
  assert.throws(() => resolveOmpCommand("omp", {
    ...process.env,
    PATH: [root, path.join(process.env.SystemRoot!, "System32")].join(path.delimiter),
  }), /Cannot locate a Windows executable/)
})

test("Windows still prefers a native OMP over npm shims", {
  skip: process.platform !== "win32",
}, t => {
  const root = mkdtempSync(path.join(tmpdir(), "ompiui native priority-"))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const executable = path.join(root, "omp.exe")
  writeFileSync(executable, "")
  writeFileSync(path.join(root, "omp"), "#!/bin/sh\nexit 99\n")
  writeFileSync(path.join(root, "omp.cmd"), "@echo off\r\nexit /b 99\r\n")
  assert.deepEqual(canonicalInvocation(resolveOmpCommand("omp", {
    ...process.env,
    PATH: [root, path.join(process.env.SystemRoot!, "System32")].join(path.delimiter),
  })), canonicalInvocation({ command: executable, args: [] }))
})
