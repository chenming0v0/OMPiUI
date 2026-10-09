import assert from "node:assert/strict"
import { test } from "node:test"
import { mkdtempSync, readdirSync, readFileSync, writeFileSync, rmSync, utimesSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { DiagnosticRecorder, summarizeRunState, type DiagnosticFields } from "./recorder.ts"

function fixture(t: { after: (fn: () => void) => void }) {
  const directory = mkdtempSync(join(tmpdir(), "ompiui-diagnostic-test-"))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const read = () => readdirSync(directory).filter(name => name.endsWith(".jsonl"))
    .flatMap(name => readFileSync(join(directory, name), "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line)))
  return { directory, read }
}

test("diagnostics correlates events and never records payloads, tokens or stacks", t => {
  const { directory, read } = fixture(t)
  const recorder = new DiagnosticRecorder({ directory })
  recorder.record("session.close", {
    sessionId: "s1", reason: "token=private-value", commandId: "c1",
    params: { text: "PRIVATE PROMPT" }, token: "SECRET TOKEN",
    error: new Error("PRIVATE STACK"), state: { isStreaming: true, goalStatus: "password=secret" },
  } as DiagnosticFields)
  recorder.record("session.closed", { sessionId: "s1" })
  const rows = read().sort((a, b) => a.seq - b.seq)
  assert.equal(rows.length, 2)
  assert.equal(rows[0].runId, rows[1].runId)
  assert.equal(rows[0].seq, 1)
  assert.equal(rows[1].seq, 2)
  assert.equal(rows[0].reason, "token=[REDACTED]")
  assert.equal(rows[0].state.goalStatus, "password=[REDACTED]")
  assert.equal(rows[0].params, undefined)
  assert.equal(rows[0].token, undefined)
  assert.equal(rows[0].error, undefined)
  assert.ok(!JSON.stringify(rows).includes("PRIVATE"))
  assert.deepEqual(summarizeRunState({ isStreaming: false, pendingMessageCount: 2, goal: { status: "active", objective: "PRIVATE" } }), {
    isStreaming: false, pendingMessageCount: 2, goalStatus: "active",
  })
})

test("diagnostics rotates, caps files, expires old parts and preserves unrelated files", t => {
  const { directory, read } = fixture(t)
  writeFileSync(join(directory, "keep.txt"), "keep")
  const old = join(directory, "diagnostic-2020-01-01_12345678-1234_000001.jsonl")
  writeFileSync(old, "{}\n")
  utimesSync(old, new Date("2020-01-01"), new Date("2020-01-01"))
  let now = Date.parse("2026-10-09T10:00:00Z")
  const recorder = new DiagnosticRecorder({ directory, maxBytes: 350, maxFiles: 2, now: () => now })
  for (let index = 0; index < 8; index++) recorder.record("test.event", { sessionId: "session", count: index })
  now += 86_400_000
  recorder.record("next.day")
  const files = readdirSync(directory)
  assert.equal(files.filter(name => name.endsWith(".jsonl")).length, 2)
  assert.ok(files.includes("keep.txt"))
  assert.ok(!files.includes(old.split(/[\\/]/).at(-1)!))
  assert.ok(read().some(row => row.event === "next.day"))
})

test("diagnostics honors disabled/level settings and survives write failure", t => {
  const { directory, read } = fixture(t)
  new DiagnosticRecorder({ directory, enabled: false }).record("disabled")
  const recorder = new DiagnosticRecorder({ directory, level: "warn" })
  recorder.record("hidden", {}, "info")
  recorder.record("visible", {}, "warn")
  assert.deepEqual(read().map(row => row.event), ["visible"])
  const file = join(directory, "not-a-directory")
  writeFileSync(file, "file")
  const invalid = new DiagnosticRecorder({ directory: file })
  assert.doesNotThrow(() => invalid.record("write.failed"))
})
