import assert from "node:assert/strict"
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { after, afterEach, describe, it } from "node:test"
import {
  createWorkspaceEntry,
  deleteWorkspaceEntry,
  listFiles,
  moveWorkspaceEntry,
  readFileContent,
  writeFileContent,
} from "./files.ts"
import { WorkspaceStore, type WorkspaceRecord } from "./workspace-store.ts"
import { acquireWorkspaceMutationLock } from "./workspace-lock.ts"
import { HostRuntime } from "./command-table.ts"

const roots: string[] = []
const previousDataDir = process.env.OMPIUI_DATA_DIR
const dataDir = mkdtempSync(path.join(tmpdir(), "ompiui-file-locks-"))
process.env.OMPIUI_DATA_DIR = dataDir
after(() => {
  if (previousDataDir === undefined) delete process.env.OMPIUI_DATA_DIR
  else process.env.OMPIUI_DATA_DIR = previousDataDir
  rmSync(dataDir, { recursive: true, force: true })
})
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe("workspace files", () => {
  it("lists deterministically with bounded cursor pagination", async () => {
    const { root, workspace } = fixture()
    mkdirSync(path.join(root, "folder"))
    for (const name of ["c.txt", "a.txt", "b.txt"]) writeFileSync(path.join(root, name), name)

    const first = await listFiles(workspace, "", { limit: 2 })
    assert.equal(first.total, 4)
    assert.equal(first.truncated, true)
    assert.ok(first.nextCursor)
    const second = await listFiles(workspace, "", { limit: 2, cursor: first.nextCursor })
    assert.equal(second.truncated, false)
    assert.deepEqual(
      [...first.entries, ...second.entries].map(entry => entry.name).sort(),
      ["a.txt", "b.txt", "c.txt", "folder"],
    )
    await assert.rejects(listFiles(workspace, "", { cursor: "%%%" }), /invalid directory cursor/)
  })

  it("round-trips UTF-8 and binary files with metadata", async () => {
    const { root, workspace } = fixture()
    writeFileSync(path.join(root, "hello.txt"), "你好 PiUI\n")
    writeFileSync(path.join(root, "image.png"), Buffer.from([0, 1, 2, 255]))

    const text = await readFileContent(workspace, "hello.txt")
    assert.equal(text.type, "text")
    assert.equal(text.encoding, "utf-8")
    assert.equal(text.mimeType, "text/plain")
    const binary = await readFileContent(workspace, "image.png")
    assert.equal(binary.type, "binary")
    assert.equal(binary.encoding, "base64")
    assert.deepEqual(Buffer.from(binary.content, "base64"), Buffer.from([0, 1, 2, 255]))
    writeFileSync(path.join(root, " spaced .txt"), "exact")
    assert.equal((await readFileContent(workspace, " spaced .txt")).content, "exact")
  })

  it("pages long directory names within the byte limit without skipping entries", async () => {
    const { root, workspace } = fixture()
    for (let i = 0; i < 2000; i++) writeFileSync(path.join(root, `${String(i).padStart(4, "0")}-${"x".repeat(160)}.txt`), "")
    let cursor: string | undefined
    const names = new Set<string>()
    let pages = 0
    do {
      const page = await listFiles(workspace, "", { limit: 2000, cursor })
      assert.ok(Buffer.byteLength(JSON.stringify(page)) <= 512 * 1024)
      for (const entry of page.entries) {
        assert.equal(names.has(entry.name), false)
        names.add(entry.name)
      }
      cursor = page.nextCursor
      pages++
    } while (cursor)
    assert.ok(pages > 1)
    assert.equal(names.size, 2000)
  })

  it("rejects a directory cursor after the directory changes", async () => {
    const { root, workspace } = fixture()
    writeFileSync(path.join(root, "a.txt"), "a")
    writeFileSync(path.join(root, "b.txt"), "b")
    const first = await listFiles(workspace, "", { limit: 1 })
    const previousMtime = statSync(root).mtimeMs
    writeFileSync(path.join(root, "c.txt"), "c")
    const nextMtime = new Date(previousMtime + 2000)
    utimesSync(root, nextMtime, nextMtime)
    await assert.rejects(listFiles(workspace, "", { limit: 1, cursor: first.nextCursor }), error =>
      (error as { code?: string }).code === "STALE_REVISION")
  })

  it("conditionally revalidates a preview without retransmitting an unchanged body", async () => {
    const { root, workspace } = fixture()
    writeFileSync(path.join(root, "preview.txt"), "original")
    const first = await readFileContent(workspace, "preview.txt")
    const unchanged = await readFileContent(workspace, "preview.txt", first.etag)
    assert.equal(unchanged.notModified, true)
    assert.equal(unchanged.content, "")
    writeFileSync(path.join(root, "preview.txt"), "new")
    const changed = await readFileContent(workspace, "preview.txt", first.etag)
    assert.equal(changed.notModified, undefined)
    assert.equal(changed.content, "new")
  })

  it("serializes concurrent ETag writes so one stale writer loses", async () => {
    const { root, workspace } = fixture()
    writeFileSync(path.join(root, "shared.txt"), "base")
    const initial = await readFileContent(workspace, "shared.txt")
    const results = await Promise.allSettled([
      writeFileContent(workspace, "shared.txt", "first", { ifMatch: initial.etag }),
      writeFileContent(workspace, "shared.txt", "second", { ifMatch: initial.etag }),
    ])
    assert.equal(results.filter(result => result.status === "fulfilled").length, 1)
    const rejected = results.find(result => result.status === "rejected") as PromiseRejectedResult
    assert.equal((rejected.reason as { code?: string }).code, "STALE_REVISION")
    assert.ok(["first", "second"].includes(readFileSync(path.join(root, "shared.txt"), "utf8")))
  })

  it("bounds queued upload bytes, refunds cancellation and leaves other workspaces usable", async () => {
    const blocked = fixture()
    const healthy = fixture()
    const lock = await acquireWorkspaceMutationLock(blocked.root)
    const content = Buffer.alloc(8 * 1024 * 1024).toString("base64")
    const controller = new AbortController()
    const replacement = new AbortController()
    const first = writeFileContent(blocked.workspace, "first.txt", "first")
    const waiting = createWorkspaceEntry(blocked.workspace, "cancelled.bin", "file", {
      content, encoding: "base64", signal: controller.signal,
    })
    const pending: Promise<unknown>[] = [first, waiting]
    for (const promise of pending) void promise.catch(() => undefined)
    try {
      await assert.rejects(writeFileContent(blocked.workspace, "overflow.bin", content, {
        encoding: "base64", returnContent: false,
      }), { code: "RATE_LIMITED" })
      await writeFileContent(healthy.workspace, "healthy.txt", "available")
      assert.equal(readFileSync(path.join(healthy.root, "healthy.txt"), "utf8"), "available")

      controller.abort()
      await assert.rejects(waiting, { code: "REQUEST_ABORTED" })
      const admitted = writeFileContent(blocked.workspace, "replacement.bin", content, {
        encoding: "base64", returnContent: false, signal: replacement.signal,
      })
      pending.push(admitted)
      replacement.abort()
      await assert.rejects(admitted, { code: "REQUEST_ABORTED" })
      lock.release()
      await first
      assert.deepEqual(readdirSync(blocked.root), ["first.txt"])
      assert.equal(readFileSync(path.join(blocked.root, "first.txt"), "utf8"), "first")
    } finally {
      controller.abort()
      replacement.abort()
      lock.release()
      await Promise.allSettled(pending)
    }
  })

  it("bounds aggregate upload bytes across workspaces and refunds cancelled lock waiters", async () => {
    const workspaces = [fixture(), fixture(), fixture()]
    const locks = await Promise.all(workspaces.map(item => acquireWorkspaceMutationLock(item.root)))
    const controllers = workspaces.map(() => new AbortController())
    const content = Buffer.alloc(8 * 1024 * 1024).toString("base64")
    const pending = workspaces.slice(0, 2).map((item, index) => writeFileContent(item.workspace, "waiting.bin", content, {
      encoding: "base64", returnContent: false, signal: controllers[index]!.signal,
    }))
    for (const promise of pending) void promise.catch(() => undefined)
    try {
      await assert.rejects(writeFileContent(workspaces[2]!.workspace, "overflow.bin", content, {
        encoding: "base64", returnContent: false,
      }), { code: "RATE_LIMITED" })
      controllers[0]!.abort()
      await assert.rejects(pending[0], { code: "REQUEST_ABORTED" })
      const admitted = writeFileContent(workspaces[2]!.workspace, "replacement.bin", content, {
        encoding: "base64", returnContent: false, signal: controllers[2]!.signal,
      })
      pending.push(admitted)
      controllers[2]!.abort()
      await assert.rejects(admitted, { code: "REQUEST_ABORTED" })
    } finally {
      for (const controller of controllers) controller.abort()
      for (const lock of locks) lock.release()
      await Promise.allSettled(pending)
    }
    for (const item of workspaces) assert.deepEqual(readdirSync(item.root), [])
  })

  it("bounds both per-workspace and global mutation counts even for empty uploads", async () => {
    const workspaces = Array.from({ length: 5 }, () => fixture())
    const locks = await Promise.all(workspaces.map(item => acquireWorkspaceMutationLock(item.root)))
    const pending: Array<{ controller: AbortController; promise: Promise<unknown> }> = []
    try {
      for (let index = 0; index < 4; index++) {
        for (let item = 0; item < 32; item++) {
          const controller = new AbortController()
          const promise = writeFileContent(workspaces[index]!.workspace, `queued-${item}.txt`, "", { signal: controller.signal })
          void promise.catch(() => undefined)
          pending.push({ controller, promise })
        }
        if (index === 0) {
          await assert.rejects(writeFileContent(workspaces[0]!.workspace, "overflow.txt", ""), { code: "RATE_LIMITED" })
        }
      }
      await assert.rejects(writeFileContent(workspaces[4]!.workspace, "global-overflow.txt", ""), { code: "RATE_LIMITED" })
      pending[0]!.controller.abort()
      await assert.rejects(pending[0]!.promise, { code: "REQUEST_ABORTED" })
      const controller = new AbortController()
      const promise = writeFileContent(workspaces[4]!.workspace, "replacement.txt", "", { signal: controller.signal })
      pending.push({ controller, promise })
      controller.abort()
      await assert.rejects(promise, { code: "REQUEST_ABORTED" })
    } finally {
      for (const item of pending) item.controller.abort()
      for (const lock of locks) lock.release()
      await Promise.allSettled(pending.map(item => item.promise))
    }
    for (const item of workspaces) assert.deepEqual(readdirSync(item.root), [])
    await writeFileContent(workspaces[0]!.workspace, "recovered.txt", "recovered")
    assert.equal(readFileSync(path.join(workspaces[0]!.root, "recovered.txt"), "utf8"), "recovered")
  })

  it("cancels every host file mutation before execution without delayed writes after unlocking", async () => {
    const { root, workspace } = fixture()
    writeFileSync(path.join(root, "existing.txt"), "original")
    const store = new WorkspaceStore()
    store.resolve(root)
    const runtime = new HostRuntime({ store } as never)
    const controller = new AbortController()
    const options = { signal: controller.signal }
    const lock = await acquireWorkspaceMutationLock(root)
    const pending = [
      runtime.execute("files.write", { workspacePath: root, path: "existing.txt", content: "changed" }, options),
      runtime.execute("files.create", { workspacePath: root, path: "created.txt", type: "file", content: "created" }, options),
      runtime.execute("files.move", { workspacePath: root, from: "existing.txt", to: "moved.txt" }, options),
      runtime.execute("files.delete", { workspacePath: root, path: "existing.txt" }, options),
    ]
    const settled = Promise.allSettled(pending)
    try {
      controller.abort()
      for (const result of await settled) {
        assert.equal(result.status, "rejected")
        if (result.status === "rejected") assert.equal(result.reason.code, "REQUEST_ABORTED")
      }
    } finally {
      lock.release()
      await settled
    }
    await writeFileContent(workspace, "barrier.txt", "complete")
    assert.equal(readFileSync(path.join(root, "existing.txt"), "utf8"), "original")
    assert.equal(existsSync(path.join(root, "created.txt")), false)
    assert.equal(existsSync(path.join(root, "moved.txt")), false)
  })

  it("refunds upload reservations after filesystem failures and successful writes", async () => {
    const { root, workspace } = fixture()
    const content = Buffer.alloc(8 * 1024 * 1024, 7).toString("base64")
    for (let index = 0; index < 2; index++) {
      await assert.rejects(writeFileContent(workspace, `${"x".repeat(300)}-${index}.bin`, content, {
        encoding: "base64", returnContent: false,
      }), error => ["ENAMETOOLONG", "ENOENT", "EINVAL"].includes((error as NodeJS.ErrnoException).code ?? ""))
    }
    const first = await writeFileContent(workspace, "saved.bin", content, { encoding: "base64", returnContent: false })
    const second = await writeFileContent(workspace, "saved.bin", content, { encoding: "base64", returnContent: false, ifMatch: first.etag })
    assert.equal(second.etag, first.etag)
    assert.deepEqual(readFileSync(path.join(root, "saved.bin")), Buffer.alloc(8 * 1024 * 1024, 7))
  })

  it("creates, moves, and deletes files and directories", async () => {
    const { root, workspace } = fixture()
    await createWorkspaceEntry(workspace, "src/nested", "directory")
    await createWorkspaceEntry(workspace, "src/nested/a.txt", "file", { content: "a" })
    const moved = await moveWorkspaceEntry(workspace, "src/nested/a.txt", "src/b.txt")
    assert.deepEqual(moved, { path: "src/b.txt", type: "file" })
    assert.equal(readFileSync(path.join(root, "src", "b.txt"), "utf8"), "a")
    await deleteWorkspaceEntry(workspace, "src/b.txt")
    await assert.rejects(deleteWorkspaceEntry(workspace, "src", false), error =>
      (error as { code?: string }).code === "FILE_CONFLICT")
    await deleteWorkspaceEntry(workspace, "src", true)
  })

  it("supports a case-only rename on Windows", { skip: process.platform !== "win32" }, async () => {
    const { root, workspace } = fixture()
    writeFileSync(path.join(root, "Readme.txt"), "case")
    const moved = await moveWorkspaceEntry(workspace, "Readme.txt", "README.txt")
    assert.equal(moved.path, "README.txt")
    assert.equal(readFileSync(path.join(root, "README.txt"), "utf8"), "case")
  })

  it("rejects path escapes and malformed base64", async () => {
    const { workspace } = fixture()
    await assert.rejects(writeFileContent(workspace, "../escape", "x"), /escapes workspace/)
    await assert.rejects(writeFileContent(workspace, "bad.bin", "%%%", { encoding: "base64" }), /invalid base64/)
  })

  it("writes through an internal directory link at its physical target", async () => {
    const { root, workspace } = fixture()
    const physical = path.join(root, "physical")
    const alias = path.join(root, "alias")
    mkdirSync(physical)
    try {
      symlinkSync(physical, alias, "junction")
    } catch {
      return
    }
    await writeFileContent(workspace, "alias/new.txt", "physical")
    assert.equal(readFileSync(path.join(physical, "new.txt"), "utf8"), "physical")
  })

  it("rejects file operations after the workspace root is replaced", async () => {
    const { root, workspace } = fixture()
    writeFileSync(path.join(root, "before.txt"), "before")
    const moved = `${root}-replaced`
    renameSync(root, moved)
    mkdirSync(root)
    try {
      writeFileSync(path.join(root, "outside.txt"), "replacement")
      await assert.rejects(readFileContent(workspace, "outside.txt"), error =>
        (error as { code?: string }).code === "WORKSPACE_REPLACED")
    } finally {
      rmSync(root, { recursive: true, force: true })
      renameSync(moved, root)
    }
  })
})

function fixture(): { root: string; workspace: WorkspaceRecord } {
  // canonicalRoot 必须与生产注册一样经过 realpath——CI Windows 的 %TEMP%
  // 是 8.3 短路径（RUNNER~1），不规范化会误判 WORKSPACE_REPLACED
  const root = realpathSync.native(mkdtempSync(path.join(tmpdir(), "ompiui-files-")))
  roots.push(root)
  const identity = statSync(root)
  return {
    root,
    workspace: {
      canonicalRoot: root,
      rootIdentity: `${identity.dev}:${identity.ino}`,
      displayName: "fixture",
      createdAt: new Date().toISOString(),
      lastOpenedAt: new Date().toISOString(),
    },
  }
}
