import { randomUUID } from "node:crypto"
import type { JsonObject, JsonValue } from "@ompiui/protocol"
import { isJsonObject } from "@ompiui/protocol"
import type { OmpRpcClient, OmpRpcFrame } from "./rpc-client.js"
import { nativeExtensionResourcesSource } from './resource-registry.js'
import { NATIVE_PROMPT_ADMISSION_IMPORT, NATIVE_PROMPT_ADMISSION_SOURCE } from './native-prompt-admission.js'

export type RuntimeBridgeOperation = "capabilities" | "identity" | "queue" | "clearQueue" | "removeQueuedMessage" | "sendQueuedMessage" | "submitUserMessage" | "navigateTree" | "abortBranchSummary" | "fork" | "branch" | "reload" | "setLabel" | "setScopedModels" | "cycleModel" | "resources" | "tree" | "asyncJobs" | "goal"
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
import { rm } from "node:fs/promises";
import { isUserQueuedMessage, isHiddenUserCompanion, toRestoredQueuedMessage } from "@oh-my-pi/pi-coding-agent/session/queued-messages";
import { resolveModelScope } from "@oh-my-pi/pi-coding-agent/config/model-resolver";
import { cfgDisabledExtensions } from "@oh-my-pi/pi-coding-agent/extensibility/settings";
export default function (pi) {
  const prefix = ${JSON.stringify(RESPONSE_PREFIX)};
  const queueEntryIds = new WeakMap();
  const queueRuntimeId = randomUUID();
  let nextQueueEntryId = 0;
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
  function identity(session) {
    return { sessionId: session.sessionManager.getSessionId(), sessionFile: session.sessionFile ?? null, leafId: session.sessionManager.getLeafId(), cwd: session.sessionManager.getCwd() };
  }
  function queue(session, includeImageData = false) {
    const restore = message => {
      const entry = toRestoredQueuedMessage(message);
      entry.entryId = queueEntryId(session, message);
      if (!includeImageData && entry.images) entry.images = entry.images.map(image => { const { data, ...metadata } = image; return { ...metadata, dataOmitted: true }; });
      return entry;
    };
    const steeringEntries = session.agent.peekSteeringQueue().filter(isUserQueuedMessage).map(restore);
    const followUpEntries = session.agent.peekFollowUpQueue().filter(isUserQueuedMessage).map(restore);
    return { steering: steeringEntries.map(entry => entry.text), followUp: followUpEntries.map(entry => entry.text), steeringEntries, followUpEntries, scopedModels: session.scopedModels, steeringMode: session.steeringMode, followUpMode: session.followUpMode };
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
  async function execute(operation, args, ctx) {
    const session = ownSession(ctx);
    switch (operation) {
      case "capabilities": return { operations: ["identity", "queue", "clearQueue", "removeQueuedMessage", "sendQueuedMessage", "submitUserMessage", "navigateTree", "abortBranchSummary", "fork", "branch", "reload", "setLabel", "setScopedModels", "cycleModel", "resources", "tree", "asyncJobs", "goal"] };
      case "identity": return identity(session);
      case "submitUserMessage": return await submitUserMessage(session, args);
      case "queue": return queue(session);
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
        budget(result, args.maxResultBytes);
        const next = selected.source.slice();
        const moved = next.splice(selected.start, selected.userIndex - selected.start + 1);
        // Keep original normalized content/hidden image companions. Promote a
        // follow-up to the native steer queue; never clear/re-enqueue user text.
        const steering = args.kind === "steering" ? [...moved, ...next] : [...moved, ...selected.steering];
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
        const oldLeafId = session.sessionManager.getLeafId();
        const result = await session.navigateTree(args.entryId, { summarize: args.summarize === true, customInstructions: args.customInstructions });
        return { ...identity(session), cancelled: result.cancelled, aborted: result.aborted, editorText: result.editorText, editorImages: result.editorImages, summaryEntry: result.summaryEntry, noOp: result.cancelled !== true && !result.aborted && result.editorText === undefined && oldLeafId === session.sessionManager.getLeafId() };
      }
      case "branch": {
        const result = await session.branch(args.entryId);
        return { ...identity(session), ...result };
      }
      case "fork": {
        if (args.position !== "at" && args.position !== "before") throw new Error("Invalid fork position");
        if (session.isStreaming || session.hasAdmittedSubmission || session.isRetrying || session.isCompacting || session.isGeneratingHandoff) throw new Error("Wait for the current run before forking");
        const entry = session.sessionManager.getEntry(args.entryId);
        if (!entry) throw new Error("Fork entry does not exist");
        if (args.position === "before" && entry.type === "message" && entry.message.role === "user") {
          return { ...await session.branch(args.entryId), ...identity(session) };
        }
        await session.sessionManager.flush();
        const source = session.sessionFile;
        if (!source) throw new Error("Fork requires a persisted session");
        const forked = await pi.pi.SessionManager.forkFrom(source, ctx.cwd, session.sessionManager.getSessionDir(), undefined, { suppressBreadcrumb: true });
        let target;
        try {
          const leafId = args.position === "before" ? entry.parentId : entry.id;
          // The native loader restores the last journal entry, not an in-memory
          // leaf. A native empty summary anchor durably selects this fork path
          // while retaining inherited sibling subtrees in the new file.
          forked.branchWithSummary(leafId, "", { targetId: args.entryId, position: args.position });
          await forked.flush();
          target = forked.getSessionFile();
        } finally { await forked.close(); }
        if (!target) throw new Error("Fork did not create a session file");
        let switched;
        try { switched = await session.switchSession(target); }
        catch (error) {
          if (session.sessionFile !== target) {
            await rm(target, { force: true });
            await rm(target.slice(0, -".jsonl".length), { recursive: true, force: true });
          }
          throw error;
        }
        if (!switched) {
          await rm(target, { force: true });
          await rm(target.slice(0, -".jsonl".length), { recursive: true, force: true });
        }
        return { ...identity(session), cancelled: switched === false, selectedText: "", selectedImages: [] };
      }
      case "reload": await ctx.reload(); await session.refreshSkillsAndCommands(); return identity(session);
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
        const scopedModels = await resolveModelScope(args.patterns, session.modelRegistry, undefined, session.settings);
        session.setScopedModels(scopedModels);
        return { scopedModels: session.scopedModels };
      }
      case "cycleModel": return await session.cycleModel(args.direction === "backward" ? "backward" : "forward") ?? null;
      case "tree": return { ...identity(session), entries: session.sessionManager.getEntries(), tree: session.sessionManager.getTree() };
      case "asyncJobs": return ctx.getAsyncJobSnapshot();
      case "goal": {
        // #354: 目标生命周期代理到官方 GoalRuntime（create/replace/pause/resume/drop），
        // worker 不再自建续跑循环。按官方 TUI 语义同步 goal 工具与流中上下文：
        // 启用/恢复时把 goal 工具加入活动集（模型经它上报完成），暂停/放弃时移除。
        const officialAgent = session.agent;
        const runtime = officialAgent?.goalRuntime;
        const stateReader = officialAgent?.getGoalModeState;
        if (!runtime || typeof stateReader !== "function") {
          throw Object.assign(new Error("The selected OMP runtime does not expose the official goal runtime"), { code: "CAPABILITY_DISABLED" });
        }
        const readState = () => {
          const state = stateReader.call(officialAgent);
          return state === undefined || state === null ? null : JSON.parse(JSON.stringify(state));
        };
        const op = args.op;
        if (op === "snapshot") return { state: readState() };
        const objective = typeof args.objective === "string" ? args.objective.trim() : "";
        const tokenBudget = typeof args.tokenBudget === "number" ? args.tokenBudget : undefined;
        let state;
        if (op === "create" || op === "replace") {
          const previous = officialAgent.getEnabledToolNames().filter(name => name !== "goal");
          state = op === "create"
            ? await runtime.createGoal({ objective, tokenBudget })
            : await runtime.replaceGoal({ objective, tokenBudget });
          await officialAgent.setActiveToolsByName([...new Set([...previous, "goal"])]);
          if (officialAgent.isStreaming) await officialAgent.sendGoalModeContext({ deliverAs: "steer" });
        }
        else if (op === "pause") {
          state = await runtime.pauseGoal();
          await officialAgent.setActiveToolsByName(officialAgent.getEnabledToolNames().filter(name => name !== "goal"));
        }
        else if (op === "resume") {
          const previous = officialAgent.getEnabledToolNames().filter(name => name !== "goal");
          state = await runtime.resumeGoal();
          await officialAgent.setActiveToolsByName([...new Set([...previous, "goal"])]);
        }
        else if (op === "drop") {
          state = await runtime.dropGoal();
          await officialAgent.setActiveToolsByName(officialAgent.getEnabledToolNames().filter(name => name !== "goal"));
        }
        else throw Object.assign(new Error("Invalid goal operation"), { code: "INVALID_REQUEST" });
        return { state: state === undefined ? null : JSON.parse(JSON.stringify(state)) };
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