import { isJsonObject, type JsonObject } from "@ompiui/protocol"

/** 仅裁剪进度事件的未消费字段；开始、结束及落盘结果保持完整。 */
export function projectToolUpdate(event: JsonObject): JsonObject {
  if (event.type !== "tool_execution_update") return event
  const projected = { ...event }
  delete projected.args
  if (isJsonObject(event.partialResult)) {
    projected.partialResult = { content: event.partialResult.content }
  }
  return projected
}

// 对齐前端 normalizeProgress；身份字段仍用于恢复和多子代理分流。
const PROGRESS_FIELDS = [
  "id", "index", "status", "currentTool", "currentToolArgs", "currentToolStartMs",
  "recentTools", "recentOutput", "toolCount", "requests", "tokens", "contextTokens",
  "contextWindow", "cost", "durationMs", "resolvedModel", "lastIntent",
] as const

export function projectSubagentPayload(kind: string, payload: JsonObject): JsonObject {
  if (kind === "event" && isJsonObject(payload.event)) {
    return { ...payload, event: projectToolUpdate(payload.event) }
  }
  if (kind !== "progress" || !isJsonObject(payload.progress)) return payload
  const progress: JsonObject = {}
  for (const key of PROGRESS_FIELDS) {
    if (payload.progress[key] !== undefined) progress[key] = payload.progress[key]
  }
  // 工具结果通过最终事件和原生历史提供，不在进度及 state.get 中再次嵌套。
  return { ...payload, progress }
}
