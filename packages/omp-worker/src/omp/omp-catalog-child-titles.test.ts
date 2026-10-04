import assert from "node:assert/strict"
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { after, before, describe, it } from "node:test"
import { OmpCatalog } from "./omp-catalog.js"

// ompAgentDir 每次调用读 OMP_AGENT_DIR：整个文件级 fixture 指向临时目录
const root = mkdtempSync(path.join(tmpdir(), "ompiui-child-titles-"))
const previousAgentDir = process.env.OMP_AGENT_DIR
const sessionsRoot = path.join(root, "sessions")
const projectDir = path.join(sessionsRoot, "-C-proj")
const parentFile = path.join(projectDir, "2026-01-01T00-00-00Z_parent.jsonl")
const childDir = path.join(projectDir, "2026-01-01T00-00-00Z_parent")

function writeSession(filePath: string, lines: unknown[]): void {
  writeFileSync(filePath, lines.map(line => JSON.stringify(line)).join("\n"))
}

before(() => {
  process.env.OMP_AGENT_DIR = root
  mkdirSync(childDir, { recursive: true })
  writeSession(parentFile, [
    { type: "title", v: 1, title: "Parent chat" },
    { type: "session", version: 3, id: "parent-1", timestamp: "t0", cwd: "C:/proj" },
    { type: "message", id: "p1", parentId: null, message: { role: "user", content: "hello parent" } },
    { type: "message", id: "task-result", parentId: "p1", message: { role: "toolResult", toolName: "task", details: { results: [{ id: "ReadmeScout", description: "Summarize README" }] } } },
  ])
  writeSession(path.join(childDir, "auto.jsonl"), [
    { type: "title", v: 1, title: "" },
    { type: "title_change", id: "t1", parentId: null, timestamp: "t1", title: "Read the catalog", source: "auto" },
    { type: "session", version: 3, id: "child-auto", timestamp: "t0", cwd: "C:/proj", parentSession: parentFile },
    { type: "session_init", id: "init-auto", parentId: "t1", timestamp: "t2", agent: "scout", task: "Complete assignment thoroughly" },
    { type: "message", id: "m-auto", parentId: "init-auto", message: { role: "user", content: "Complete assignment thoroughly: # Target" } },
  ])
  writeSession(path.join(childDir, "renamed.jsonl"), [
    { type: "title", v: 1, title: "Old auto title" },
    { type: "title_change", id: "t2", parentId: null, timestamp: "t1", title: "User renamed", source: "user" },
    { type: "session", version: 3, id: "child-user", timestamp: "t0", cwd: "C:/proj", name: "header name" },
    { type: "message", id: "m-user", parentId: "t2", message: { role: "user", content: "delegation prompt" } },
  ])
  writeSession(path.join(childDir, "agent.jsonl"), [
    { type: "title", v: 1, title: "   " },
    { type: "session", version: 3, id: "child-agent", timestamp: "t0", cwd: "C:/proj" },
    { type: "session_init", id: "init-agent", parentId: null, timestamp: "t1", agent: "docs" },
    { type: "message", id: "m-agent", parentId: "init-agent", message: { role: "user", content: [{ type: "text", text: "Complete assignment thoroughly" }] } },
  ])
  writeSession(path.join(childDir, "prompt.jsonl"), [
    { type: "session", version: 3, id: "child-prompt", timestamp: "t0", cwd: "C:/proj" },
    { type: "message", id: "m-prompt", parentId: null, message: { role: "user", content: "Fix the parser regression" } },
  ])
  writeSession(path.join(childDir, "ReadmeScout.jsonl"), [
    { type: "session", version: 3, id: "child-readme", timestamp: "t0", cwd: "C:/proj" },
    { type: "session_init", id: "readme-init", agent: "scout" },
    { type: "message", id: "readme-message", message: { role: "user", content: "Complete assignment thoroughly: injected context" } },
  ])
  writeSession(path.join(childDir, "Wrapped.jsonl"), [
    { type: "title", v: 1, title: "" },
    { type: "title_change", id: "t3", parentId: null, timestamp: "t1", title: "Complete assignment thoroughly:\n\n# Target", source: "auto" },
    { type: "session", version: 3, id: "child-wrap", timestamp: "t0", cwd: "C:/proj" },
    { type: "session_init", id: "wrap-init", agent: "scout" },
    { type: "message", id: "wrap-message", message: { role: "user", content: "Complete assignment thoroughly: injected context" } },
  ])
})

after(() => {
  if (previousAgentDir === undefined) delete process.env.OMP_AGENT_DIR
  else process.env.OMP_AGENT_DIR = previousAgentDir
  rmSync(root, { recursive: true, force: true })
})

describe("child session titles", () => {
  it("prefers authored titles, then parent task summaries, and never uses injected prompts as child names", async () => {
    const listed = await new OmpCatalog().listChildSessions(parentFile) as Array<{ id: string; name: string | null; firstMessage: string | null }>
    const byId = new Map(listed.map(item => [item.id, item]))

    const auto = byId.get("child-auto")
    assert.equal(auto?.name, "Read the catalog")
    assert.equal(auto?.firstMessage, "Complete assignment thoroughly: # Target")

    const renamed = byId.get("child-user")
    assert.equal(renamed?.name, "User renamed")

    const agent = byId.get("child-agent")
    assert.equal(agent?.name, "docs")
    assert.equal(agent?.firstMessage, "Complete assignment thoroughly")

    const prompt = byId.get("child-prompt")
    assert.equal(prompt?.name, "prompt")
    assert.equal(prompt?.firstMessage, "Fix the parser regression")
    assert.equal(byId.get("child-readme")?.name, "Summarize README")
    assert.equal(byId.get("child-wrap")?.name, "scout")
  })

  it("keeps a normal parent session title from the title slot", async () => {
    const listed = await new OmpCatalog().listAllSessions() as Array<{ id: string; name: string | null; firstMessage: string | null }>
    const parent = listed.find(item => item.id === "parent-1")
    assert.equal(parent?.name, "Parent chat")
    assert.equal(parent?.firstMessage, "hello parent")
    assert.equal(listed.some(item => item.id === "child-auto"), false)
  })
})
