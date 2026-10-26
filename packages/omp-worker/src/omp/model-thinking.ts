import type { JsonObject } from "@ompiui/protocol"
import { isJsonObject } from "@ompiui/protocol"

/**
 * Official OMP >= 18.2.11 reads reasoning + thinking.efforts for discovery;
 * native get_available_thinking_levels prepends off. Read the RPC metadata
 * directly so standalone binaries do not need an installed source package.
 */
export function withSupportedThinkingLevels(model: JsonObject): JsonObject {
  const supportedThinkingLevels = ["off"]
  const thinking = model.thinking
  if (model.reasoning === true && isJsonObject(thinking) && Array.isArray(thinking.efforts)) {
    for (const effort of thinking.efforts) {
      if (typeof effort === "string") supportedThinkingLevels.push(effort)
    }
  }
  return { ...model, supportedThinkingLevels }
}
