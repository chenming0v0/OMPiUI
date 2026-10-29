import type { JsonObject } from "./json.js"

export const TOOL_INTERACTION_PROTOCOL_VERSION = 1 as const
export const TOOL_INTERACTION_MAX_INPUT_BYTES = 32 * 1024
export const TOOL_INTERACTION_MAX_FRAME_BYTES = 64 * 1024
export const TOOL_INTERACTION_REPLAY_BYTES = 2 * 1024 * 1024

export type ToolInteractionIdentity = {
  runtimeId: string
  sessionId: string
  toolCallId: string
  executionId: string
}

export type ToolInteractionDescriptor = ToolInteractionIdentity & {
  protocolVersion: typeof TOOL_INTERACTION_PROTOCOL_VERSION
  status: "starting" | "running" | "exited"
  command: string
  cwd: string
  cols: number
  rows: number
  cursor: number
  oldestCursor: number
  pid?: number
  exitCode?: number
  cancelled?: boolean
  timedOut?: boolean
  error?: string
}

export type ToolInteractionLease = {
  writerId: string
  writerEpoch: string
  lastAcceptedSequence: number
  expiresAt: number
}

/** Input sequences belong to an execution and writer epoch, not a WebSocket. */
export type ToolInteractionOperation =
  | { operation: "list" }
  | (ToolInteractionIdentity & { operation: "describe" })
  | (ToolInteractionIdentity & { operation: "read"; cursor?: number; maxBytes?: number })
  | (ToolInteractionIdentity & { operation: "claim"; writerId: string; writerEpoch?: string })
  | (ToolInteractionIdentity & { operation: "release"; writerId: string; writerEpoch: string })
  | (ToolInteractionIdentity & { operation: "input"; writerId: string; writerEpoch: string; sequence: number; data: string })
  | (ToolInteractionIdentity & { operation: "resize"; writerId: string; writerEpoch: string; cols: number; rows: number })
  | (ToolInteractionIdentity & { operation: "cancel"; writerId: string; writerEpoch: string })

export type ToolInteractionSnapshot = {
  protocolVersion: typeof TOOL_INTERACTION_PROTOCOL_VERSION
  runtimeId: string
  available: boolean
  reason?: string
  executions: ToolInteractionDescriptor[]
}

export type ToolInteractionRead = {
  descriptor: ToolInteractionDescriptor
  fromCursor: number
  cursor: number
  data: string
  reset: boolean
}

export type ToolInteractionClientFrame =
  | { type: "claim"; writerId: string; writerEpoch?: string }
  | { type: "release" }
  | { type: "input"; sequence: number; data: string }
  | { type: "resize"; cols: number; rows: number }
  | { type: "cancel" }
  | { type: "output_ack"; cursor: number }

export type ToolInteractionServerFrame =
  | { type: "hello"; descriptor: ToolInteractionDescriptor }
  | { type: "lease"; lease: ToolInteractionLease | null }
  | { type: "input_ack"; sequence: number; lastAcceptedSequence: number }
  | { type: "output"; fromCursor: number; cursor: number; data: string; reset: boolean }
  | { type: "exit"; descriptor: ToolInteractionDescriptor }
  | { type: "problem"; code: string; message: string }

export function toolInteractionKey(identity: ToolInteractionIdentity): string {
  return JSON.stringify([identity.runtimeId, identity.sessionId, identity.toolCallId, identity.executionId])
}

export function isToolInteractionIdentity(value: unknown): value is ToolInteractionIdentity {
  if (!value || typeof value !== "object") return false
  const record = value as JsonObject
  return ["runtimeId", "sessionId", "toolCallId", "executionId"].every(key =>
    typeof record[key] === "string" && record[key].length > 0 && record[key].length <= 256,
  )
}

export function isToolInteractionDescriptor(value: unknown): value is ToolInteractionDescriptor {
  if (!isToolInteractionIdentity(value)) return false
  const record = value as unknown as JsonObject
  return record.protocolVersion === TOOL_INTERACTION_PROTOCOL_VERSION &&
    ["starting", "running", "exited"].includes(String(record.status)) &&
    typeof record.command === "string" && typeof record.cwd === "string" &&
    ["cols", "rows", "cursor", "oldestCursor"].every(key =>
      Number.isSafeInteger(record[key]) && Number(record[key]) >= 0,
    )
}
