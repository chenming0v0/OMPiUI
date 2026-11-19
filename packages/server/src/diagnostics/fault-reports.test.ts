import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import test from "node:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { FaultReportService } from "./fault-reports.ts"
import { DiagnosticRecorder } from "./recorder.ts"

test("server log pruning runs at startup and UTC rollover, with no duplicate Node writes", t => {
  const root = mkdtempSync(join(tmpdir(), "ompiui-server-log-"))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const logs = join(root, "logs")
  mkdirSync(logs)
  const expired = join(logs, "ompiui-server-2026-10-01.log")
  const expiresTomorrow = join(logs, "ompiui-server-2026-10-04.log")
  const unrelated = `${expired}.backup`
  const logNamedDirectory = join(logs, "ompiui-server-2026-10-02.log")
  mkdirSync(logNamedDirectory)
  utimesSync(logNamedDirectory, new Date("2026-10-01"), new Date("2026-10-01"))
  for (const [file, time] of [[expired, "2026-10-01"], [expiresTomorrow, "2026-10-04"], [unrelated, "2026-10-01"]] as const) {
    writeFileSync(file, "old\n")
    utimesSync(file, new Date(time), new Date(time))
  }
  const script = `
    import { existsSync } from "node:fs";
    import assert from "node:assert/strict";
    import { enableFileLogging, logToFile } from ${JSON.stringify(new URL("../logger.ts", import.meta.url).href)};
    let now = Date.parse("2026-10-10T12:00:00Z");
    globalThis.Date = class extends Date {
      constructor(...args) { super(...(args.length ? args : [now])); }
      static now() { return now; }
    };
    const restore = enableFileLogging();
    assert.ok(!existsSync(${JSON.stringify(expired)}));
    assert.ok(existsSync(${JSON.stringify(expiresTomorrow)}));
    console.info("mirrored-info");
    logToFile("mirrored-info");
    console.warn("mirrored-warn");
    logToFile("mirrored-warn");
    logToFile("explicit-only");
    logToFile("repeated-explicit");
    logToFile("repeated-explicit");
    console.error("console-only");
    await Promise.resolve();
    logToFile("console-only");
    restore();
    console.warn("not-logged-after-restore");
    const restoreAgain = enableFileLogging();
    console.warn("after-reenable");
    now += 86400000;
    logToFile("next-day-probe");
    restoreAgain();
  `
  const child = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
    env: { ...process.env, OMPIUI_DATA_DIR: root, OMPIUI_FILE_LOG: "1", OMPIUI_LOG_KEEP_DAYS: "7" },
    encoding: "utf8", windowsHide: true, timeout: 10_000,
  })
  assert.equal(child.status, 0, child.stderr)
  assert.ok(!existsSync(expiresTomorrow))
  assert.ok(existsSync(unrelated))
  assert.ok(existsSync(logNamedDirectory))
  assert.match(readFileSync(join(logs, "ompiui-server-2026-10-11.log"), "utf8"), /next-day-probe/)
  const log = readFileSync(join(logs, "ompiui-server-2026-10-10.log"), "utf8")
  for (const marker of ["mirrored-info", "mirrored-warn", "explicit-only", "after-reenable"]) {
    assert.equal(log.split(marker).length - 1, 1, `${marker}: ${log}`)
  }
  assert.equal(log.split("console-only").length - 1, 2)
  assert.equal(log.split("repeated-explicit").length - 1, 2)
  assert.doesNotMatch(log, /not-logged-after-restore/)
})

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

test("one raw byte budget covers filtered content across diagnostics and server logs", async t => {
  const root = mkdtempSync(join(tmpdir(), "ompiui-fault-budget-"))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const dir = join(root, "logs", "diagnostics")
  const legacy = join(root, "legacy-logs")
  mkdirSync(dir, { recursive: true })
  mkdirSync(legacy)
  const diagnostic = JSON.stringify({ schemaVersion: 1, time: new Date().toISOString(), event: "worker.exited", body: "private text ".repeat(80) }) + "\n"
  const noisy = `[ompiui-server] console payload ${"private text ".repeat(80)}\n`
  const fiveMiB = (line: string) => line.repeat(Math.ceil(5 * 1024 * 1024 / Buffer.byteLength(line)))
  writeFileSync(join(dir, "diagnostic-2026-10-11_abcd_000002.jsonl"), fiveMiB(diagnostic))
  const recentName = "piui-server-2026-10-11.log"
  writeFileSync(join(legacy, recentName), "[ompiui-server] listening early\n" + fiveMiB(noisy) + "[omp-worker] worker process stopped\n")
  const oldName = "ompiui-server-2026-10-10.log"
  const old = join(root, "logs", oldName)
  writeFileSync(old, "[omp-worker] heartbeat missing\n")
  utimesSync(old, new Date("2026-10-10"), new Date("2026-10-10"))
  const recentTime = new Date("2026-10-11")
  utimesSync(join(legacy, recentName), recentTime, recentTime)

  const { report } = await new FaultReportService(root, [legacy]).collect()
  assert.equal(report.files, 2)
  assert.equal(report.complete, false)
  assert.ok(report.unavailable.includes(`${recentName}: earlier_records_omitted`))
  assert.ok(report.unavailable.includes(`${oldName}: report_size_limit`))
  assert.match(report.content, /worker\.exited/)
  assert.match(report.content, /worker process stopped/)
  assert.doesNotMatch(report.content, /listening|heartbeat missing|private text/)
})

test("recent run data wins over random filename order and older file tails stay chronological", async t => {
  const root = mkdtempSync(join(tmpdir(), "ompiui-fault-recent-"))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const dir = join(root, "logs", "diagnostics")
  mkdirSync(dir, { recursive: true })
  const row = (event: string) => JSON.stringify({
    schemaVersion: 1, time: new Date().toISOString(), event, body: "private text ".repeat(80),
  }) + "\n"
  const filler = row("worker.started")
  const padding = filler.repeat(Math.ceil(5 * 1024 * 1024 / Buffer.byteLength(filler)))
  const recent = join(dir, "diagnostic-2026-10-11_aaaa_000001.jsonl")
  const olderName = "diagnostic-2026-10-11_ffff_000001.jsonl"
  const older = join(dir, olderName)
  writeFileSync(recent, row("recent.run") + padding)
  writeFileSync(older, row("old.head") + padding + row("old.tail.first") + row("old.tail.last"))
  utimesSync(recent, new Date("2026-10-11T12:00:00Z"), new Date("2026-10-11T12:00:00Z"))
  utimesSync(older, new Date("2026-10-11T11:00:00Z"), new Date("2026-10-11T11:00:00Z"))

  const { report } = await new FaultReportService(root, []).collect()
  assert.equal(report.files, 2)
  assert.equal(report.complete, false)
  assert.ok(report.unavailable.includes(`${olderName}: earlier_records_omitted`))
  assert.match(report.content, /recent\.run/)
  assert.doesNotMatch(report.content, /old\.head|private text/)
  assert.ok(report.content.indexOf("old.tail.first") < report.content.indexOf("old.tail.last"))
  assert.match(report.content, /old\.tail\.first/)
})

test("the output budget keeps the newest records rather than the start of a file tail", async t => {
  const root = mkdtempSync(join(tmpdir(), "ompiui-fault-output-"))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const dir = join(root, "logs", "diagnostics")
  mkdirSync(dir, { recursive: true })
  const row = (event: string, reason = "") => JSON.stringify({ schemaVersion: 1, time: "2026-10-11T12:00:00Z", event, reason }) + "\n"
  const limit = 8 * 1024 * 1024
  const filler = row("worker.started")
  const oldest = row("oldest.boundary")
  const newest = row("newest.boundary")
  const count = Math.floor((limit - Buffer.byteLength(oldest + newest)) / Buffer.byteLength(filler))
  const padding = limit - Buffer.byteLength(oldest + newest) - count * Buffer.byteLength(filler)
  const name = "diagnostic-2026-10-11_abcd_000001.jsonl"
  writeFileSync(join(dir, name), row("oldest.boundary", " ".repeat(padding)) + filler.repeat(count) + newest)

  const { report } = await new FaultReportService(root, []).collect()
  assert.equal(report.complete, false)
  assert.ok(report.unavailable.includes(`${name}: report_size_limit`))
  assert.match(report.content, /newest\.boundary/)
  assert.doesNotMatch(report.content, /oldest\.boundary/)
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
