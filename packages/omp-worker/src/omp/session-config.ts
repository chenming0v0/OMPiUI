import { isJsonObject, type JsonObject, type SessionRedoPlan } from "@ompiui/protocol"

export const REDO_ENTRY_TYPE = "ompiui.redo"

/** The native marker selects this branch but is not itself a redo checkpoint. */
export function sessionRedoPlanFromBranch(branch: readonly JsonObject[], sessionId: string, leafId?: string | null): SessionRedoPlan | null {
  let cursor = leafId
  for (let index = branch.length - 1; index >= 0; index--) {
    const entry = branch[index]!
    if (leafId !== undefined) {
      if (cursor === null) return null
      if (entry.id !== cursor) continue
      cursor = typeof entry.parentId === "string" ? entry.parentId : null
    }
    if ((entry.type === "message" && isJsonObject(entry.message) && entry.message.role === "user") ||
        entry.type === "reset_boundary" || entry.type === "branch_summary") return null
    if (entry.type !== "custom" || entry.customType !== REDO_ENTRY_TYPE) continue
    const plan = entry.data
    if (!isJsonObject(plan) || typeof plan.id !== "string" || plan.sessionId !== sessionId ||
        (plan.undoLeafId !== null && typeof plan.undoLeafId !== "string") ||
        !Array.isArray(plan.checkpoints) || !plan.checkpoints.every(id => typeof id === "string") ||
        typeof plan.restored !== "number" || !Number.isInteger(plan.restored) ||
        plan.restored < 0 || plan.restored >= plan.checkpoints.length) return null
    // 分支条目来自 runtime 沙箱，数组是另一个 realm 的对象；跨 realm 的原型会让
    // deepStrictEqual 判为不同，这里复制成本 realm 的普通数组。
    return { id: plan.id, undoLeafId: plan.undoLeafId, checkpoints: Array.from(plan.checkpoints, id => String(id)), restored: plan.restored }
  }
  return null
}

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

/** Read the native mode_change snapshot on this branch without restoring a runtime. */
export function sessionGoalFromBranch(branch: JsonObject[]): JsonObject | null {
  let entry: JsonObject | undefined
  for (let index = branch.length - 1; index >= 0; index--) {
    if (branch[index]?.type === "mode_change") {
      entry = branch[index]
      break
    }
  }
  if (!entry || (entry.mode !== "goal" && entry.mode !== "goal_paused") || !isJsonObject(entry.data) || !isJsonObject(entry.data.goal)) return null
  const goal = entry.data.goal
  // Match the official goalFromModeData boundary; do not invent missing usage.
  if (typeof goal.id !== "string" || typeof goal.objective !== "string" || typeof goal.status !== "string"
    || typeof goal.tokensUsed !== "number" || typeof goal.timeUsedSeconds !== "number"
    || typeof goal.createdAt !== "number" || typeof goal.updatedAt !== "number") return null
  // RpcGoalController reattaches the persisted mode with mode=active; it does
  // not persist the transient exiting/reason fields, including on completion.
  return { enabled: entry.mode === "goal", mode: "active", goal }
}
