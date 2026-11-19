import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { test } from "node:test"

test("Node and Bun console errors and direct stderr are recorded exactly once", async t => {
  const runtimes = [{ name: "Node", bin: process.execPath, args: ["--import", "tsx", "--input-type=module"] }]
  if (spawnSync("bun", ["--version"], { windowsHide: true }).status === 0) {
    runtimes.push({ name: "Bun", bin: "bun", args: [] })
  }
  for (const runtime of runtimes) {
    await t.test(runtime.name, () => {
      const root = mkdtempSync(path.join(tmpdir(), "ompiui-worker-log-"))
      try {
        const logs = path.join(root, "logs")
        mkdirSync(logs)
        const expired = path.join(logs, "ompiui-server-2026-10-01.log")
        const expiresTomorrow = path.join(logs, "ompiui-server-2026-10-04.log")
        const unrelated = `${expired}.backup`
        const logNamedDirectory = path.join(logs, "ompiui-server-2026-10-02.log")
        mkdirSync(logNamedDirectory)
        utimesSync(logNamedDirectory, new Date("2026-10-01"), new Date("2026-10-01"))
        for (const [file, time] of [[expired, "2026-10-01"], [expiresTomorrow, "2026-10-04"], [unrelated, "2026-10-01"]] as const) {
          writeFileSync(file, "old\n")
          utimesSync(file, new Date(time), new Date(time))
        }
        const script = `
          import { existsSync } from "node:fs";
          import assert from "node:assert/strict";
          import { installWorkerFileLogging } from ${JSON.stringify(new URL("./worker-logger.ts", import.meta.url).href)};
          let now = Date.parse("2026-10-10T12:00:00Z");
          globalThis.Date = class extends Date {
            constructor(...args) { super(...(args.length ? args : [now])); }
            static now() { return now; }
          };
          const restore = installWorkerFileLogging();
          assert.ok(!existsSync(${JSON.stringify(expired)}));
          assert.ok(existsSync(${JSON.stringify(expiresTomorrow)}));
          console.error("probe-error", new Error("probe-stack"));
          console.warn("probe-warn");
          process.stderr.write(Buffer.from("probe-buffer\\n"));
          now += 86400000;
          console.warn("next-day-probe");
          restore();
        `
        const child = spawnSync(runtime.bin, [...runtime.args, "-e", script], {
          env: { ...process.env, OMPIUI_DATA_DIR: root, OMPIUI_FILE_LOG: "1", OMPIUI_LOG_KEEP_DAYS: "7" },
          encoding: "utf8", windowsHide: true, timeout: 10_000,
        })
        assert.equal(child.status, 0, child.stderr)
        assert.ok(!existsSync(expiresTomorrow))
        assert.ok(existsSync(unrelated))
        assert.ok(existsSync(logNamedDirectory))
        assert.match(readFileSync(path.join(logs, "ompiui-server-2026-10-11.log"), "utf8"), /next-day-probe/)
        const log = readFileSync(path.join(logs, "ompiui-server-2026-10-10.log"), "utf8")
        for (const marker of ["probe-error", "probe-warn", "probe-buffer"]) {
          assert.equal(log.split(marker).length - 1, 1, `${marker}: ${log}`)
        }
        assert.ok(log.includes("probe-stack"))
      } finally {
        rmSync(root, { recursive: true, force: true })
      }
    })
  }
})
