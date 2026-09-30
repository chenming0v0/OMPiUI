import type { JsonObject, JsonValue } from "@ompiui/protocol"

/**
 * tree.get 的响应形状 —— 对齐 Pi SDK 的 SessionTreeNode（{ entry, children,
 * label?, labelTimestamp? }）。前端 sessionTreeGraph 按 SDK 形状消费，
 * worker 的扁平 { id, parentId, ... } 条目在这里组装成嵌套树（issue #10）。
 */
export interface SessionTreeNodePayload {
  [key: string]: JsonValue | undefined
  entry: JsonObject
  children: SessionTreeNodePayload[]
  label?: string
  labelTimestamp?: string
}

function entryIdOf(entry: JsonObject): string {
  return typeof entry.id === "string" ? entry.id : ""
}

/**
 * 把 append 序的扁平条目组装成 SDK getTree() 的嵌套树：
 * - children 按 append 顺序挂到 parentId；父缺失或 id 无效的条目当根。
 * - label 解析两种来源：条目自带 label（setLabel 直写，mock 语义），
 *   以及 label 条目指向 targetId（SDK 语义），后者以后写的为准。
 */
export function buildSessionTreeFromEntries(entries: readonly JsonObject[]): SessionTreeNodePayload[] {
  const nodeById = new Map<string, SessionTreeNodePayload>()
  const nodes: SessionTreeNodePayload[] = []
  for (const entry of entries) {
    const id = entryIdOf(entry)
    if (!id || nodeById.has(id)) continue
    const node: SessionTreeNodePayload = { entry, children: [] }
    if (typeof entry.label === "string" && entry.label) {
      node.label = entry.label
      if (typeof entry.labelTimestamp === "string" && entry.labelTimestamp) node.labelTimestamp = entry.labelTimestamp
    }
    nodeById.set(id, node)
    nodes.push(node)
  }
  const roots: SessionTreeNodePayload[] = []
  // 第二遍按 append 序挂接；重复 id 只挂一次，避免同一节点重复入树
  const attached = new Set<string>()
  for (const entry of entries) {
    const id = entryIdOf(entry)
    if (!id || attached.has(id)) continue
    const node = nodeById.get(id)
    if (!node) continue
    const parentId = typeof entry.parentId === "string" ? entry.parentId : null
    const parent = parentId ? nodeById.get(parentId) : undefined
    if (parent) parent.children.push(node)
    else roots.push(node)
    attached.add(id)
  }
  for (const node of nodes) {
    if (node.entry.type !== "label" || typeof node.entry.targetId !== "string") continue
    const target = nodeById.get(node.entry.targetId)
    if (!target) continue
    if (typeof node.entry.label === "string" && node.entry.label) {
      target.label = node.entry.label
      if (typeof node.entry.timestamp === "string") target.labelTimestamp = node.entry.timestamp
    } else {
      delete target.label
      delete target.labelTimestamp
    }
  }
  return roots
}
