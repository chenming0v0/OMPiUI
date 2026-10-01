import assert from "node:assert/strict"
import { mkdtemp, rm, writeFile, unlink } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { describe, it } from "node:test"
import { OmpModelsWatcher } from "./models-watcher.js"

const SETTLE_MS = 150
const WAIT_MS = 5_000

async function waitFor(predicate: () => boolean, timeoutMs = WAIT_MS): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("condition not met before timeout")
    await new Promise(resolve => setTimeout(resolve, 25))
  }
}

async function withTempModelsDir(run: (dir: string, file: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(path.join(tmpdir(), "ompiui-models-watcher-"))
  try {
    await run(dir, path.join(dir, "models.yml"))
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined)
  }
}

describe("OmpModelsWatcher", () => {
  it("fires once when models.yml content changes", async () => {
    await withTempModelsDir(async (_dir, file) => {
      await writeFile(file, "providers: {}\n")
      const watcher = new OmpModelsWatcher(file, 30)
      const events: number[] = []
      watcher.onChange(() => events.push(events.length))
      watcher.start()
      try {
        await new Promise(resolve => setTimeout(resolve, SETTLE_MS))
        assert.equal(events.length, 0)
        await writeFile(file, "providers: { openai: { apiKey: sk-test } }\n")
        await waitFor(() => events.length > 0)
        await new Promise(resolve => setTimeout(resolve, SETTLE_MS))
        assert.equal(events.length, 1, "one real change should fire exactly one debounced callback")
      } finally {
        watcher.dispose()
      }
    })
  })

  it("ignores unrelated files in the agent directory and identical rewrites", async () => {
    await withTempModelsDir(async (dir, file) => {
      await writeFile(file, "providers: {}\n")
      const watcher = new OmpModelsWatcher(file, 30)
      let fired = 0
      watcher.onChange(() => { fired += 1 })
      watcher.start()
      try {
        await new Promise(resolve => setTimeout(resolve, SETTLE_MS))
        await writeFile(path.join(dir, "agent.db"), "noise")
        await writeFile(file, "providers: {}\n") // 内容不变
        await new Promise(resolve => setTimeout(resolve, 400))
        assert.equal(fired, 0)
      } finally {
        watcher.dispose()
      }
    })
  })

  it("fires when models.yml is deleted", async () => {
    await withTempModelsDir(async (_dir, file) => {
      await writeFile(file, "providers: {}\n")
      const watcher = new OmpModelsWatcher(file, 30)
      let fired = 0
      watcher.onChange(() => { fired += 1 })
      watcher.start()
      try {
        await new Promise(resolve => setTimeout(resolve, SETTLE_MS))
        await unlink(file)
        await waitFor(() => fired > 0)
      } finally {
        watcher.dispose()
      }
    })
  })

  it("stops firing after dispose", async () => {
    await withTempModelsDir(async (_dir, file) => {
      await writeFile(file, "providers: {}\n")
      const watcher = new OmpModelsWatcher(file, 30)
      let fired = 0
      watcher.onChange(() => { fired += 1 })
      watcher.start()
      await new Promise(resolve => setTimeout(resolve, SETTLE_MS))
      watcher.dispose()
      await writeFile(file, "providers: { changed: true }\n")
      await new Promise(resolve => setTimeout(resolve, 400))
      assert.equal(fired, 0)
    })
  })
})
