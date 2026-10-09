import assert from "node:assert/strict"
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { after, before, describe, it } from "node:test"
import { isJsonObject } from "@ompiui/protocol"
import { OmpCatalog } from "./omp-catalog.js"

const root = mkdtempSync(path.join(tmpdir(), "ompiui-child-sessions-"))
const sessionsRoot = path.join(root, "sessions")
const projectDir = path.join(sessionsRoot, "-C-proj")
const parentFile = path.join(projectDir, "2026-01-01T00-00-00Z_parent.jsonl")
const childDir = path.join(projectDir, "2026-01-01T00-00-00Z_parent")
const childFile = path.join(childDir, "ReadmeScout.jsonl")
const managedDataDir = path.join(root, "webui")
const managedParentFile = path.join(managedDataDir, "sessions", "project", "parent.jsonl")
const managedChildFile = path.join(managedDataDir, "sessions", "project", "parent", "Worker.jsonl")
const previousAgentDir = process.env.OMP_AGENT_DIR
const previousDataDir = process.env.OMPIUI_DATA_DIR

before(() => {
  process.env.OMP_AGENT_DIR = root
  process.env.OMPIUI_DATA_DIR = managedDataDir
  mkdirSync(childDir, { recursive: true })
  writeFileSync(parentFile, [
    JSON.stringify({ type: "title", title: "parent" }),
    JSON.stringify({ type: "session", version: 3, id: "parent-1", cwd: "C:/proj" }),
    JSON.stringify({
      type: "message",
      id: "m-call",
      message: {
        role: "assistant",
        content: [{
          type: "toolCall",
          name: "task",
          arguments: { tasks: [{ name: "ReadmeScout", description: "Scout the readme" }] },
        }],
      },
    }),
  ].join("\n"))
  writeFileSync(childFile, [
    JSON.stringify({ type: "title", title: "" }),
    JSON.stringify({ type: "session", version: 3, id: "child-1", cwd: "C:/proj", parentSession: parentFile }),
    JSON.stringify({ type: "session_init", id: "e-init", agent: "scout", task: "assignment", tools: [], systemPrompt: "..." }),
    JSON.stringify({ type: "message", id: "m1", parentId: "e-init", message: { role: "user", content: "Complete assignment thoroughly" } }),
  ].join("\n"))
  mkdirSync(path.dirname(managedChildFile), { recursive: true })
  writeFileSync(managedParentFile, JSON.stringify({ type: "session", version: 3, id: "web-parent", cwd: "C:/proj" }))
  writeFileSync(managedChildFile, [
    JSON.stringify({ type: "session", version: 3, id: "web-child", cwd: "C:/proj", parentSession: managedParentFile }),
    JSON.stringify({ type: "message", id: "web-msg", parentId: null, message: { role: "assistant", content: [{ type: "text", text: "Worker findings" }] } }),
  ].join("\n"))
})

after(() => {
  if (previousAgentDir === undefined) delete process.env.OMP_AGENT_DIR
  else process.env.OMP_AGENT_DIR = previousAgentDir
  if (previousDataDir === undefined) delete process.env.OMPIUI_DATA_DIR
  else process.env.OMPIUI_DATA_DIR = previousDataDir
  rmSync(root, { recursive: true, force: true })
})

describe("OmpCatalog child session lookup", () => {
  for (const fixture of [
    { label: "native", id: "child-1", file: childFile, parent: parentFile, messageId: "m1", readOnly: true },
    { label: "WebUI-managed", id: "web-child", file: managedChildFile, parent: managedParentFile, messageId: "web-msg", readOnly: false },
  ]) {
    it(`opens a listed ${fixture.label} child by id after catalog restart`, async () => {
      const listingCatalog = new OmpCatalog()
      try {
        const listed = await listingCatalog.listChildSessions(fixture.parent)
        assert.ok(Array.isArray(listed))
        assert.ok(listed.some(item => isJsonObject(item) && item.id === fixture.id && item.path === fixture.file))
        const top = await listingCatalog.listAllSessions()
        assert.ok(Array.isArray(top))
        assert.equal(top.some(item => isJsonObject(item) && item.id === fixture.id), false)
      } finally {
        await listingCatalog.dispose()
      }
      const catalog = new OmpCatalog()
      try {
        assert.deepEqual(await catalog.findSessionById(fixture.id), { id: fixture.id, cwd: "C:/proj", sessionFile: fixture.file })
        const preview = await catalog.previewSessionById(fixture.id)
        assert.ok(isJsonObject(preview) && isJsonObject(preview.state) && isJsonObject(preview.branch))
        assert.equal(preview.state.sessionFile, fixture.file)
        assert.equal(preview.state.readOnly, fixture.readOnly)
        assert.ok(Array.isArray(preview.branch.items))
        assert.ok(preview.branch.items.some(item => isJsonObject(item) && item.id === fixture.messageId && item.type === "message"))
        const state = await catalog.readSession(fixture.id, "state.get")
        assert.ok(isJsonObject(state))
        assert.equal(state.sessionId, fixture.id)
        const branch = await catalog.readSession(fixture.id, "branch.get")
        assert.ok(isJsonObject(branch))
        assert.deepEqual(branch, preview.branch)
      } finally {
        await catalog.dispose()
      }
    })
  }

  it("returns SESSION_NOT_FOUND for an unknown child id", async () => {
    const catalog = new OmpCatalog()
    try {
      assert.equal(await catalog.findSessionById("missing-child"), null)
      await assert.rejects(catalog.previewSessionById("missing-child"), { code: "SESSION_NOT_FOUND" })
    } finally {
      await catalog.dispose()
    }
  })

  it("findSessionByFile returns the disk identity without listing siblings", async () => {
    const catalog = new OmpCatalog()
    const found = await catalog.findSessionByFile(childFile)
    assert.equal(found?.id, "child-1")
    assert.equal(found?.cwd, "C:/proj")
    assert.equal(found?.sessionFile, childFile)
    await catalog.dispose()
  })

  it("findSessionByFile returns null for missing or non-jsonl targets", async () => {
    const catalog = new OmpCatalog()
    assert.equal(await catalog.findSessionByFile(path.join(childDir, "Missing.jsonl")), null)
    assert.equal(await catalog.findSessionByFile(childDir), null)
    await catalog.dispose()
  })

  it("listChildSessions uses the parent task description as the child title", async () => {
    const catalog = new OmpCatalog()
    const listed = await catalog.listChildSessions(parentFile)
    assert.ok(Array.isArray(listed))
    const child = listed.find(item => item && typeof item === "object" && (item as { id?: string }).id === "child-1") as { name?: string } | undefined
    assert.equal(child?.name, "Scout the readme")
    await catalog.dispose()
  })
})
