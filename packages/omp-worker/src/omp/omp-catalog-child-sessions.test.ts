import assert from "node:assert/strict"
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { after, before, describe, it } from "node:test"
import { OmpCatalog } from "./omp-catalog.js"

const root = mkdtempSync(path.join(tmpdir(), "ompiui-child-sessions-"))
const sessionsRoot = path.join(root, "sessions")
const projectDir = path.join(sessionsRoot, "-C-proj")
const parentFile = path.join(projectDir, "2026-01-01T00-00-00Z_parent.jsonl")
const childDir = path.join(projectDir, "2026-01-01T00-00-00Z_parent")
const childFile = path.join(childDir, "ReadmeScout.jsonl")

before(() => {
  process.env.OMP_AGENT_DIR = root
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
})

after(() => {
  delete process.env.OMP_AGENT_DIR
  rmSync(root, { recursive: true, force: true })
})

describe("OmpCatalog child session lookup", () => {
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
