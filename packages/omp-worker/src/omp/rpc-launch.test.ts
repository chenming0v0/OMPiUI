import assert from "node:assert/strict"
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import test from "node:test"
import { resolveOmpCommand } from "./omp-command.js"
import { OmpRpcClient } from "./rpc-client.js"

for (const entry of ["script", "environment-script", "npm-shim", "path-shim", "runtime-shim"] as const) {
  test(`RPC launches through ${entry} without shell interpretation`, {
    skip: process.platform !== "win32",
    timeout: 15_000,
  }, async t => {
    const root = mkdtempSync(path.join(tmpdir(), "ompiui rpc space-"))
    let client: OmpRpcClient | undefined
    t.after(async () => {
      await client?.close()
      rmSync(root, { recursive: true, force: true })
    })
    const binDir = path.join(root, "bin space")
    mkdirSync(binDir)
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
    assert.deepEqual(resolveOmpCommand(bin ?? env.OMPI_OMP_BIN, env), { command: runtime, args: [script] })
    const session = path.join(root, "session & percent%value! space.jsonl")
    const extra = ["--session", session, "--settings", '{"name":"quoted & value"}']
    client = new OmpRpcClient({ cwd: root, bin, args: extra, env })
    const result = await client.request({ type: "get_state" }, 5_000)
    const data = result.data as { args: string[]; cwd: string; marker: string }
    assert.deepEqual(data.args.slice(0, 2), ["--mode", "rpc"])
    assert.deepEqual(data.args.slice(-extra.length), extra)
    assert.equal(data.cwd, root)
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
  assert.deepEqual(resolveOmpCommand("omp", {
    ...process.env,
    PATH: [root, path.join(process.env.SystemRoot!, "System32")].join(path.delimiter),
  }), { command: executable, args: [] })
})
