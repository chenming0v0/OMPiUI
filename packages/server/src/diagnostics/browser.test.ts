import assert from "node:assert/strict"
import { test } from "node:test"
import { recordBrowserDiagnostic } from "./browser.ts"
import { diagnostics } from "./recorder.ts"
import type { BrowserDiagnosticMessage } from "@ompiui/protocol"

test("browser diagnostics accept only known events for subscribed sessions", t => {
  const calls: unknown[][] = []
  t.mock.method(diagnostics, "record", (...args: unknown[]) => { calls.push(args) })
  const base: BrowserDiagnosticMessage = {
    type: "diagnostic", protocolVersion: 1, clientId: "page-1", event: "state",
    sessionId: "session-1", state: { isStreaming: true },
  }
  assert.equal(recordBrowserDiagnostic(base, "connection-1", ["session-1"]), "page-1")
  assert.equal(recordBrowserDiagnostic({ ...base, sessionId: "another-session" }, "connection-1", ["session-1"]), undefined)
  assert.equal(recordBrowserDiagnostic({ ...base, event: "not-allowed" as never }, "connection-1", ["session-1"]), undefined)
  assert.equal(calls.length, 1)
  assert.equal(calls[0][0], "browser.state")
})
