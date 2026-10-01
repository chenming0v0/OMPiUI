import assert from "node:assert/strict"
import { describe, it } from "node:test"
import type { JsonObject } from "@ompiui/protocol"
import { buildSessionTreeFromEntries } from "./session-tree.js"

describe("buildSessionTreeFromEntries", () => {
  it("按 parentId 组装成嵌套 { entry, children }（issue #10）", () => {
    const entries: JsonObject[] = [
      { id: "u1", parentId: null, type: "message" },
      { id: "a1", parentId: "u1", type: "message" },
      { id: "u2", parentId: "a1", type: "message" },
      { id: "u2b", parentId: "a1", type: "message" },
    ]
    const tree = buildSessionTreeFromEntries(entries)
    assert.equal(tree.length, 1)
    assert.equal(tree[0]!.entry.id, "u1")
    assert.deepEqual(tree[0]!.children.map(node => node.entry.id), ["a1"])
    // 兄弟保持 append 顺序
    assert.deepEqual(tree[0]!.children[0]!.children.map(node => node.entry.id), ["u2", "u2b"])
    // entry 保留完整内容，不只是 id/parentId
    assert.deepEqual(tree[0]!.entry, entries[0])
  })

  it("父缺失或乱序的条目当根，重复 id 只保留首个", () => {
    const entries: JsonObject[] = [
      { id: "b", parentId: "gone", type: "message" },
      { id: "dup", parentId: "b", type: "message" },
      { id: "dup", parentId: "b", type: "message" },
      { id: "a", parentId: null, type: "message" },
    ]
    const tree = buildSessionTreeFromEntries(entries)
    assert.deepEqual(new Set(tree.map(node => node.entry.id)), new Set(["b", "a"]))
    assert.equal(tree.find(node => node.entry.id === "b")!.children.length, 1)
  })

  it("label 两种来源都解析到节点：条目自带与 label 条目指向 targetId", () => {
    const entries: JsonObject[] = [
      { id: "root", parentId: null, type: "message" },
      { id: "marked", parentId: "root", type: "message", label: "直接标注" },
      { id: "target", parentId: "root", type: "message" },
      { id: "l1", parentId: "root", type: "label", targetId: "target", label: "第一条", timestamp: "2026-01-01T00:00:00Z" },
      { id: "l2", parentId: "root", type: "label", targetId: "target", label: "最新一条", timestamp: "2026-01-02T00:00:00Z" },
    ]
    const tree = buildSessionTreeFromEntries(entries)
    const marked = tree[0]!.children.find(node => node.entry.id === "marked")!
    assert.equal(marked.label, "直接标注")
    const target = tree[0]!.children.find(node => node.entry.id === "target")!
    // 后写的 label 条目生效
    assert.equal(target.label, "最新一条")
    assert.equal(target.labelTimestamp, "2026-01-02T00:00:00Z")
  })

  it("label 条目 label 为 undefined 时清除目标标注", () => {
    const entries: JsonObject[] = [
      { id: "root", parentId: null, type: "message" },
      { id: "target", parentId: "root", type: "message", label: "旧的" },
      { id: "l1", parentId: "root", type: "label", targetId: "target", label: undefined },
    ]
    const tree = buildSessionTreeFromEntries(entries)
    const target = tree[0]!.children.find(node => node.entry.id === "target")!
    assert.equal(target.label, undefined)
    assert.equal(target.labelTimestamp, undefined)
  })
})
