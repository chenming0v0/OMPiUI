import { randomUUID } from "node:crypto"
import type { JsonObject, JsonValue } from "@ompiui/protocol"
import { isJsonObject } from "@ompiui/protocol"
import type { OmpRpcClient, OmpRpcFrame } from "./rpc-client.js"
import { nativeExtensionResourcesSource } from './resource-registry.js'
import { NATIVE_PROMPT_ADMISSION_IMPORT, NATIVE_PROMPT_ADMISSION_SOURCE } from './native-prompt-admission.js'
import { NATIVE_WORKTREE_IMPORTS, NATIVE_WORKTREE_SOURCE } from './native-worktree.js'
import { nativeToolInteractionImports, nativeToolInteractionSource } from './native-tool-interaction.js'
import { nativeSubagentObservationPrelude, nativeSubagentObservationSource } from './native-subagent-observation.js'
import { nativeSessionTitleImports, nativeSessionTitleSource } from './native-session-title.js'
import { nativeContextMaintenanceImports, nativeContextMaintenanceSource } from './native-context-maintenance.js'
import { REDO_ENTRY_TYPE } from './session-config.js'

export type RuntimeBridgeOperation = "capabilities" | "compact" | "identity" | "queue" | "clearQueue" | "removeQueuedMessage" | "sendQueuedMessage" | "submitUserMessage" | "prepareStop" | "resumeStoppedSession" | "navigateTree" | "abortBranchSummary" | "fork" | "branch" | "reload" | "setLabel" | "setScopedModels" | "cycleModel" | "resources" | "tree" | "asyncJobs" | "inspectAsyncJob" | "cancelAsyncJob" | "goal" | "moveSession" | "worktreeState"
const RESPONSE_PREFIX = "\u001eompiui-runtime:"

/** Correlates managed command results without exposing control traffic as chat/UI events. */
export class RuntimeBridgeTransport {
  private readonly pending = new Map<string, { resolve: (value: JsonValue) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>()
  private readonly promptIds = new Map<string, string>()

  handleFrame(frame: OmpRpcFrame): boolean {
    if (frame.type === "prompt_result" && typeof frame.id === "string" && frame.id.startsWith("ompiui_runtime_")) {
      const requestId = this.promptIds.get(frame.id)
      this.promptIds.delete(frame.id)
      if (frame.status === "error") {
        const pending = requestId ? this.pending.get(requestId) : undefined
        if (pending) {
          this.pending.delete(requestId!)
          clearTimeout(pending.timer)
          pending.reject(Object.assign(new Error(isJsonObject(frame.error) && typeof frame.error.message === "string" ? frame.error.message : "Managed runtime command failed"), { code: frame.code }))
        }
      }
      return true
    }
    if (frame.type !== "extension_ui_request" || frame.method !== "notify" || typeof frame.message !== "string" || !frame.message.startsWith(RESPONSE_PREFIX)) return false
    let result: unknown
    try { result = JSON.parse(frame.message.slice(RESPONSE_PREFIX.length)) } catch { return true }
    if (!isJsonObject(result) || typeof result.id !== "string") return true
    const pending = this.pending.get(result.id)
    if (!pending) return true
    this.pending.delete(result.id)
    clearTimeout(pending.timer)
    if (result.success === true) pending.resolve(result.data ?? null)
    else pending.reject(Object.assign(new Error(typeof result.error === "string" ? result.error : "Managed runtime operation failed"), { code: result.code }))
    return true
  }

  async request(client: OmpRpcClient, operation: RuntimeBridgeOperation, args: JsonObject, timeoutMs: number): Promise<JsonValue> {
    if (!client.options.applyRuntimePolicy || client.options.args?.includes("--no-ui")) {
      throw Object.assign(new Error("Managed runtime bridge requires the managed RPC UI host"), { code: "CAPABILITY_DISABLED" })
    }
    const id = randomUUID()
    const result = new Promise<JsonValue>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(Object.assign(new Error(`Managed runtime operation timed out: ${operation}; result unknown`), { code: "OMP_TIMEOUT" }))
      }, timeoutMs)
      timer.unref()
      this.pending.set(id, { resolve, reject, timer })
    })
    // Observe rejection even when the official prompt ACK itself fails first.
    void result.catch(() => {})
    const promptId = `ompiui_runtime_${id}`
    this.promptIds.set(promptId, id)
    try {
      const response = await client.request({ id: promptId, type: "prompt", message: `/ompiui-runtime ${JSON.stringify({ id, operation, args })}` }, timeoutMs)
      if (!response.success) {
        this.promptIds.delete(promptId)
        throw Object.assign(new Error(response.error ?? "Managed runtime command failed"), { code: response.code })
      }
      return await result
    } finally {
      this.promptIds.delete(promptId)
      const pending = this.pending.get(id)
      if (pending) { clearTimeout(pending.timer); this.pending.delete(id) }
    }
  }

  close(error: Error): void {
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(error) }
    this.pending.clear()
    this.promptIds.clear()
  }
}


/** Generate canonical public imports resolved by the official host loader. */
export function runtimeBridgeExtension(): string {
  return `${NATIVE_PROMPT_ADMISSION_IMPORT}
import { randomUUID } from "node:crypto";
import { isUserQueuedMessage, isHiddenUserCompanion, toRestoredQueuedMessage } from "@oh-my-pi/pi-coding-agent/session/queued-messages";
import { resolveModelScope, getModelMatchPreferences, formatModelStringWithRouting } from "@oh-my-pi/pi-coding-agent/config/model-resolver";
import { cfgDisabledExtensions } from "@oh-my-pi/pi-coding-agent/extensibility/settings";
${NATIVE_WORKTREE_IMPORTS}
${nativeToolInteractionImports}
${nativeSessionTitleImports}
${nativeContextMaintenanceImports}
${nativeSubagentObservationPrelude}
export default function (pi) {
  const prefix = ${JSON.stringify(RESPONSE_PREFIX)};
  const queueEntryIds = new WeakMap();
  const queueRuntimeId = randomUUID();
  let nextQueueEntryId = 0;
  function scopePatterns(session) {
    return session.scopedModels.map(scoped => formatModelStringWithRouting(scoped.model) + (scoped.thinkingLevel === undefined ? "" : ":" + scoped.thinkingLevel));
  }
  function queueEntryId(session, message) {
    let id = queueEntryIds.get(message);
    if (!id) { id = queueRuntimeId + ":" + session.sessionManager.getSessionId() + ":" + (++nextQueueEntryId); queueEntryIds.set(message, id); }
    return id;
  }
  function ownSession(ctx) {
    const manager = ctx.sessionManager;
    const id = manager.getSessionId();
    const file = manager.getSessionFile();
    const ref = pi.pi.AgentRegistry.global().list().find(ref => ref.session && ref.session.sessionManager.getSessionId() === id && ref.session.sessionManager.getSessionFile() === file);
    if (!ref) throw Object.assign(new Error("Current managed session is not registered"), { code: "CAPABILITY_DISABLED" });
    return ref.session;
  }
  ${nativeSubagentObservationSource}
  ${nativeToolInteractionSource}
  ${nativeSessionTitleSource}
  ${nativeContextMaintenanceSource}
  function identity(session) {
    return { sessionId: session.sessionManager.getSessionId(), sessionFile: session.sessionFile ?? null, leafId: session.sessionManager.getLeafId(), cwd: session.sessionManager.getCwd() };
  }
  const redoEntryType = ${JSON.stringify(REDO_ENTRY_TYPE)};
  function isRedoMarker(entry) {
    return entry.type === "custom" && entry.customType === redoEntryType;
  }
  function isUserTurn(entry) {
    return entry.type === "message" && entry.message.role === "user";
  }
  function redoCheckpoints(branch, entryId) {
    const index = branch.findIndex(entry => entry.id === entryId);
    if (index < 0) return [];
    const checkpoints = [];
    let landing;
    for (const entry of branch.slice(index + (isUserTurn(branch[index]) ? 0 : 1))) {
      if (isUserTurn(entry)) {
        if (landing) checkpoints.push(landing);
        landing = undefined;
      } else if (entry.type !== "custom_message" && !isRedoMarker(entry) &&
                 !(entry.type === "custom" && entry.customType === "session_exit")) {
        landing = entry.id;
      }
    }
    if (landing) checkpoints.push(landing);
    return checkpoints;
  }
  function pendingRedo(branch) {
    for (let index = branch.length - 1; index >= 0; index--) {
      const entry = branch[index];
      if (isUserTurn(entry) || entry.type === "reset_boundary" || entry.type === "branch_summary") return null;
      if (isRedoMarker(entry)) return entry.data ?? null;
    }
    return null;
  }
  function queue(session, includeImageData = false, submittedQueueEntryIds = []) {
    const restore = message => {
      const entry = toRestoredQueuedMessage(message);
      entry.entryId = queueEntryId(session, message);
      if (!includeImageData && entry.images) entry.images = entry.images.map(image => { const { data, ...metadata } = image; return { ...metadata, dataOmitted: true }; });
      return entry;
    };
    const steeringEntries = session.agent.peekSteeringQueue().filter(isUserQueuedMessage).map(restore);
    const followUpEntries = session.agent.peekFollowUpQueue().filter(isUserQueuedMessage).map(restore);
    const submittedIds = new Set(submittedQueueEntryIds);
    // appendMessage retains the native message object. Correlate that identity,
    // not chip text/timestamps, without annotating the original session history.
    const submittedHistoryEntries = submittedIds.size ? session.sessionManager.getEntries().flatMap(entry => {
      const queueEntryId = entry.type === "message" ? queueEntryIds.get(entry.message) : undefined;
      return submittedIds.has(queueEntryId) ? [{ queueEntryId, historyEntryId: entry.id }] : [];
    }) : [];
    return { steering: steeringEntries.map(entry => entry.text), followUp: followUpEntries.map(entry => entry.text), steeringEntries, followUpEntries, submittedHistoryEntries, scopedModels: session.scopedModels, scopedModelPatterns: scopePatterns(session), steeringMode: session.steeringMode, followUpMode: session.followUpMode };
  }
  function budget(value, maxBytes) {
    if (maxBytes !== undefined && (!Number.isSafeInteger(maxBytes) || maxBytes < 0)) throw new Error("Invalid response capacity");
    if (Buffer.byteLength(JSON.stringify(value), "utf8") > Math.min(maxBytes ?? 16 * 1024 * 1024, 16 * 1024 * 1024)) {
      throw Object.assign(new Error("Queue result exceeds available response capacity; the queue was not modified"), { code: "FILE_TOO_LARGE" });
    }
  }
  function selectQueued(session, args) {
    if ((args.kind !== "steering" && args.kind !== "followUp") || !Number.isInteger(args.index) || args.index < 0) throw new Error("Invalid queue selection");
    const steering = session.agent.peekSteeringQueue();
    const followUp = session.agent.peekFollowUpQueue();
    const source = args.kind === "steering" ? steering : followUp;
    let userIndex = -1;
    let seen = 0;
    for (let index = 0; index < source.length; index++) {
      if (isUserQueuedMessage(source[index]) && seen++ === args.index) { userIndex = index; break; }
    }
    if (userIndex < 0) throw new Error("Queue entry no longer exists");
    if (typeof args.entryId !== "string" || queueEntryId(session, source[userIndex]) !== args.entryId) throw Object.assign(new Error("Queue selection changed; refresh before retrying"), { code: "QUEUE_SELECTION_STALE" });
    let start = userIndex;
    while (start > 0 && isHiddenUserCompanion(source[start - 1])) start--;
    return { steering, followUp, source, userIndex, start, restored: toRestoredQueuedMessage(source[userIndex]) };
  }
  ${nativeExtensionResourcesSource}
  ${NATIVE_PROMPT_ADMISSION_SOURCE}
  ${NATIVE_WORKTREE_SOURCE}
  // 手动 Stop 的门禁：官方 client-owned continuation 开关必须在 abort 之前打开，
  // 否则官方中止清理会重新启动下一轮；只读刷新不解除，明确提交／立即发送／恢复目标才解除。
  const queueControlKey = Symbol.for("ompiui.queueControl");
  function queueControl(session) {
    return session[queueControlKey] ??= { paused: false };
  }
  function prepareStop(session) {
    if (typeof session.setClientBridge !== "function") throw Object.assign(new Error("The selected OMP runtime cannot suspend queued continuation"), { code: "CAPABILITY_DISABLED" });
    const control = queueControl(session);
    if (!control.paused) { control.originalClientBridge = session.clientBridge; control.paused = true; }
    const original = control.originalClientBridge;
    // 不改队列内容：不消费、不替换、不复制、不回填草稿。
    session.setClientBridge({ ...original, capabilities: original?.capabilities ?? {}, deferAgentInitiatedTurns: true });
    return identity(session);
  }
  function resumeStoppedSession(session) {
    const control = session[queueControlKey];
    if (!control?.paused) return;
    session.setClientBridge(control.originalClientBridge);
    control.paused = false;
    delete control.originalClientBridge;
  }
  // 进程内原生 all 模式：该方向全部未消费消息在同一轮进入模型上下文，只改
  // 本次会话的原生对象，不写官方全局设置。运行时不提供该能力时保持默认队列
  // 行为并继续提交，能力缺口不能挡住用户消息。
  async function configureQueueBatching(session) {
    for (const [method, key] of [["setSteeringMode", "steeringMode"], ["setFollowUpMode", "followUpMode"]]) {
      if (session[key] === "all") continue;
      try {
        if (typeof session[method] === "function") await session[method]("all");
        else session[key] = "all";
      } catch {}
    }
  }
  async function execute(operation, args, ctx) {
    reconcileSubagentObservation(ctx);
    const session = ownSession(ctx);
    switch (operation) {
      case "capabilities": return { operations: ["identity", "compact", "queue", "clearQueue", "removeQueuedMessage", "sendQueuedMessage", "submitUserMessage", "prepareStop", "resumeStoppedSession", "navigateTree", "abortBranchSummary", "fork", "branch", "reload", "setLabel", "setScopedModels", "cycleModel", "resources", "tree", "asyncJobs", "inspectAsyncJob", "cancelAsyncJob", "goal", ...(typeof session.moveSession === "function" && typeof session.sessionManager.isSessionOnDisk === "function" ? ["moveSession", "worktreeState"] : [])] };
      case "identity": return identity(session);
      case "compact": {
        const result = await session.compact(args.customInstructions, { mode: args.mode });
        // 原生返回值没有方法和压缩后 token；从刚提交的原生记录读取，不能用请求方法冒充实际方法。
        const entry = session.sessionManager.getBranch().findLast(entry => entry.type === "compaction");
        return { ...result, ...(entry ? { entryId: entry.id, method: entry.method, tokensAfter: entry.tokensAfter } : {}) };
      }
      case "prepareStop": return prepareStop(session);
      case "resumeStoppedSession": resumeStoppedSession(session); return identity(session);
      case "worktreeState": {
        if (typeof session.moveSession !== "function" || typeof session.sessionManager.isSessionOnDisk !== "function") throw Object.assign(new Error("Native worktree session relocation is unavailable"), { code: "CAPABILITY_DISABLED" });
        return { ...identity(session), sessionFileReady: session.sessionManager.isSessionOnDisk() };
      }
      case "moveSession": return await moveWorktreeSession(session, args, ctx);
      case "submitUserMessage": return await submitUserMessage(session, args);
      case "queue": return { ...queue(session, false, args.submittedQueueEntryIds), ...contextMaintenance(session, args.pruningRevision) };
      case "clearQueue": {
        const result = queue(session, true);
        budget(result, args.maxResultBytes);
        session.clearQueue();
        return result;
      }
      case "removeQueuedMessage": {
        const selected = selectQueued(session, args);
        const result = args.returnContent === false ? { removed: true } : selected.restored;
        budget(result, args.maxResultBytes);
        const next = selected.source.slice();
        next.splice(selected.start, selected.userIndex - selected.start + 1);
        session.agent.replaceQueues(args.kind === "steering" ? next : selected.steering.slice(), args.kind === "followUp" ? next : selected.followUp.slice());
        return result;
      }
      case "sendQueuedMessage": {
        const selected = selectQueued(session, args);
        if (session.isRetrying || session.isCompacting || session.isGeneratingHandoff) throw new Error("Wait for the current submission before sending queued content");
        const result = { accepted: true };
        const nativeMessage = selected.source[selected.userIndex];
        // Only ordinary user turns retain their message object in native history.
        // Visible custom prompts keep their existing native queue/display behavior.
        if (nativeMessage.role === "user") {
          const content = [{ type: "text", text: selected.restored.text }, ...(selected.restored.images ?? []).map(image => {
            const { data, ...metadata } = image;
            return { ...metadata, type: "image", data: "", dataOmitted: true };
          })];
          result.submittedMessage = {
            id: "submitted:" + args.entryId, queueEntryId: args.entryId, submissionStatus: "queued",
            message: { role: "user", timestamp: nativeMessage.timestamp, content },
          };
        }
        budget(result, args.maxResultBytes);
        const next = selected.source.slice();
        const moved = next.splice(selected.start, selected.userIndex - selected.start + 1);
        // Keep original normalized content/hidden image companions. Promote a
        // follow-up to the native steer queue; never clear/re-enqueue user text.
        const steering = args.kind === "steering" ? [...moved, ...next] : [...selected.steering, ...moved];
        const followUp = args.kind === "followUp" ? next : selected.followUp.slice();
        session.agent.replaceQueues(steering, followUp);
        if (!session.isStreaming) {
          try {
            const continuation = session.agent.continue();
            if (!session.agent.state.isStreaming) await continuation;
            else void continuation.catch(error => ctx.ui.notify(error instanceof Error ? error.message : String(error), "error"));
          } catch (error) {
            session.agent.replaceQueues(selected.steering.slice(), selected.followUp.slice());
            throw error;
          }
        }
        return result;
      }
      case "abortBranchSummary": session.abortBranchSummary(); return identity(session);
      case "navigateTree": {
        const manager = session.sessionManager;
        const oldLeafId = manager.getLeafId();
        const tracksRedo = args.trackRedo === true || typeof args.redoPlanId === "string";
        const oldBranch = tracksRedo ? manager.getBranch().slice() : [];
        const priorPlan = pendingRedo(oldBranch);
        const sessionId = manager.getSessionId();
        const checkpoints = args.trackRedo === true ? redoCheckpoints(oldBranch, args.entryId) : [];
        const redoIndex = typeof args.redoPlanId === "string" && priorPlan?.sessionId === sessionId && priorPlan.id === args.redoPlanId && Array.isArray(priorPlan.checkpoints)
          ? priorPlan.checkpoints.indexOf(args.entryId) : -1;
        if (typeof args.redoPlanId === "string" && (redoIndex < 0 || redoIndex < priorPlan.restored)) {
          throw Object.assign(new Error("Redo plan has changed; refresh the session"), { code: "SESSION_CONFLICT" });
        }
        const result = await session.navigateTree(args.entryId, { summarize: args.summarize === true, customInstructions: args.customInstructions, ...(tracksRedo ? { requireIdle: true } : {}) });
        const noOp = result.cancelled !== true && !result.aborted && result.editorText === undefined && oldLeafId === manager.getLeafId();
        let projectionError;
        if (tracksRedo && !result.cancelled && !result.aborted && !noOp && manager === session.sessionManager) {
          try {
            // Append through the native session manager: a hidden custom entry selects
            // the committed branch on resume without changing messages or session identity.
            const newLeaf = manager.getLeafId();
            const nextPlan = redoIndex >= 0 && priorPlan && newLeaf === args.entryId
              ? (redoIndex + 1 < priorPlan.checkpoints.length ? { ...priorPlan, restored: redoIndex + 1 } : null)
              : checkpoints.length ? { id: randomUUID(), sessionId, undoLeafId: newLeaf, checkpoints, restored: 0 } : null;
            manager.appendCustomEntry(redoEntryType, nextPlan);
            await manager.flush();
          } catch (error) {
            projectionError = error instanceof Error ? error.message : String(error);
          }
        }
        return { ...identity(session), cancelled: result.cancelled, aborted: result.aborted, editorText: result.editorText, editorImages: result.editorImages, summaryEntry: result.summaryEntry, noOp, projectionError };
      }
      case "branch": {
        const result = await session.branch(args.entryId);
        return { ...identity(session), ...result };
      }
      case "fork": {
        if (args.position !== "at" && args.position !== "before") throw new Error("Invalid fork position");
        if (session.isStreaming || session.hasAdmittedSubmission || session.isRetrying || session.isCompacting || session.isGeneratingHandoff) throw new Error("Wait for the current run before forking");
        const entry = session.sessionManager.getEntry(args.entryId);
        if (!entry || entry.type !== "message") throw new Error("Fork requires a native message entry");
        if (args.position === "before") {
          if (entry.message.role !== "user") throw new Error("Native before-message fork requires a user message");
          return { ...await session.branch(args.entryId), ...identity(session) };
        }
        // The official entry fork preserves artifacts, completes recorded tool
        // batches, and honors session_before_branch cancellation atomically.
        const completed = await session.fork(args.entryId);
        return { ...identity(session), cancelled: !completed, selectedText: "", selectedImages: [] };
      }
      case "reload": {
        stopSubagentObservation();
        try { await ctx.reload(); await session.refreshSkillsAndCommands(); return identity(session); }
        finally { reconcileSubagentObservation(ctx); }
      }
      case "resources": {
        const extensions = extensionResources(session);
        let contextFiles = null;
        try { contextFiles = await pi.pi.discoverContextFiles(ctx.cwd, undefined, cfgDisabledExtensions.get(session.settings)); }
        catch (error) { extensions.resourceErrors.contextFiles = error instanceof Error ? error.message : String(error); }
        return { skills: session.skills, skillWarnings: session.skillWarnings, prompts: session.promptTemplates, contextFiles, commands: pi.getCommands().filter(command => command.name !== "ompiui-runtime"), tools: pi.getAllTools(), activeTools: pi.getActiveTools(), systemPrompt: ctx.getSystemPrompt(), sessionDir: session.sessionManager.getSessionDir(), artifactsDir: session.sessionManager.getArtifactsDir(), ...extensions };
      }
      case "setLabel": {
        session.sessionManager.appendLabelChange(args.entryId, args.label);
        await session.sessionManager.flush();
        return { label: session.sessionManager.getLabel(args.entryId) ?? null };
      }
      case "setScopedModels": {
        if (!Array.isArray(args.patterns) || !args.patterns.every(pattern => typeof pattern === "string")) throw new Error("Invalid model scope");
        await session.modelRegistry.awaitBackgroundRefresh();
        const scopedModels = await resolveModelScope(args.patterns, session.modelRegistry, getModelMatchPreferences(session.settings), session.settings);
        session.setScopedModels(scopedModels);
        return { scopedModels: session.scopedModels, scopedModelPatterns: scopePatterns(session) };
      }
      case "cycleModel": return await session.cycleModel(args.direction === "backward" ? "backward" : "forward") ?? null;
      case "tree": return { ...identity(session), entries: session.sessionManager.getEntries(), tree: session.sessionManager.getTree() };
      case "asyncJobs": return ctx.getAsyncJobSnapshot();
      case "inspectAsyncJob": {
        if (typeof session.inspectAsyncJob !== "function") throw Object.assign(new Error("The selected OMP runtime cannot inspect background jobs"), { code: "CAPABILITY_DISABLED" });
        const job = session.inspectAsyncJob(String(args.id));
        return job ? { command: job.command, cwd: job.cwd, pids: job.pids, exitCode: job.exitCode, output: job.output, artifactId: job.artifactId } : null;
      }
      case "cancelAsyncJob": {
        if (typeof session.cancelAsyncJob !== "function") throw Object.assign(new Error("The selected OMP runtime cannot cancel background jobs"), { code: "CAPABILITY_DISABLED" });
        return { cancelled: session.cancelAsyncJob(String(args.id)) };
      }
      case "goal": {
        // Native RPC owns create/get/pause/resume/drop and the only continuation
        // driver. The supported AgentSession GoalRuntime supplies the operations
        // not present in the RPC goal command; never synthesize lifecycle events.
        const runtime = session.goalRuntime;
        const stateReader = session.getGoalModeState;
        if (!runtime || typeof stateReader !== "function") {
          throw Object.assign(new Error("The selected OMP runtime does not expose the official goal runtime"), { code: "CAPABILITY_DISABLED" });
        }
        const op = args.op;
        const method = op === "replace" ? "replaceGoal" : op === "complete" ? "completeGoalFromTool" : op === "budget" ? "onBudgetMutated" : undefined;
        if (!method || typeof runtime[method] !== "function") {
          throw Object.assign(new Error("The selected OMP runtime does not expose goal operation: " + op), { code: "CAPABILITY_DISABLED" });
        }
        if (Array.isArray(args.images) && args.images.length) throw Object.assign(new Error("The official goal runtime does not support image attachments on goals"), { code: "INVALID_REQUEST" });
        if (op === "replace") await runtime.replaceGoal({ objective: args.objective, tokenBudget: args.tokenBudget });
        else if (op === "complete") await runtime.completeGoalFromTool();
        else await runtime.onBudgetMutated(args.clearBudget === true ? undefined : args.tokenBudget);
        const state = stateReader.call(session);
        await session.sessionManager.flush();
        return { state: state == null ? null : JSON.parse(JSON.stringify(state)) };
      }
      default: throw Object.assign(new Error("Unknown managed runtime operation: " + operation), { code: "CAPABILITY_DISABLED" });
    }
  }
  pi.registerCommand("ompiui-runtime", {
    description: "Managed OMPiUI runtime control (not a model prompt)",
    handler: async (text, ctx) => {
      let request;
      try { request = JSON.parse(text); } catch { throw new Error("Invalid managed runtime request"); }
      if (!request || typeof request.id !== "string" || typeof request.operation !== "string") throw new Error("Invalid managed runtime envelope");
      const expectedId = ctx.sessionManager.getSessionId();
      const expectedFile = ctx.sessionManager.getSessionFile();
      // Slash dispatch itself counts as an admitted prompt. Run after it has
      // returned, then guard any other admitted submission via the public API.
      ctx.setTimeout(async () => {
        let response;
        try {
          if (ctx.sessionManager.getSessionId() !== expectedId || ctx.sessionManager.getSessionFile() !== expectedFile) throw new Error("Managed session changed before runtime operation");
          response = { id: request.id, success: true, data: await execute(request.operation, request.args ?? {}, ctx) };
        } catch (error) { response = { id: request.id, success: false, error: error instanceof Error ? error.message : String(error), code: error?.code }; }
        ctx.ui.notify(prefix + JSON.stringify(response), "info");
      }, 0);
    },
  });
}
`
}
