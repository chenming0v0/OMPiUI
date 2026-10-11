import { isJsonObject, type JsonObject } from "@ompiui/protocol"
import { EventSnapshotBuffer } from "./event-snapshot-buffer.js"

/** 累计快照只保留最新一份；开始、结束和工具结果仍按原顺序立即发送。 */
export class SubagentEventBuffer {
  private readonly buffer: EventSnapshotBuffer<JsonObject>

  constructor(emit: (event: JsonObject) => void, intervalMs = 50) {
    this.buffer = new EventSnapshotBuffer(emit, intervalMs)
  }

  push(kind: string, raw: JsonObject): void {
    const progress = isJsonObject(raw.progress) ? raw.progress : undefined
    const id = typeof raw.id === "string" ? raw.id : typeof progress?.id === "string" ? progress.id : undefined
    const payload = id && raw.id !== id ? { ...raw, id } : raw
    const event: JsonObject = { kind, payload }
    const inner = isJsonObject(payload.event) ? payload.event : undefined
    const type = inner?.type
    const update = kind === "progress" ? "progress"
      : kind === "event" && type === "message_update" ? "message"
        : kind === "event" && type === "tool_execution_update" ? `tool:${String(inner?.toolCallId ?? "")}`
          : undefined
    this.buffer.push(id ?? "", id ? update : undefined, event)
  }

  dispose(): void {
    this.buffer.flush()
  }
}
