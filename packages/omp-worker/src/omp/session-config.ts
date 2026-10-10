import { isJsonObject, type JsonObject } from "@ompiui/protocol"

/** 只读取当前分支的默认模型，辅助角色和临时回退回复不能覆盖显式选择。 */
export function sessionConfigFromBranch(branch: JsonObject[]): { model: JsonObject | null; thinkingLevel: string } {
  let model: JsonObject | null = null
  let explicitModel = false
  let thinkingLevel = "off"
  let explicitThinking = false
  for (const entry of branch) {
    if (entry.type === "thinking_level_change") {
      thinkingLevel = typeof entry.thinkingLevel === "string" ? entry.thinkingLevel : "off"
      explicitThinking = true
    } else if (entry.type === "model_change" && (entry.role === undefined || entry.role === "default")) {
      if (typeof entry.provider === "string" && typeof entry.modelId === "string") {
        model = { provider: entry.provider, id: entry.modelId }
        explicitModel = true
      } else if (typeof entry.model === "string") {
        const separator = entry.model.indexOf("/")
        if (separator > 0) {
          model = { provider: entry.model.slice(0, separator), id: entry.model.slice(separator + 1) }
          explicitModel = true
        }
      }
    } else if (entry.type === "session_init" || (entry.type === "omp.dropped" && entry.droppedType === "session_init")) {
      // 子代理初始化选择器可能包含思考强度后缀，显式变更记录仍优先。
      if (typeof entry.resolvedModel !== "string") continue
      const selector = entry.resolvedModel
      const suffix = /:(off|minimal|low|medium|high|xhigh|max|auto)$/.exec(selector)
      const identity = suffix ? selector.slice(0, suffix.index) : selector
      const separator = identity.indexOf("/")
      if (!explicitModel && separator > 0) {
        model = { provider: identity.slice(0, separator), id: identity.slice(separator + 1) }
        explicitModel = true
      }
      if (!explicitThinking && suffix) thinkingLevel = suffix[1]!
    } else if (!explicitModel && entry.type === "message" && isJsonObject(entry.message)) {
      const message = entry.message
      if (message.role === "assistant" && typeof message.provider === "string" && typeof message.model === "string") {
        model = { provider: message.provider, id: message.model }
      }
    }
  }
  return { model, thinkingLevel }
}
