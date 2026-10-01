import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { previewEntriesFromLines } from "./omp-catalog.js"

/** 子代理 jsonl 的典型头部：title/session 头 + session_init + 消息 */
const childSessionLines = [
  JSON.stringify({ type: "title", v: 1, title: "" }),
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
    const dropped = entries.filter(entry => entry.type === "omp.dropped")
    assert.equal(dropped.length, 3)
    assert.ok(dropped.some(entry => entry.droppedType === "session_init"))
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
    assert.equal(entries.length, 5)
  })
})
