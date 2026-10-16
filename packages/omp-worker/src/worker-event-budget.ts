import { jsonByteSize } from "@ompiui/protocol"
import type { WorkerMessage } from "./ipc.js"

/** 超大事件保留恢复通知，不扩大 IPC 上限，也不因正文过大终止 runtime。 */
export function boundedWorkerEvent(message: WorkerMessage, limit: number): WorkerMessage {
  if (message.kind !== "event" || jsonByteSize(message, limit) <= limit) return message
  return {
    kind: "event",
    generation: message.generation,
    ...("sessionId" in message ? { sessionId: message.sessionId } : {}),
    channel: "payload.omitted",
    event: { channel: message.channel, originalBytes: jsonByteSize(message, Number.MAX_SAFE_INTEGER) },
  }
}
