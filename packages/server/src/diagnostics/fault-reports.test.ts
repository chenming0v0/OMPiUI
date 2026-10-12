import assert from "node:assert/strict"
import test from "node:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { FaultReportService } from "./fault-reports.ts"
import { DiagnosticRecorder } from "./recorder.ts"

test("reports retained diagnostics and safe lifecycle logs, not transcripts or secrets", async t => {
  const root = mkdtempSync(join(tmpdir(), "ompiui-fault-report-"))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const dir = join(root, "logs", "diagnostics")
  mkdirSync(dir, { recursive: true })
  const recorder = new DiagnosticRecorder({ directory: dir })
  recorder.record("session.crashed", {
    sessionId: "session-test", errorCode: "SESSION_RUNTIME_CRASHED",
    workerPid: 12345, code: 1, signal: "SIGKILL", reason: "unexpected_exit",
  }, "error")
  writeFileSync(join(root, "logs", "ompiui-server-2026-10-11.log"), [
    '[2026-10-11T01:00:00.000Z] [omp-worker] heartbeat missing for 3 consecutive ticks (pid=123)',
    '[2026-10-11T01:00:00.000Z] [ompiui-server] listening https://private.example/?token=PRIVATE_TOKEN',
    '[2026-10-11T01:00:00.000Z] [ompiui-server] runtime recovery failed for s1: PRIVATE_MODEL_TEXT',
    '[2026-10-11T01:00:00.000Z] [ompiui-server] graceful shutdown hook failed Error: save failed for session 9f2c in D:\\clients\\acme-confidential\\sessions',
    '[2026-10-11T01:00:00.000Z] [omp-worker] command session.prompt timed out after 5000ms (misses=2); discarding command, worker stays acme-confidential',
    '[2026-10-11T01:00:00.000Z] [ompiui-server] shutdown exceeded 5000ms; closing active HTTP connections \\\\fileserver\\profiles\\bob\\secret.txt',
    'User prompt: PRIVATE_CHAT_TEXT', 'Bearer PRIVATE_AUTH',
  ].join("\n"))
  writeFileSync(join(dir, "diagnostic-2026-10-11_abcd_000001.jsonl"), JSON.stringify({
    schemaVersion: 1, time: new Date().toISOString(), event: "worker.exited", pid: 123, seq: 1,
    body: "PRIVATE_BODY", args: "PRIVATE_ARGS", token: "PRIVATE_JSON_TOKEN", message: "PRIVATE_MESSAGE",
    state: { isStreaming: true, body: "PRIVATE_STATE" },
  }) + "\n")
  const service = new FaultReportService(root, [])
  const { report } = await service.collect()
  assert.equal(report.complete, true)
  assert.ok(report.content.includes("session.crashed"))
  assert.ok(report.content.includes('"reason":"unexpected_exit"'))
  assert.ok(report.content.includes('"workerPid":12345'))
  assert.ok(report.content.includes('"code":1'))
  assert.ok(report.content.includes("[ompiui-server] graceful shutdown"))
  assert.ok(report.content.includes("[omp-worker] command timed out"))
  assert.ok(report.content.includes("worker.exited"))
  assert.ok(report.content.includes('"isStreaming":true'))
  assert.ok(!report.content.includes("PRIVATE_"))
  for (const leaked of ["acme-confidential", "9f2c", "D:\\\\clients", "fileserver", "secret.txt", "PRIVATE_"]) assert.ok(!report.content.includes(leaked), `must not leak ${leaked}`)
  assert.equal(report.files, 3)
})

test("missing logs are explicitly incomplete and status stays available without reading files", async t => {
  const root = mkdtempSync(join(tmpdir(), "ompiui-fault-missing-"))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const service = new FaultReportService(root, [])
  const status = service.status()
  assert.ok(status.runId)
  assert.deepEqual(status.faults, [])
  const { report } = await service.collect()
  assert.equal(report.complete, false)
  assert.ok(report.unavailable.includes("diagnostic_directory_unavailable"))
  assert.ok(report.unavailable.includes("no_retained_diagnostic_records"))
})

test("fault notices survive disabled recording and a disk write failure", () => {
  const recorder = new DiagnosticRecorder({ directory: "\0", enabled: false })
  recorder.record("session.crashed", { sessionId: "crashed", errorCode: "RUNTIME_CRASHED" }, "error")
  assert.equal(recorder.recentFaults()[0]?.sessionId, "crashed")
  assert.equal(recorder.recentFaults()[0]?.errorCode, "RUNTIME_CRASHED")
})
