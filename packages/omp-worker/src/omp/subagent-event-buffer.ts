import { isJsonObject, type JsonObject } from "@ompiui/protocol"
import { EventSnapshotBuffer } from "./event-snapshot-buffer.js"
import { SubagentMessageStream } from "./subagent-message-stream.js"

/** 累计快照只保留最新一份；消息边界和工具状态按原顺序立即发送。 */
export class SubagentEventBuffer {
  private readonly buffer: EventSnapshotBuffer<JsonObject>
  private readonly messages: SubagentMessageStream

  constructor(emit: (event: JsonObject) => void, intervalMs = 50) {
    this.messages = new SubagentMessageStream(emit)
    this.buffer = new EventSnapshotBuffer(event => this.messages.push(event), intervalMs)
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
    this.messages.clear()
  }
}
