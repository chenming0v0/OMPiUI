import assert from "node:assert/strict"
import { existsSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { test } from "node:test"
import { RUNTIME_POLICY, SHELL_POLICY_EXTENSION, runtimePolicyArgs } from "./runtime-policy.js"

test("runtime policy args do not require OMP npm sources for a standalone binary (#390)", () => {
  // Lite: a standalone official CLI has no package.json / src tree next to it.
  const root = mkdtempSync(path.join(tmpdir(), "ompiui-policy-"))
  const previous = process.env.OMPIUI_DATA_DIR
  process.env.OMPIUI_DATA_DIR = path.join(root, "data")
  try {
    const bin = path.join(root, "bin", process.platform === "win32" ? "omp.exe" : "omp")
    const env = { PATH: path.dirname(bin), OMPI_OMP_BIN: bin }
    const args = runtimePolicyArgs(bin, env)
    assert.equal(args.length, 6)
    assert.deepEqual([args[0], args[2], args[4]], ["--config", "--extension", "--extension"])
    for (const file of [args[1], args[3], args[5]]) assert.ok(existsSync(file!), file)
    assert.match(path.basename(args[5]!), /^runtime-bridge-[0-9a-f]{16}\.mjs$/)
  } finally {
    if (previous === undefined) delete process.env.OMPIUI_DATA_DIR
    else process.env.OMPIUI_DATA_DIR = previous
    rmSync(root, { recursive: true, force: true })
  }
})

test("managed bash rejects only unbounded foreground PTY calls before execution", async () => {
  // Exercise the CLI-loaded extension module without requiring an installed SDK.
  const module = await import(`data:text/javascript;base64,${Buffer.from(SHELL_POLICY_EXTENSION).toString("base64")}`)
  let handler!: (event: { toolName: string; input: Record<string, unknown> }) => { block: boolean; reason: string } | undefined
  module.default({ on: (_event: string, callback: typeof handler) => { handler = callback } })
  const blocked = handler({ toolName: "bash", input: { command: "node server.mjs", pty: true, timeout: 0 } })
  assert.equal(blocked?.block, true)
  for (const input of [
    { pty: false, timeout: 0 },
    { timeout: 0 },
    { pty: true, timeout: 3600 },
    { pty: true },
    { pty: true, timeout: 0, async: true },
    { pty: true, name: "server", ready: { timeout: 1 } },
  ]) {
    assert.equal(handler({ toolName: "bash", input }), undefined)
  }
  assert.equal(handler({ toolName: "eval", input: { pty: true, timeout: 0 } }), undefined)
})

test("runtime policy keeps autoResume only and leaves native subagent recursion depth untouched", () => {
  // #372: the managed UI must not override the user's native task.maxRecursionDepth.
  assert.match(RUNTIME_POLICY, /autoResume:\s*false/)
  assert.doesNotMatch(RUNTIME_POLICY, /maxRecursionDepth/)
})
