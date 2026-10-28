import dagre from '@dagrejs/dagre'
import type { Edge, Node } from '@xyflow/react'
import type { JsonObject, JsonValue } from '@ompiui/protocol'

// Tree entries arrive as SDK SessionEntry/SessionTreeNode; the graph renders
// any entry shape (including future unknown types) so it reads fields
// duck-typed over JSON records.
export type NativeEntry = JsonObject
export type NativeTreeNode = NativeEntry & {
  entry: NativeEntry
  children: NativeTreeNode[]
  label?: string
  labelTimestamp?: string
}

export interface SessionTreeNodeData extends Record<string, unknown> {
  entryId: string
  type: string
  role?: string
  label?: string
  preview: string
  activePath: boolean
  currentLeaf: boolean
  branchCount: number
  toolCount: number
  hasToolError: boolean
  compact: boolean
}

export type SessionGraphNode = Node<SessionTreeNodeData, 'sessionEntry'>

export interface SessionTreeGraph {
  nodes: SessionGraphNode[]
  edges: Edge[]
  nodeById: Map<string, NativeTreeNode>
  detailEntriesById: Map<string, NativeEntry[]>
}

const NODE_WIDTH = 240
const MESSAGE_HEIGHT = 78
const EVENT_HEIGHT = 54
// dagre 的 acyclic DFS 是递归实现，深链超过这个层数会 RangeError。
const DAGRE_MAX_DEPTH = 400
const RANKSEP = 68
const NODESEP = 36
const MARGIN = 40

function asRecord(value: JsonValue | undefined): NativeEntry {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {}
}

// 喂进来的树按 SDK SessionTreeNode 形状断言，但不做运行期信任：
// entry/children 任一缺失都退化为空，不让图模块崩在属性访问上（issue #10）
function nodeEntry(node: NativeTreeNode): NativeEntry {
  return asRecord(node?.entry)
}

function nodeChildren(node: NativeTreeNode): NativeTreeNode[] {
  return Array.isArray(node?.children) ? node.children : []
}

function textFromNative(value: JsonValue | undefined): string {
  if (typeof value === 'string') return value
  if (!Array.isArray(value)) return ''
  let text = ''
  for (const item of value) {
    const record = asRecord(item)
    if (record.type === 'text' && typeof record.text === 'string') text += record.text
  }
  return text
}

function normalizePreview(value: string): string {
  const normalized = value
    .replace(/[\t\r\n]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return normalized.length > 180 ? `${normalized.slice(0, 177)}…` : normalized
}

/**
 * 树图不作为节点展示的条目类型：元数据/簿记类（时间线 selectors 同样
 * 跳过或按需渲染）。omp.dropped 是 OMP worker 的元数据占位。
 */
const TREE_INVISIBLE_TYPES: ReadonlySet<string> = new Set([
  'label',
  'custom',
  'model_change',
  'thinking_level_change',
  'session_info',
  'active_tools_change',
  'service_tier_change',
  'ttsr_injection',
  'credential_pin',
  'reset_boundary',
  'omp.dropped',
])

export function sessionTreeEntryPreview(entry: NativeEntry, typeLabel: (type: string) => string): string {
  const type = typeof entry.type === 'string' ? entry.type : 'unknown'
  if (type === 'message') {
    const message = asRecord(entry.message)
    const role = String(message.role ?? '')
    const text = normalizePreview(textFromNative(message.content))
    if (role === 'assistant') {
      if (text) return text
      if (message.stopReason === 'aborted') return typeLabel('assistant_aborted')
      if (typeof message.errorMessage === 'string' && message.errorMessage)
        return normalizePreview(message.errorMessage)
      return typeLabel('assistant_empty')
    }
    return text || role || typeLabel(type)
  }
  if (type === 'model_change') return `${String(entry.provider ?? '')}/${String(entry.modelId ?? '')}`
  if (type === 'thinking_level_change') return String(entry.thinkingLevel ?? typeLabel(type))
  if (type === 'compaction' || type === 'branch_summary')
    return normalizePreview(String(entry.summary ?? typeLabel(type)))
  if (type === 'custom_message')
    return normalizePreview(textFromNative(entry.content) || String(entry.customType ?? typeLabel(type)))
  if (type === 'custom') return String(entry.customType ?? typeLabel(type))
  if (type === 'label') return String(entry.label ?? typeLabel(type))
  if (type === 'session_info') return String(entry.name ?? typeLabel(type))
  return typeLabel(type)
}

export function findSessionTreeNode(tree: NativeTreeNode[], entryId: string | null): NativeTreeNode | undefined {
  if (!entryId) return undefined
  const stack = [...tree]
  while (stack.length > 0) {
    const node = stack.pop()!
    if (nodeEntry(node).id === entryId) return node
    stack.push(...nodeChildren(node))
  }
  return undefined
}

/**
 * 目标节点从根到自身的 id 路径（含目标）。跨分支导航时用它算
 * "旧分支上被裁掉的部分"：旧时间线 − 这条路径 = redo 的来源。
 */
export function findSessionTreePath(tree: NativeTreeNode[], entryId: string): string[] | null {
  type Link = { node: NativeTreeNode; parent?: Link }
  const stack: Link[] = [...tree].reverse().map(node => ({ node }))
  const seen = new Set<NativeTreeNode>()
  while (stack.length) {
    const link = stack.pop()!
    const node = link.node
    if (seen.has(node)) continue
    seen.add(node)
    const rawId = nodeEntry(node).id
    const id = typeof rawId === 'string' ? rawId : ''
    if (id === entryId) {
      const path: string[] = []
      for (let current: Link | undefined = link; current; current = current.parent)
        path.push(String(nodeEntry(current.node).id ?? ''))
      return path.reverse()
    }
    for (const child of [...nodeChildren(node)].reverse()) stack.push({ node: child, parent: link })
  }
  return null
}


export function isTreeVisibleEntry(entry: NativeEntry, currentLeafId: string | null): boolean {
  const type = typeof entry.type === 'string' ? entry.type : 'unknown'
  const entryId = typeof entry.id === 'string' ? entry.id : null
  if (entryId === currentLeafId) {
    if (type === 'message') {
      const message = asRecord(entry.message)
      if (message.role === 'toolResult') return false
      if (message.role === 'assistant') {
        const hasText = textFromNative(message.content).trim().length > 0
        const isErrorOrAborted =
          typeof message.stopReason === 'string' && message.stopReason !== 'stop' && message.stopReason !== 'toolUse'
        return hasText || isErrorOrAborted
      }
      return true
    }
    return !TREE_INVISIBLE_TYPES.has(type)
  }
  if (type === 'message') {
    const message = asRecord(entry.message)
    if (message.role === 'toolResult') return false
    if (message.role === 'assistant') {
      const hasText = textFromNative(message.content).trim().length > 0
      const isErrorOrAborted =
        typeof message.stopReason === 'string' && message.stopReason !== 'stop' && message.stopReason !== 'toolUse'
      return hasText || isErrorOrAborted
    }
    return true
  }
  return !TREE_INVISIBLE_TYPES.has(type)
}

export function buildSessionTreeGraph(
  tree: NativeTreeNode[],
  leafId: string | null,
  typeLabel: (type: string) => string,
): SessionTreeGraph {
  const graph = new dagre.graphlib.Graph()
    .setGraph({ rankdir: 'TB', ranksep: 68, nodesep: 36, marginx: 40, marginy: 40 })
    .setDefaultEdgeLabel(() => ({}))
  const nodeById = new Map<string, NativeTreeNode>()
  const rawParentById = new Map<string, string | null>()
  const parentById = new Map<string, string | null>()
  const childCountById = new Map<string, number>()
  const detailEntriesById = new Map<string, NativeEntry[]>()
  const orderedIds: string[] = []

  // 递归改显式栈：长会话是深链而不是宽树（实测 3410 条条目、
  // 最大深度 3407），递归会在几百层内就把调用栈打爆。
  const indexRawTree = (roots: NativeTreeNode[]) => {
    const stack: Array<{ node: NativeTreeNode; parentId: string | null }> = []
    for (let index = roots.length - 1; index >= 0; index--) stack.push({ node: roots[index], parentId: null })
    while (stack.length > 0) {
      const { node, parentId } = stack.pop()!
      const rawId = nodeEntry(node).id
      const entryId = typeof rawId === 'string' ? rawId : ''
      if (entryId && !rawParentById.has(entryId)) {
        rawParentById.set(entryId, parentId)
        const children = nodeChildren(node)
        for (let index = children.length - 1; index >= 0; index--) {
          stack.push({ node: children[index], parentId: entryId })
        }
      }
    }
  }
  indexRawTree(tree)

  let visualLeafId = leafId
  while (visualLeafId && !isTreeVisibleEntry(findSessionTreeNode(tree, visualLeafId)?.entry ?? {}, visualLeafId)) {
    visualLeafId = rawParentById.get(visualLeafId) ?? null
  }

  const toolCallIds = (entry: NativeEntry) => {
    const message = asRecord(entry.message)
    if (message.role !== 'assistant' || !Array.isArray(message.content)) return []
    return message.content.flatMap(item => {
      const block = asRecord(item)
      const id = typeof block.id === 'string' ? block.id : typeof block.toolCallId === 'string' ? block.toolCallId : ''
      return (block.type === 'toolCall' || block.type === 'tool_call' || block.type === 'toolUse') && id ? [id] : []
    })
  }

  // 同样改显式栈。注意这里要保序（父先于子、兄弟按原顺序），所以按逆序压栈，
  // 且每个子节点都带上父节点算出的 (visibleParentId, pendingDetails)。
  const visitAll = (roots: NativeTreeNode[]) => {
    const stack: Array<{ node: NativeTreeNode; visibleParentId: string | null; pendingDetails: NativeEntry[] }> = []
    for (let index = roots.length - 1; index >= 0; index--) {
      stack.push({ node: roots[index], visibleParentId: null, pendingDetails: [] })
    }
    while (stack.length > 0) {
      const { node, visibleParentId, pendingDetails } = stack.pop()!
      const next = visit(node, visibleParentId, pendingDetails)
      if (!next) continue
      const children = nodeChildren(node)
      for (let index = children.length - 1; index >= 0; index--) {
        stack.push({ node: children[index], visibleParentId: next.visibleParentId, pendingDetails: next.pendingDetails })
      }
    }
  }

  const visit = (
    node: NativeTreeNode,
    visibleParentId: string | null,
    pendingDetails: NativeEntry[],
  ): { visibleParentId: string | null; pendingDetails: NativeEntry[] } | null => {
    const entry = nodeEntry(node)
    const rawId = entry.id
    const entryId = typeof rawId === 'string' ? rawId : ''
    if (!entryId) return null
    let nextVisibleParentId = visibleParentId
    let nextPendingDetails = pendingDetails
    if (isTreeVisibleEntry(entry, visualLeafId) && !nodeById.has(entryId)) {
      nodeById.set(entryId, node)
      parentById.set(entryId, visibleParentId)
      orderedIds.push(entryId)
      const type = typeof entry.type === 'string' ? entry.type : 'unknown'
      const compact = type !== 'message' && type !== 'custom_message' && type !== 'branch_summary'
      graph.setNode(entryId, { width: NODE_WIDTH, height: compact ? EVENT_HEIGHT : MESSAGE_HEIGHT })
      if (visibleParentId) {
        graph.setEdge(visibleParentId, entryId)
        childCountById.set(visibleParentId, (childCountById.get(visibleParentId) ?? 0) + 1)
      }
      nextVisibleParentId = entryId
      const role = asRecord(entry.message).role
      const details = role === 'assistant' ? [...pendingDetails, entry] : [entry]
      detailEntriesById.set(entryId, details)
      nextPendingDetails = role === 'assistant' && toolCallIds(entry).length > 0 ? [entry] : []
    } else {
      const message = asRecord(entry.message)
      if (entry.type === 'message' && (message.role === 'assistant' || message.role === 'toolResult')) {
        nextPendingDetails = [...pendingDetails, entry]
      }
    }
    if (entryId === leafId && nextVisibleParentId && nextPendingDetails.length > 0) {
      const currentDetails = detailEntriesById.get(nextVisibleParentId) ?? []
      const knownIds = new Set(currentDetails.map(detail => detail.id))
      detailEntriesById.set(nextVisibleParentId, [
        ...currentDetails,
        ...nextPendingDetails.filter(detail => !knownIds.has(detail.id)),
      ])
      nextPendingDetails = []
    }
    return { visibleParentId: nextVisibleParentId, pendingDetails: nextPendingDetails }
  }
  visitAll(tree)

  const activePath = new Set<string>()
  let cursor = visualLeafId
  while (cursor && !activePath.has(cursor)) {
    activePath.add(cursor)
    cursor = parentById.get(cursor) ?? null
  }

  // dagre 自身在 acyclic DFS 里递归：实测超过 ~1200 层的链会栈溢出，而长会话
  // 恰恰是深链（3410 条条目 / 深度 3407）。深树改用同一套 rank 的简化分层布局：
  // 每层一行、同层按出现顺序横向排开——视觉上与 dagre 的 TB 结果一致，
  // 但没有递归。
  const layoutPositions = new Map<string, { x: number; y: number; height: number }>()
  const depthById = new Map<string, number>()
  let maxDepth = 0
  for (const entryId of orderedIds) {
    const parent = parentById.get(entryId) ?? null
    const depth = parent ? (depthById.get(parent) ?? 0) + 1 : 0
    depthById.set(entryId, depth)
    if (depth > maxDepth) maxDepth = depth
  }

  if (maxDepth > DAGRE_MAX_DEPTH) {
    const rowIndexById = new Map<string, number>()
    const centers = new Map<number, number>()
    for (const entryId of orderedIds) centers.set(depthById.get(entryId)!, (centers.get(depthById.get(entryId)!) ?? 0) + 1)
    const used = new Map<number, number>()
    for (const entryId of orderedIds) {
      const type = typeof nodeEntry(nodeById.get(entryId)!).type === 'string' ? String(nodeEntry(nodeById.get(entryId)!).type) : 'unknown'
      const height = type !== 'message' && type !== 'custom_message' && type !== 'branch_summary' ? EVENT_HEIGHT : MESSAGE_HEIGHT
      const depth = depthById.get(entryId)!
      const rowCount = centers.get(depth) ?? 1
      const index = used.get(depth) ?? 0
      used.set(depth, index + 1)
      rowIndexById.set(entryId, index)
      layoutPositions.set(entryId, {
        x: MARGIN + (index - (rowCount - 1) / 2) * (NODE_WIDTH + NODESEP) + NODE_WIDTH / 2,
        y: MARGIN + depth * (MESSAGE_HEIGHT + RANKSEP) + height / 2,
        height,
      })
    }
  } else {
    dagre.layout(graph)
    for (const entryId of orderedIds) {
      const layout = graph.node(entryId)
      layoutPositions.set(entryId, { x: layout.x, y: layout.y, height: layout.height })
    }
  }

  const nodes: SessionGraphNode[] = orderedIds.map(entryId => {
    const source = nodeById.get(entryId)!
    const sourceEntry = nodeEntry(source)
    const layout = layoutPositions.get(entryId)!
    const type = typeof sourceEntry.type === 'string' ? sourceEntry.type : 'unknown'
    const message = asRecord(sourceEntry.message)
    const role = type === 'message' && typeof message.role === 'string' ? message.role : undefined
    const compact = type !== 'message' && type !== 'custom_message' && type !== 'branch_summary'
    const details = detailEntriesById.get(entryId) ?? [sourceEntry]
    const calls = details.flatMap(toolCallIds)
    const hasToolError = details.some(detail => {
      const detailMessage = asRecord(detail.message)
      return detailMessage.role === 'toolResult' && detailMessage.isError === true
    })
    return {
      id: entryId,
      type: 'sessionEntry',
      position: { x: layout.x - NODE_WIDTH / 2, y: layout.y - layout.height / 2 },
      data: {
        entryId,
        type,
        role,
        label: source.label,
        preview: sessionTreeEntryPreview(sourceEntry, typeLabel),
        activePath: activePath.has(entryId),
        currentLeaf: entryId === visualLeafId,
        branchCount: childCountById.get(entryId) ?? 0,
        toolCount: calls.length,
        hasToolError,
        compact,
      },
      width: NODE_WIDTH,
      height: compact ? EVENT_HEIGHT : MESSAGE_HEIGHT,
      selectable: true,
      focusable: true,
      ariaRole: 'button',
    }
  })

  const edges: Edge[] = graph.edges().map(({ v, w }) => {
    const onActivePath = activePath.has(v) && activePath.has(w)
    // 贝塞尔曲线 + 无箭头：树形方向由布局（自上而下）表达，
    // 箭头和折线只会增加噪点
    return {
      id: `${v}->${w}`,
      source: v,
      target: w,
      type: 'default',
      style: {
        stroke: onActivePath ? 'hsl(var(--accent-main-100) / 0.75)' : 'hsl(var(--border-200) / 0.55)',
        strokeWidth: onActivePath ? 2 : 1.5,
      },
      zIndex: onActivePath ? 2 : 1,
    }
  })

  return { nodes, edges, nodeById, detailEntriesById }
}
