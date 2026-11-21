// 只生成脱敏基准条目；不会读取或输出原生会话正文。
export const HISTORY_DATASET_NAME = "4修复40个issues的对话记录测试集"
export const HISTORY_MESSAGE_COUNT = 1_971
export const HISTORY_MESSAGE_BYTES = 15_982_299
export const HISTORY_ENTRY_COUNT = 3_406
export const HISTORY_ENTRY_BYTES = 17_387_135

type MessageRole = "assistant" | "toolResult" | "user" | "developer" | "custom"
type ContentBlock = Record<string, unknown> & { type: string }
type TimelineEntryType =
  | "message"
  | "model_change"
  | "thinking_level_change"
  | "custom"
  | "custom_message"
  | "omp.dropped"
  | "ttsr_injection"
  | "compaction"

export interface HistoryBenchmarkEntry {
  type: TimelineEntryType
  id: string
  parentId: string | null
  timestamp: string
  message?: {
    role: MessageRole
    content: string | ContentBlock[]
  }
  [key: string]: unknown
}

export interface HistoryBenchmarkFixture {
  entries: HistoryBenchmarkEntry[]
  serializedMessageBytes: number
  serializedEntryBytes: number
}

interface EntrySpec {
  type: TimelineEntryType
  size: number
  message?: HistoryBenchmarkEntry["message"]
}

function permuteSizes(values: number[], step: number): number[] {
  const mixed = new Array<number>(values.length)
  for (let index = 0; index < values.length; index++)
    mixed[(index * step) % values.length] = values[index]!
  return mixed
}

function messageSizesByRole(): Record<MessageRole, number[]> {
  const assistant = [
    513,
    ...Array<number>(75).fill(2_672),
    ...Array<number>(112).fill(3_500),
    4_228,
    ...Array<number>(187).fill(5_500),
    7_074,
    ...Array<number>(187).fill(10_000),
    14_084,
    ...Array<number>(112).fill(18_000),
    22_016,
    ...Array<number>(37).fill(25_000),
    30_701,
    ...Array<number>(29).fill(45_000),
    60_134,
    ...Array<number>(6).fill(84_145),
    84_148,
    155_283,
  ]
  const toolResult = [
    408,
    ...Array<number>(120).fill(644),
    ...Array<number>(180).fill(700),
    824,
    ...Array<number>(301).fill(1_500),
    2_883,
    ...Array<number>(300).fill(5_000),
    7_288,
    ...Array<number>(180).fill(10_000),
    14_398,
    ...Array<number>(59).fill(18_000),
    23_834,
    ...Array<number>(47).fill(30_000),
    48_188,
    59_127,
    ...Array<number>(11).fill(59_131),
    112_939,
  ]
  return {
    user: [244, 283, 2_311],
    assistant: permuteSizes(assistant, 37),
    toolResult: permuteSizes(toolResult, 37),
    developer: [1_718, 1_843, 2_148, 2_159, 2_945],
    custom: [778, 809],
  }
}

function messageRoles(): MessageRole[] {
  const special = new Map<number, MessageRole>([
    [0, "user"],
    [657, "user"],
    [1_315, "user"],
    [120, "developer"],
    [420, "developer"],
    [820, "developer"],
    [1_220, "developer"],
    [1_720, "developer"],
    [320, "custom"],
    [1_520, "custom"],
  ])
  const regularIndexes = Array.from({ length: HISTORY_MESSAGE_COUNT }, (_, index) => index)
    .filter(index => !special.has(index))
  const roles = new Array<MessageRole>(HISTORY_MESSAGE_COUNT)
  for (const [index, role] of special) roles[index] = role
  for (let ordinal = 0; ordinal < regularIndexes.length; ordinal++) {
    const toolResult = Math.floor((ordinal + 1) * 1_207 / regularIndexes.length)
      > Math.floor(ordinal * 1_207 / regularIndexes.length)
    roles[regularIndexes[ordinal]!] = toolResult ? "toolResult" : "assistant"
  }
  return roles
}

function assistantContent(assistantCount: number): ContentBlock[][] {
  const groups = Array.from({ length: assistantCount }, () => [] as ContentBlock[])
  for (let index = 0; index < 1_548; index++)
    groups[index % assistantCount]!.push({ type: "thinking", thinking: "" })
  for (let index = 0; index < 1_207; index++)
    groups[index % assistantCount]!.push({
      type: "toolCall",
      id: `benchmark-call-${index}`,
      name: "read",
      arguments: { path: "/workspace/README.md" },
    })
  for (let index = 0; index < 21; index++)
    groups[index]!.push({ type: "text", text: "" })
  return groups
}

function messageContent(
  role: MessageRole,
  roleIndex: number,
  assistantBlocks: ContentBlock[],
): string | ContentBlock[] {
  if (role === "assistant") return assistantBlocks
  if (role === "toolResult") {
    const blocks: ContentBlock[] = []
    if (roleIndex < 9) {
      const pixel = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aGz0AAAAASUVORK5CYII="
      blocks.push({ type: "image", mimeType: "image/png", data: pixel })
    }
    blocks.push({ type: "text", text: "" })
    return blocks
  }
  if (role === "custom") return ""
  return [{ type: "text", text: "" }]
}

function messageSpecs(): EntrySpec[] {
  const roles = messageRoles()
  const assistantCount = roles.filter(role => role === "assistant").length
  const assistantBlocks = assistantContent(assistantCount)
  const assistantOrdinal = new Map<number, number>(
    roles.flatMap((role, index) => role === "assistant" ? [index] : [])
      .map((index, ordinal) => [index, ordinal] as const),
  )
  const sizes = messageSizesByRole()
  const roleOrdinals: Record<MessageRole, number> = {
    assistant: 0,
    toolResult: 0,
    user: 0,
    developer: 0,
    custom: 0,
  }
  return roles.map((role, index) => {
    const roleIndex = roleOrdinals[role]++
    return {
      type: "message",
      size: sizes[role][roleIndex]!,
      message: {
        role,
        content: messageContent(
          role,
          roleIndex,
          assistantBlocks[assistantOrdinal.get(index) ?? 0] ?? [],
        ),
      },
    }
  })
}

function otherEntrySpecs(): EntrySpec[] {
  const repeated = (type: TimelineEntryType, count: number, size: number): EntrySpec[] =>
    Array.from({ length: count }, () => ({ type, size }))
  const specs: EntrySpec[] = [
    { type: "model_change", size: 195 },
    { type: "model_change", size: 196 },
    { type: "thinking_level_change", size: 182 },
    ...repeated("custom", 1_208, 451),
    { type: "custom", size: 851 },
    ...repeated("custom_message", 197, 2_835),
    { type: "custom_message", size: 2_809 },
    ...repeated("omp.dropped", 18, 127),
    ...repeated("ttsr_injection", 4, 176),
    { type: "ttsr_injection", size: 177 },
    { type: "compaction", size: 147_066 },
    { type: "compaction", size: 147_067 },
  ]
  const mixed = new Array<EntrySpec>(specs.length)
  for (let index = 0; index < specs.length; index++)
    mixed[(index * 577) % specs.length] = specs[index]!
  return mixed
}

function timelineSpecs(): EntrySpec[] {
  const messages = messageSpecs()
  const others = otherEntrySpecs()
  const timeline: EntrySpec[] = []
  let messageIndex = 0
  let otherIndex = 0
  for (let index = 0; index < HISTORY_ENTRY_COUNT; index++) {
    const takeMessage = Math.floor((index + 1) * HISTORY_MESSAGE_COUNT / HISTORY_ENTRY_COUNT)
      > Math.floor(index * HISTORY_MESSAGE_COUNT / HISTORY_ENTRY_COUNT)
    timeline.push(takeMessage ? messages[messageIndex++]! : others[otherIndex++]!)
  }
  return timeline
}

function createEntry(spec: EntrySpec, index: number, previousId: string | null): HistoryBenchmarkEntry {
  const id = `e${index.toString(36).padStart(3, "0")}`
  const entry: HistoryBenchmarkEntry = {
    type: spec.type,
    id,
    parentId: previousId,
    timestamp: spec.type === "omp.dropped" ? "" : "2026-10-25T16:00:00.000Z",
  }
  if (spec.message) {
    entry.message = spec.message
    return entry
  }
  entry.benchmarkPayload = ""
  if (spec.type === "custom") {
    entry.customType = "benchmark"
    entry.data = { text: "" }
  } else if (spec.type === "custom_message") {
    entry.customType = "benchmark"
    entry.content = ""
  } else if (spec.type === "omp.dropped") {
    entry.droppedType = "model_usage"
  } else if (spec.type === "model_change") {
    entry.provider = "benchmark"
    entry.modelId = "m"
  } else if (spec.type === "thinking_level_change") {
    entry.thinkingLevel = "medium"
  } else if (spec.type === "ttsr_injection") {
    entry.text = ""
  } else if (spec.type === "compaction") {
    entry.summary = ""
  }
  return entry
}

function fillToSerializedBytes(entry: HistoryBenchmarkEntry, targetBytes: number): void {
  const prefix = entry.type === "omp.dropped" ? "x" : `Fixture ${entry.id} `
  const fillerBytes = targetBytes - Buffer.byteLength(JSON.stringify(entry))
  if (fillerBytes < prefix.length)
    throw new Error(`fixture entry ${entry.id} is larger than its measured size`)
  const filler = prefix + "x".repeat(fillerBytes - prefix.length)
  const content = entry.message?.content
  if (entry.message && typeof content === "string") {
    entry.message.content = filler
  } else if (entry.message && Array.isArray(content)) {
    const visibleText = [...content].reverse().find(block => block.type === "text")
    const thinking = [...content].reverse().find(block => block.type === "thinking")
    const target = visibleText ?? thinking
    if (!target) throw new Error(`fixture entry ${entry.id} has no text payload`)
    target[target.type === "thinking" ? "thinking" : "text"] = filler
  } else if (entry.type === "custom" && entry.data && typeof entry.data === "object") {
    (entry.data as { text: string }).text = filler
  } else if (entry.type === "custom_message") {
    entry.content = filler
  } else if (entry.type === "ttsr_injection") {
    entry.text = filler
  } else if (entry.type === "compaction") {
    entry.summary = filler
  } else {
    entry.benchmarkPayload = filler
  }
  if (Buffer.byteLength(JSON.stringify(entry)) !== targetBytes)
    throw new Error(`fixture entry ${entry.id} does not match its measured size`)
}

export function createHistoryBenchmarkFixture(): HistoryBenchmarkFixture {
  let previousId: string | null = null
  const entries = timelineSpecs().map((spec, index) => {
    const entry = createEntry(spec, index, previousId)
    fillToSerializedBytes(entry, spec.size)
    previousId = entry.id
    return entry
  })
  const messageEntries = entries.filter(entry => entry.type === "message")
  const serializedMessageBytes = messageEntries.reduce(
    (total, entry) => total + Buffer.byteLength(JSON.stringify(entry)),
    0,
  )
  const serializedEntryBytes = entries.reduce(
    (total, entry) => total + Buffer.byteLength(JSON.stringify(entry)),
    0,
  )
  if (
    entries.length !== HISTORY_ENTRY_COUNT ||
    messageEntries.length !== HISTORY_MESSAGE_COUNT ||
    serializedMessageBytes !== HISTORY_MESSAGE_BYTES ||
    serializedEntryBytes !== HISTORY_ENTRY_BYTES
  ) {
    throw new Error("history benchmark profile no longer matches its measured active branch")
  }
  return { entries, serializedMessageBytes, serializedEntryBytes }
}
