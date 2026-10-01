import assert from "node:assert/strict"
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { after, before, describe, it } from "node:test"
import { readChildSessionMessages } from "./omp-catalog.js"

// ompAgentDir 每次调用读 OMP_AGENT_DIR：整个文件级 fixture 指向临时目录
const root = mkdtempSync(path.join(tmpdir(), "ompiui-child-msgs-"))
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
  ].join("\n"))
  writeFileSync(childFile, [
    JSON.stringify({ type: "title", title: "" }),
    JSON.stringify({ type: "session", version: 3, id: "child-1", cwd: "C:/proj", parentSession: parentFile }),
    JSON.stringify({ type: "session_init", id: "e-init", task: "assignment", tools: [], systemPrompt: "..." }),
    JSON.stringify({ type: "message", id: "m1", parentId: "e-init", message: { role: "user", content: "Complete assignment thoroughly" } }),
    JSON.stringify({ type: "message", id: "m2", parentId: "m1", message: { role: "assistant", content: [{ type: "text", text: "OMPiUI 是……" }] } }),
  ].join("\n"))
})

after(() => {
  delete process.env.OMP_AGENT_DIR
  rmSync(root, { recursive: true, force: true })
})

describe("readChildSessionMessages", () => {
  it("reads message entries from a child session file on disk", async () => {
    const messages = await readChildSessionMessages(childFile)
    assert.equal(messages.length, 2)
    assert.equal(messages[0]?.role, "user")
    assert.equal((messages[1]?.content as Array<{ text?: string }>)?.[0]?.text, "OMPiUI 是……")
  })

  it("rejects files outside the OMP sessions root", async () => {
    const outside = path.join(root, "evil.jsonl")
    writeFileSync(outside, JSON.stringify({ type: "message", message: { role: "user", content: "x" } }))
    await assert.rejects(
      () => readChildSessionMessages(outside),
      (error: Error) => (error as NodeJS.ErrnoException & { code?: string }).code === "PATH_OUTSIDE_WORKSPACE",
    )
  })

  it("rejects missing files and non-jsonl targets", async () => {
    await assert.rejects(
      () => readChildSessionMessages(path.join(childDir, "Missing.jsonl")),
      (error: Error) => (error as NodeJS.ErrnoException & { code?: string }).code === "NOT_FOUND",
    )
    await assert.rejects(
      () => readChildSessionMessages(childDir),
      (error: Error) => (error as NodeJS.ErrnoException & { code?: string }).code === "NOT_FOUND",
    )
  })
})
