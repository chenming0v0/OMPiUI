import assert from "node:assert/strict"
import { test } from "node:test"
import { mkdtempSync, writeFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { queryDiagnostics } from "./diagnostic-query.mjs"

test("query merges runs, filters sessions and levels, keeps server context and tolerates incomplete tails", async t => {
  const directory = mkdtempSync(join(tmpdir(), "ompiui-query-test-"))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const row = (event, seconds, extra = {}) => ({
    schemaVersion: 1, time: `2026-10-09T10:00:0${seconds}Z`, runId: "run-1", seq: seconds,
    pid: 1, level: "info", event, ...extra,
  })
  writeFileSync(join(directory, "diagnostic-a.jsonl"), [
    row("server.started", 1), row("agent.event", 4, { sessionId: "s1" }),
    row("agent.event", 3, { sessionId: "s2" }),
  ].map(JSON.stringify).join("\n") + '\n{"truncated"')
  writeFileSync(join(directory, "diagnostic-b.jsonl"), [
    row("worker.exited", 5, { sessionIds: ["s1"], level: "error" }),
    row("session.activity", 2, { sessionId: "s1" }),
  ].map(JSON.stringify).join("\n"))
  const result = await queryDiagnostics(directory, { session: "s1", limit: 3 })
  assert.deepEqual(result.records.map(record => record.event), ["session.activity", "agent.event", "worker.exited"])
  assert.equal(result.malformed, 1)
  assert.equal((await queryDiagnostics(directory, { session: "s1", level: "warn" })).records.length, 1)
  assert.equal((await queryDiagnostics(directory, { event: "server" })).records.length, 1)
  await assert.rejects(queryDiagnostics(directory, { since: "bad" }))
})
