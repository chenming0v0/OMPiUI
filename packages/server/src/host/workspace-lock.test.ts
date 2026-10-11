import assert from "node:assert/strict"
import { mkdtempSync, rmSync } from "node:fs"
import { spawn } from "node:child_process"
import { tmpdir } from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import test from "node:test"
import { acquireWorkspaceMutationLock } from "./workspace-lock.ts"

test("workspace mutation lock coordinates independent Node processes", async () => {
  const namespace = mkdtempSync(path.join(tmpdir(), "ompiui-workspace-lock-"))
  const workspace = mkdtempSync(path.join(tmpdir(), "ompiui-workspace-root-"))
  const childScript = [
    'import { once } from "node:events"',
    'import { acquireWorkspaceMutationLock } from "./src/host/workspace-lock.ts"',
    'const lock = await acquireWorkspaceMutationLock(process.env.OMPIUI_TEST_ROOT, { namespace: process.env.OMPIUI_TEST_NAMESPACE })',
    'const release = once(process.stdin, "data")',
    'process.stdout.write("ready\\n")',
    'await release',
    'lock.release()',
  ].join(";")
  const child = spawn(process.execPath, ["--import", "tsx", "-e", childScript], {
    cwd: path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../.."),
    env: { ...process.env, OMPIUI_TEST_ROOT: workspace, OMPIUI_TEST_NAMESPACE: namespace },
    stdio: ["pipe", "pipe", "pipe"],
  })
  // 启动时就监听退出；固定延时释放会让慢 runner 错过 exit 或锁持有窗口。
  const exited = new Promise<number | null>((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill()
      reject(new Error("child did not finish lock handoff"))
    }, 10_000)
    child.once("exit", code => { clearTimeout(timer); resolve(code) })
    child.once("error", error => { clearTimeout(timer); reject(error) })
  })
  void exited.catch(() => undefined)
  let output = ""
  child.stdout.setEncoding("utf8")
  child.stdout.on("data", chunk => { output += chunk })
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`child did not acquire lock: ${output}`)), 5_000)
      child.stdout.on("data", () => {
        if (!output.includes("ready")) return
        clearTimeout(timer)
        resolve()
      })
      child.once("error", reject)
      child.once("exit", code => {
        clearTimeout(timer)
        reject(new Error(`child exited before lock handoff: ${code}`))
      })
    })
    await assert.rejects(
      acquireWorkspaceMutationLock(workspace, { namespace, timeoutMs: 100 }),
      { code: "WORKSPACE_BUSY" },
    )
    child.stdin.end("release\n")
    assert.equal(await exited, 0)
    const lock = await acquireWorkspaceMutationLock(workspace, { namespace, timeoutMs: 500 })
    lock.release()
  } finally {
    child.kill()
    rmSync(namespace, { recursive: true, force: true })
    rmSync(workspace, { recursive: true, force: true })
  }
})
