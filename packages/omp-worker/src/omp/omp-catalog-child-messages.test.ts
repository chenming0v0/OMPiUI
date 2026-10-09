import assert from "node:assert/strict"
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
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
const managedDataDir = path.join(root, "webui")
const managedChildDir = path.join(managedDataDir, "sessions", "project", "parent")
const managedChildFile = path.join(managedChildDir, "Worker.jsonl")
const previousAgentDir = process.env.OMP_AGENT_DIR
const previousDataDir = process.env.OMPIUI_DATA_DIR
const managedMessages = [
  { role: "user", content: "Review changes" },
  { role: "assistant", content: [{ type: "text", text: "Persisted worker findings" }] },
]

before(() => {
  process.env.OMP_AGENT_DIR = root
  process.env.OMPIUI_DATA_DIR = managedDataDir
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
  mkdirSync(managedChildDir, { recursive: true })
  writeFileSync(managedChildFile, [
    JSON.stringify({ type: "session", version: 3, id: "web-child", cwd: "C:/proj" }),
    ...managedMessages.map((message, index) => JSON.stringify({ type: "message", id: `web-${index}`, message })),
  ].join("\n"))
})

after(() => {
  if (previousAgentDir === undefined) delete process.env.OMP_AGENT_DIR
  else process.env.OMP_AGENT_DIR = previousAgentDir
  if (previousDataDir === undefined) delete process.env.OMPIUI_DATA_DIR
  else process.env.OMPIUI_DATA_DIR = previousDataDir
  rmSync(root, { recursive: true, force: true })
})

describe("readChildSessionMessages", () => {
  it("reads message entries from a child session file on disk", async () => {
    const messages = await readChildSessionMessages(childFile)
    assert.equal(messages.length, 2)
    assert.equal(messages[0]?.role, "user")
    assert.equal((messages[1]?.content as Array<{ text?: string }>)?.[0]?.text, "OMPiUI 是……")
  })

  it("restores the WebUI-managed child transcript from disk", async () => {
    assert.deepEqual(await readChildSessionMessages(managedChildFile), managedMessages)
  })

  it("reads managed transcripts when the native sessions root does not exist", async () => {
    process.env.OMP_AGENT_DIR = path.join(root, "no-native-agent")
    try {
      assert.deepEqual(await readChildSessionMessages(managedChildFile), managedMessages)
    } finally {
      process.env.OMP_AGENT_DIR = root
    }
  })

  it("rejects adjacent directories and links escaping either sessions root", async () => {
    const outsideDir = path.join(managedDataDir, "sessions-outside")
    mkdirSync(outsideDir, { recursive: true })
    const outsideFile = path.join(outsideDir, "Outside.jsonl")
    writeFileSync(outsideFile, JSON.stringify({ type: "message", message: managedMessages[1] }))
    await assert.rejects(readChildSessionMessages(outsideFile), { code: "PATH_OUTSIDE_WORKSPACE" })
    for (const directory of [childDir, managedChildDir]) {
      const link = path.join(directory, "escape")
      symlinkSync(outsideDir, link, process.platform === "win32" ? "junction" : "dir")
      await assert.rejects(readChildSessionMessages(path.join(link, "Outside.jsonl")), { code: "PATH_OUTSIDE_WORKSPACE" })
    }
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
