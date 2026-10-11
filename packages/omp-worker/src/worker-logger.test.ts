import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
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
        const script = `
          import { installWorkerFileLogging } from ${JSON.stringify(new URL("./worker-logger.ts", import.meta.url).href)};
          const restore = installWorkerFileLogging();
          console.error("probe-error", new Error("probe-stack"));
          console.warn("probe-warn");
          process.stderr.write(Buffer.from("probe-buffer\\n"));
          restore();
        `
        const child = spawnSync(runtime.bin, [...runtime.args, "-e", script], {
          env: { ...process.env, OMPIUI_DATA_DIR: root, OMPIUI_FILE_LOG: "1" },
          encoding: "utf8", windowsHide: true, timeout: 10_000,
        })
        assert.equal(child.status, 0, child.stderr)
        const log = readFileSync(path.join(root, "logs", `ompiui-server-${new Date().toISOString().slice(0, 10)}.log`), "utf8")
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
