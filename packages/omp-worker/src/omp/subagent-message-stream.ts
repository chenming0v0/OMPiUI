import { randomUUID } from "node:crypto"
import { isJsonObject, type JsonObject } from "@ompiui/protocol"

const CHUNK_CHARS = 4096
const RECOVERY_CHARS = 2048

type MessageState = { id: string; sourceId?: string; text: string }

/** 合并快照后再计算增量；短尾部供新订阅者恢复预览，不重发累计正文。 */
export class SubagentMessageStream {
  private readonly messages = new Map<string, MessageState>()

  constructor(private readonly emit: (event: JsonObject) => void) {}

  push(frame: JsonObject): void {
    const payload = isJsonObject(frame.payload) ? frame.payload : undefined
    const event = isJsonObject(payload?.event) ? payload.event : undefined
    const message = isJsonObject(event?.message) ? event.message : undefined
    const scope = typeof payload?.id === "string" ? payload.id : ""
    const phase = event?.type === "irc_message" ? "message_end" : event?.type
    if (!scope || !event || !message || (message.role !== "assistant" && message.role !== "user" && message.role !== "agent") ||
      (phase !== "message_start" && phase !== "message_update" && phase !== "message_end")) {
      this.emit({ ...frame, eventId: randomUUID() })
      if (frame.kind === "lifecycle" &&
        (payload?.status === "completed" || payload?.status === "failed" || payload?.status === "aborted")) {
        this.messages.delete(scope)
      }
      return
    }

    // IRC 消息可以插进正在生成的回复，不能改变该回复的增量身份与偏移。
    const key = message.role === "agent" ? `${scope}\0irc` : scope
    const previous = this.messages.get(key)
    const nativeId = typeof event.messageId === "string" ? event.messageId
      : typeof message.id === "string" ? message.id : undefined
    const same = previous && phase !== "message_start" && (!nativeId || previous.sourceId === nativeId)
    const id = same ? previous.id : randomUUID()
    const content = Array.isArray(message.content) ? message.content.filter(isJsonObject) : []
    const snapshotText = typeof message.content === "string" ? message.content
      : content.filter(block => block.type === "text").map(block => String(block.text ?? "")).join("\n")
    const failedEnd = phase === "message_end" && (message.stopReason === "error" || message.stopReason === "aborted")
    const text = same && failedEnd && !snapshotText ? previous.text : snapshotText
    const thinking = content.filter(block => block.type === "thinking")
      .map(block => String(block.thinking ?? "")).join("\n").slice(-RECOVERY_CHARS)
    const tools = content.filter(block => block.type === "toolCall")
    // 非追加式修订从零替换；普通 token 流只传上次已发送长度之后的内容。
    const offset = same && text.startsWith(previous.text) ? previous.text.length : 0
    let position = offset
    do {
      const end = Math.min(text.length, position + CHUNK_CHARS)
      const last = end === text.length
      const tailOffset = Math.max(0, end - RECOVERY_CHARS)
      this.emit({
        kind: frame.kind,
        eventId: randomUUID(),
        payload: {
          id: scope,
          event: {
            type: "message_patch", messageId: id, role: message.role,
            phase: last ? phase : "message_update",
            textOffset: position, textDelta: text.slice(position, end),
            textTailOffset: tailOffset, textTail: text.slice(tailOffset, end),
            ...(last ? { thinking, tools } : {}),
          },
        },
      })
      position = end
    } while (position < text.length)
    if (phase === "message_end") this.messages.delete(key)
    else this.messages.set(key, { id, sourceId: nativeId, text })
  }

  clear(): void {
    this.messages.clear()
  }
}
