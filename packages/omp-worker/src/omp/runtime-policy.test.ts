import assert from "node:assert/strict"
import { test } from "node:test"
import { RUNTIME_POLICY, SHELL_POLICY_EXTENSION } from "./runtime-policy.js"

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
