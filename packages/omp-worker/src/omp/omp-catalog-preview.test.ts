import assert from "node:assert/strict"
import { appendFileSync, mkdtempSync, promises as fs, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs"
import { syncBuiltinESMExports } from "node:module"
import { tmpdir } from "node:os"
import path from "node:path"
import { describe, it, type TestContext } from "node:test"
import type { JsonObject } from "@ompiui/protocol"
import { OmpCatalog, previewEntriesFromLines } from "./omp-catalog.js"

/** 子代理 jsonl 的典型头部：title/title_change/session 头 + session_init + 消息 */
const childSessionLines = [
  JSON.stringify({ type: "title", v: 1, title: "" }),
  JSON.stringify({
    type: "title_change",
    id: "e-title",
    parentId: null,
    timestamp: "t0",
    title: "自动生成的标题",
    source: "auto",
  }),
  JSON.stringify({
    type: "session",
    version: 3,
    id: "01a0f3a5-a14c-7000-9846-8a3122d65294",
    timestamp: "2026-09-30T18:48:33.355Z",
    cwd: "C:\\proj",
  }),
  JSON.stringify({ type: "model_change", model: "grok-4.7", id: "e-model", parentId: null, timestamp: "t1" }),
  JSON.stringify({
    type: "session_init",
    id: "e-init",
    parentId: "e-model",
    timestamp: "t2",
    systemPrompt: "...",
    task: "Complete assignment thoroughly",
    tools: ["read", "bash"],
    agent: "scout",
  }),
  JSON.stringify({
    type: "message",
    id: "e-msg",
    parentId: "e-init",
    timestamp: "t3",
    message: { role: "user", content: "Complete assignment thoroughly", timestamp: Date.now() },
  }),
]

describe("previewEntriesFromLines", () => {
  it("replaces session_init and other metadata entries with omp.dropped placeholders", () => {
    const entries = previewEntriesFromLines(childSessionLines, "sid")
    const types = entries.map(entry => entry.type)
    assert.ok(!types.includes("session_init"), "session_init must not leak to the preview timeline")
    assert.ok(!types.includes("title") && !types.includes("session"))
    assert.ok(!types.includes("title_change"), "title_change must not leak to the preview timeline")
    const dropped = entries.filter(entry => entry.type === "omp.dropped")
    assert.equal(dropped.length, 4)
    assert.ok(dropped.some(entry => entry.droppedType === "session_init"))
    assert.ok(dropped.some(entry => entry.droppedType === "title_change"))
  })

  it("keeps the parentId chain intact for branch walking", () => {
    const entries = previewEntriesFromLines(childSessionLines, "sid")
    const byId = new Map(entries.map(entry => [String(entry.id), entry]))
    const msg = byId.get("e-msg")
    assert.ok(msg, "message entry preserved")
    // message 的父是 session_init（已换成占位）：占位保持同一 id，链不断
    const parent = byId.get(String(msg.parentId))
    assert.ok(parent, "parent placeholder preserved")
    assert.equal(parent.type, "omp.dropped")
    assert.equal(parent.droppedType, "session_init")
    // 占位自己的父链也接得上（session_init → model_change，后者原样保留）
    const grandparent = byId.get(String(parent.parentId))
    assert.ok(grandparent)
    assert.equal(grandparent.type, "model_change")
  })

  it("passes through conversation entries untouched and skips malformed lines", () => {
    const entries = previewEntriesFromLines([...childSessionLines, "{broken", "", "not json"], "sid")
    const message = entries.find(entry => entry.type === "message")
    assert.ok(message)
    assert.equal(message.id, "e-msg")
    assert.equal(entries.length, 6)
  })
})

function diskFixture(t: TestContext, id: string) {
  const root = mkdtempSync(path.join(tmpdir(), "ompiui-catalog-read-"))
  const previous = process.env.OMPIUI_OMP_SESSION_DIRS
  process.env.OMPIUI_OMP_SESSION_DIRS = [previous, root].filter(Boolean).join(path.delimiter)
  t.after(() => {
    if (previous === undefined) delete process.env.OMPIUI_OMP_SESSION_DIRS
    else process.env.OMPIUI_OMP_SESSION_DIRS = previous
    rmSync(root, { recursive: true, force: true })
  })
  const sessionFile = path.join(root, `${id}.jsonl`)
  const header = { type: "session", version: 3, id, cwd: root }
  const message = { type: "message", id: `${id}-message`, parentId: id, message: { role: "user", content: "hello" } }
  writeFileSync(sessionFile, `${JSON.stringify(header)}\n${JSON.stringify(message)}\n`)
  return { root, sessionFile, header, message }
}

function recordFileOpens(t: TestContext): string[] {
  const opened: string[] = []
  const original = fs.open
  const mock = t.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
    opened.push(String(args[0]))
    return original(...args)
  })
  syncBuiltinESMExports()
  t.after(() => {
    mock.mock.restore()
    syncBuiltinESMExports()
  })
  return opened
}

describe("OmpCatalog targeted disk reads", () => {
  it("shares the first file scan between an explicit cold preview's summary and branch", async t => {
    const f = diskFixture(t, "cold-file-preview")
    const opened = recordFileOpens(t)
    const before = readFileSync(f.sessionFile)
    const modified = statSync(f.sessionFile).mtimeMs
    const catalog = new OmpCatalog()
    t.after(() => catalog.dispose())
    const preview = await catalog.previewSession(f.root, f.sessionFile) as JsonObject
    assert.equal((preview.state as JsonObject).messageCount, 1)
    assert.ok(((preview.branch as JsonObject).items as JsonObject[]).some(entry => entry.id === f.message.id))
    assert.equal(opened.filter(file => file === f.sessionFile).length, 1)
    assert.deepEqual(readFileSync(f.sessionFile), before)
    assert.equal(statSync(f.sessionFile).mtimeMs, modified)
  })

  it("projects records before reading the next and preserves generated ids before the header", async t => {
    const f = diskFixture(t, "early-projection")
    const lines = [
      { type: "title", title: "before header" },
      { type: "title_change", id: "authored-title", title: "explicit title" },
      f.header,
      { type: "session_init", id: "init", parentId: f.header.id, systemPrompt: "discarded metadata", resolvedModel: "provider/model" },
      f.message,
      { type: "message", parentId: f.message.id, message: { role: "assistant", content: "no explicit id" } },
    ]
    const encode = (entry: object) => JSON.stringify({ ...entry, projectionProbe: true })
    writeFileSync(f.sessionFile, `${lines.map(encode).join("\n")}\n`)
    let parsedRecords = 0
    const parse = JSON.parse
    t.mock.method(JSON, "parse", (...args: Parameters<typeof JSON.parse>) => {
      const parsed: unknown = parse(...args)
      if (parsed && typeof parsed === "object" && "projectionProbe" in parsed && parsed.projectionProbe === true) {
        const record = parsed as Record<string, unknown>
        const type = record.type
        const generation = ++parsedRecords
        Object.defineProperty(record, "type", {
          enumerable: true,
          get() {
            assert.equal(parsedRecords, generation, "raw records must be projected before advancing the scanner")
            return type
          },
        })
      }
      return parsed
    })
    const catalog = new OmpCatalog()
    t.after(() => catalog.dispose())
    await catalog.previewSession(f.root, f.sessionFile)
    const first = await catalog.readSession(f.header.id, "entries.get") as { items: JsonObject[] }
    assert.equal(parsedRecords, lines.length)
    assert.deepEqual(first.items.map(entry => entry.id), [
      `${f.header.id}:0`, "authored-title", f.header.id, "init", f.message.id, `${f.header.id}:5`,
    ])
    assert.equal(first.items[3]?.type, "omp.dropped")
    assert.equal(first.items[3]?.systemPrompt, undefined)
    assert.equal(first.items[3]?.resolvedModel, "provider/model")

    appendFileSync(f.sessionFile, `${encode({ type: "message", parentId: `${f.header.id}:5`, message: { role: "user", content: "appended" } })}\n`)
    const appended = await catalog.readSession(f.header.id, "entries.get") as { items: JsonObject[] }
    assert.equal(appended.items.at(-1)?.id, `${f.header.id}:6`)
    assert.equal(first.items.at(-1)?.id, `${f.header.id}:5`)

    writeFileSync(f.sessionFile, `${[lines[0]!, f.header, f.message].map(encode).join("\n")}\n`)
    const rewritten = await catalog.readSession(f.header.id, "entries.get") as { items: JsonObject[] }
    assert.deepEqual(rewritten.items.map(entry => entry.id), [`${f.header.id}:0`, f.header.id, f.message.id])
  })

  for (const query of ["preview", "state.get"]) {
    it(`uses a verified known file for a cold ${query} by id without summarizing siblings`, async t => {
      const f = diskFixture(t, `targeted-${query}`)
      const catalog = new OmpCatalog()
      t.after(() => catalog.dispose())
      await catalog.findSessionByFile(f.sessionFile)
      const sibling = path.join(f.root, "unrelated.jsonl")
      writeFileSync(sibling, `${JSON.stringify({ ...f.header, id: "unrelated" })}\n`)
      const opened = recordFileOpens(t)
      const result = query === "preview"
        ? (await catalog.previewSessionById(f.header.id) as JsonObject).state as JsonObject
        : await catalog.readSession(f.header.id, query) as JsonObject
      assert.equal(result.sessionId, f.header.id)
      assert.equal(result.sessionFile, f.sessionFile)
      assert.equal(result.diskPreview, true)
      assert.equal(result.readOnly, false)
      assert.equal(opened.includes(sibling), false)
      assert.equal(opened.filter(file => file === f.sessionFile).length, 1)
    })
  }

  it("reuses the discovery cache for unknown ids and refreshes it after expiry", async t => {
    const f = diskFixture(t, "cached-discovery")
    const catalog = new OmpCatalog()
    t.after(() => catalog.dispose())
    let now = Date.now()
    t.mock.method(Date, "now", () => now)
    await catalog.listAllSessions()
    const stat = t.mock.method(fs, "stat")
    const scannedTarget = () => stat.mock.calls.filter(call => String(call.arguments[0]) === f.sessionFile).length

    assert.equal(await catalog.findSessionById("missing-first"), null)
    await assert.rejects(catalog.readSession("missing-second", "state.get"), { code: "SESSION_NOT_FOUND" })
    assert.equal(scannedTarget(), 0)
    now += 2_001
    assert.equal(await catalog.findSessionById("missing-after-expiry"), null)
    assert.equal(scannedTarget(), 1)
  })

  it("revalidates the id and falls back to discovery when the indexed path is replaced", async t => {
    const f = diskFixture(t, "moved-file-preview")
    const catalog = new OmpCatalog()
    t.after(() => catalog.dispose())
    await catalog.listAllSessions() // 保留尚未过期的旧路径快照
    const moved = path.join(f.root, "moved.jsonl")
    renameSync(f.sessionFile, moved)
    writeFileSync(f.sessionFile, `${JSON.stringify({ ...f.header, id: "replacement" })}\n`)
    const preview = await catalog.previewSessionById(f.header.id) as JsonObject
    const state = preview.state as JsonObject
    assert.equal(state.sessionId, f.header.id)
    assert.equal(state.sessionFile, moved)
    assert.ok(((preview.branch as JsonObject).items as JsonObject[]).some(entry => entry.id === f.message.id))
    assert.equal((await catalog.readSession("replacement", "state.get") as JsonObject).sessionFile, f.sessionFile)
    rmSync(moved)
    await assert.rejects(catalog.readSession(f.header.id, "state.get"), { code: "SESSION_NOT_FOUND" })
  })

  it("keeps summary and branch on the same checkpoint across appends and rewrites", async t => {
    const f = diskFixture(t, "shared-checkpoint")
    const catalog = new OmpCatalog()
    t.after(() => catalog.dispose())
    await catalog.previewSession(f.root, f.sessionFile)
    appendFileSync(f.sessionFile, `${JSON.stringify({ ...f.message, id: "added", parentId: f.message.id })}\n`)
    await catalog.listAllSessions() // 列表的摘要检查点不能让预览正文跳过新增行
    const appended = await catalog.previewSessionById(f.header.id) as JsonObject
    assert.equal((appended.state as JsonObject).messageCount, 2)
    assert.ok(((appended.branch as JsonObject).items as JsonObject[]).some(entry => entry.id === "added"))
    writeFileSync(f.sessionFile, `${JSON.stringify(f.header)}\n${JSON.stringify({ ...f.message, id: "rewritten", message: { role: "user", content: "new" } })}\n`)
    const rewritten = await catalog.previewSessionById(f.header.id) as JsonObject
    const items = (rewritten.branch as JsonObject).items as JsonObject[]
    assert.equal((rewritten.state as JsonObject).messageCount, 1)
    assert.ok(items.some(entry => entry.id === "rewritten"))
    assert.equal(items.some(entry => entry.id === "added" || entry.id === f.message.id), false)
  })
})

describe("OmpCatalog cold branch restore", () => {
  const userTurn = (id: string, parentId: string | null, text: string) => ({
    type: "message",
    id,
    parentId,
    timestamp: `2026-10-13T00:00:0${id.length}.000Z`,
    message: { role: "user", content: text },
  })
  const assistantTurn = (id: string, parentId: string, text: string) => ({
    type: "message",
    id,
    parentId,
    timestamp: `2026-10-13T00:00:1${id.length}.000Z`,
    message: { role: "assistant", content: [{ type: "text", text }] },
  })

  it("follows the leaf a plain tree jump selected when the file ends with session_exit", async t => {
    const f = diskFixture(t, "plain-jump-exit")
    const lines = [
      f.header,
      userTurn("turn-1", f.header.id, "keep"),
      assistantTurn("reply-1", "turn-1", "kept reply"),
      userTurn("turn-2", "reply-1", "abandon"),
      assistantTurn("reply-2", "turn-2", "abandoned reply"),
      { type: "custom", customType: "session_exit", id: "exit-1", parentId: "turn-1" },
    ]
    writeFileSync(f.sessionFile, `${lines.map(line => JSON.stringify(line)).join("\n")}\n`)
    const catalog = new OmpCatalog()
    t.after(() => catalog.dispose())
    const preview = await catalog.previewSession(f.root, f.sessionFile) as JsonObject
    const state = preview.state as JsonObject
    const items = (preview.branch as JsonObject).items as JsonObject[]
    assert.equal((state.head as JsonObject).leafId, "turn-1")
    assert.deepEqual(items.map(entry => entry.id), [f.header.id, "turn-1"])
  })

  it("keeps the newest record after the jumped session appends on that leaf", async t => {
    const f = diskFixture(t, "plain-jump-resume")
    const lines = [
      f.header,
      userTurn("turn-1", f.header.id, "keep"),
      assistantTurn("reply-1", "turn-1", "kept reply"),
      userTurn("turn-2", "reply-1", "abandon"),
      { type: "custom", customType: "session_exit", id: "exit-1", parentId: "turn-1" },
      userTurn("turn-3", "turn-1", "resume"),
    ]
    writeFileSync(f.sessionFile, `${lines.map(line => JSON.stringify(line)).join("\n")}\n`)
    const catalog = new OmpCatalog()
    t.after(() => catalog.dispose())
    const preview = await catalog.previewSession(f.root, f.sessionFile) as JsonObject
    const state = preview.state as JsonObject
    const items = (preview.branch as JsonObject).items as JsonObject[]
    assert.equal((state.head as JsonObject).leafId, "turn-3")
    assert.deepEqual(items.map(entry => entry.id), [f.header.id, "turn-1", "turn-3"])
  })

  it("honors activeLeafId so a write to another branch does not move the leaf", async t => {
    const f = diskFixture(t, "active-leaf")
    const lines = [
      f.header,
      userTurn("turn-1", f.header.id, "keep"),
      assistantTurn("reply-1", "turn-1", "kept reply"),
      { ...userTurn("side", "turn-1", "side write"), activeLeafId: "reply-1" },
    ]
    writeFileSync(f.sessionFile, `${lines.map(line => JSON.stringify(line)).join("\n")}\n`)
    const catalog = new OmpCatalog()
    t.after(() => catalog.dispose())
    const preview = await catalog.previewSession(f.root, f.sessionFile) as JsonObject
    const state = preview.state as JsonObject
    assert.equal((state.head as JsonObject).leafId, "reply-1")
  })
})

describe("OmpCatalog disk branch refresh", () => {
  it("returns an empty incremental page when the session file is unchanged", async (t) => {
    const root = mkdtempSync(path.join(tmpdir(), "ompiui-catalog-refresh-"))
    const previousDirectories = process.env.OMPIUI_OMP_SESSION_DIRS
    process.env.OMPIUI_OMP_SESSION_DIRS = [previousDirectories, root].filter(Boolean).join(path.delimiter)
    t.after(() => {
      if (previousDirectories === undefined) delete process.env.OMPIUI_OMP_SESSION_DIRS
      else process.env.OMPIUI_OMP_SESSION_DIRS = previousDirectories
    })
    t.after(() => rmSync(root, { recursive: true, force: true }))
    const sessionFile = path.join(root, "session.jsonl")
    const lines = [
      { type: "session", version: 3, id: "disk-refresh", timestamp: "2026-10-12T00:00:00.000Z", cwd: root },
      { type: "message", id: "message-1", parentId: "disk-refresh", timestamp: "2026-10-12T00:00:01.000Z", message: { role: "user", content: "hello" } },
      { type: "message", id: "message-2", parentId: "message-1", timestamp: "2026-10-12T00:00:02.000Z", message: { role: "assistant", content: "world" } },
    ]
    writeFileSync(sessionFile, lines.map(line => JSON.stringify(line)).join("\n") + "\n")

    const catalog = new OmpCatalog()
    const first = await catalog.previewSession(root, sessionFile, { limit: 100 }) as { branch: { items: Array<{ id: string }>; syncCursor?: string } }
    assert.ok(first.branch.syncCursor)
    const second = await catalog.previewSession(root, sessionFile, {
      limit: 100,
      syncCursor: first.branch.syncCursor,
      beforeId: first.branch.items[0]?.id,
    }) as { branch: { items: Array<unknown>; deltaFrom?: string } }

    assert.equal(second.branch.deltaFrom, first.branch.syncCursor)
    assert.deepEqual(second.branch.items, [])

    writeFileSync(sessionFile, `${lines.map(line => JSON.stringify(line)).join("\n")}\n${JSON.stringify({
      type: "message",
      id: "message-3",
      parentId: "message-2",
      timestamp: "2026-10-12T00:00:03.000Z",
      message: { role: "user", content: "again" },
    })}\n`)
    const third = await catalog.previewSession(root, sessionFile, {
      limit: 100,
      syncCursor: second.branch.deltaFrom,
      beforeId: first.branch.items[0]?.id,
    }) as { branch: { items: Array<{ id: string }>; deltaFrom?: string } }
    assert.equal(third.branch.deltaFrom, second.branch.deltaFrom)
    assert.deepEqual(third.branch.items.map(item => item.id), ["message-3"])
  })
})
