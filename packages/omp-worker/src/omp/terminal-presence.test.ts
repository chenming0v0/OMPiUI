import assert from "node:assert/strict"
import { test } from "node:test"
import { copyFileSync, mkdtempSync, rmSync } from "node:fs"
import { spawn } from "node:child_process"
import { once } from "node:events"
import { tmpdir } from "node:os"
import path from "node:path"
import { assertOmpTerminalStopped, assertTerminalInventory, isOmpTerminalProcess } from "./terminal-presence.js"

test("an idle OMP terminal still blocks session writes until its process exits", () => {
  const terminal = { pid: 42, name: "omp.exe", commandLine: '"C:\\Users\\user\\.bun\\bin\\omp.exe" --resume abc' }
  assert.equal(isOmpTerminalProcess(terminal), true)
  assert.throws(() => assertTerminalInventory([terminal]), { code: "SESSION_BUSY" })
  assert.doesNotThrow(() => assertTerminalInventory([]))
})

test("RPC processes and version probes do not block their own worker", () => {
  for (const args of ["--mode rpc", '--mode "rpc"', "--mode=rpc", "--mode rpc-ui", "--version"]) {
    assert.equal(isOmpTerminalProcess({ pid: 42, name: "omp.exe", commandLine: `"C:\\bin\\omp.exe" ${args}` }), false)
  }
})

test("Bun and Node CLI launches are recognized, unrelated processes are ignored", () => {
  assert.equal(isOmpTerminalProcess({ pid: 42, name: "bun", commandLine: "bun /repo/oh-my-pi/packages/coding-agent/src/cli.ts --continue" }), true)
  assert.equal(isOmpTerminalProcess({ pid: 42, name: "node", commandLine: "node /lib/node_modules/@oh-my-pi/pi-coding-agent/dist/cli.js" }), true)
  assert.equal(isOmpTerminalProcess({ pid: 42, name: "bun", commandLine: "bun /repo/oh-my-pi/packages/coding-agent/src/cli.ts --mode rpc" }), false)
  assert.equal(isOmpTerminalProcess({ pid: 42, name: "node", commandLine: "node /repo/ompiui/server.js" }), false)
})

test("an OMP process with unreadable arguments is not assumed to be stopped", () => {
  assert.throws(() => assertTerminalInventory([{ pid: 42, name: "omp.exe", commandLine: null }]), { code: "SESSION_BUSY" })
})

test("process probing blocks a live independent terminal process and permits writing after exit", { timeout: 30_000 }, async () => {
  const root = mkdtempSync(path.join(tmpdir(), "ompiui-terminal-process-"))
  const binary = path.join(root, process.platform === "win32" ? "omp.exe" : "omp")
  copyFileSync(process.execPath, binary)
  const child = spawn(binary, ["-e", "process.stdout.write('ready\\n'); setInterval(() => {}, 1000)"], {
    windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
  })
  const exited = once(child, "exit")
  try {
    await once(child.stdout!, "data")
    await assert.rejects(assertOmpTerminalStopped(), { code: "SESSION_BUSY" })
    child.kill()
    await exited
    await assertOmpTerminalStopped()
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill()
      await exited
    }
    rmSync(root, { recursive: true, force: true })
  }
})
