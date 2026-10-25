import { randomUUID } from "node:crypto"
import type { JsonObject, JsonValue } from "@ompiui/protocol"
import { isJsonObject } from "@ompiui/protocol"
import type { OmpRpcClient, OmpRpcFrame } from "./rpc-client.js"
import { nativeExtensionResourcesSource } from './resource-registry.js'
import { NATIVE_PROMPT_ADMISSION_IMPORT, NATIVE_PROMPT_ADMISSION_SOURCE } from './native-prompt-admission.js'

export type RuntimeBridgeOperation = "capabilities" | "identity" | "queue" | "clearQueue" | "removeQueuedMessage" | "sendQueuedMessage" | "submitUserMessage" | "prepareStop" | "resumeStoppedSession" | "navigateTree" | "abortBranchSummary" | "fork" | "branch" | "reload" | "setLabel" | "setScopedModels" | "cycleModel" | "resources" | "tree" | "asyncJobs" | "goal"
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
  const queueControlKey = Symbol.for("ompiui.queueControl");
  function queueControl(session) {
    return session[queueControlKey] ??= { batchConfigured: false, paused: false };
  }
  function configureQueueBatching(session) {
    const control = queueControl(session);
    if (control.batchConfigured) return;
    session.setSteeringMode("all", false);
    session.setFollowUpMode("all", false);
    control.batchConfigured = true;
  }
  function prepareStop(session) {
    if (typeof session.setClientBridge !== "function") throw Object.assign(new Error("The selected OMP runtime cannot suspend queued continuation"), { code: "CAPABILITY_DISABLED" });
    const control = queueControl(session);
    if (!control.paused) { control.originalClientBridge = session.clientBridge; control.paused = true; }
    const original = control.originalClientBridge;
    // The official client-ownership gate is checked before steering can resume.
    // No queue is consumed, replaced, copied or moved back to the editor.
    session.setClientBridge({ ...original, capabilities: original?.capabilities ?? {}, deferAgentInitiatedTurns: true });
    stopGoalLoop(session);
    return identity(session);
  }
  function resumeStoppedSession(session) {
    const control = session[queueControlKey];
    if (!control?.paused) return;
    session.setClientBridge(control.originalClientBridge);
    control.paused = false;
    delete control.originalClientBridge;
  }
  // #392: rpc-ui 不运行官方 InteractiveMode#scheduleGoalContinuation，桥内按其语义复刻：
  // 终止性 agent_end 后、goal 仍 active、空闲且无排队时投递官方续跑提示；abort/无进展抑制，
  // pause/drop/会话替换后停止。
  const goalContinuationDelayMs = 800;
  // 循环挂在 session 上（全局 symbol 跨桥实例共享），桥重载后新实例能替换旧循环，避免重复订阅。
  const goalLoopKey = Symbol.for("ompiui.goalLoop");
  function notifyError(ctx, error) { ctx.ui.notify(error instanceof Error ? error.message : String(error), "error"); }
  // 只认 sessionId：新会话首次落盘前后 sessionFile 会变化。
  function goalSessionKey(session) { return session.sessionManager.getSessionId(); }
  function goalActive(session) {
    const state = session.getGoalModeState();
    return state?.enabled === true && state.goal?.status === "active";
  }
  function goalActivity(messages) {
    const parts = (messages ?? []).flatMap(message => message?.role === "toolResult"
      ? [["result", message.toolName, message.content, message.isError === true]]
      : message?.role === "assistant" && Array.isArray(message.content)
        ? message.content.filter(block => block?.type === "toolCall").map(block => ["call", block.name, block.arguments])
        : []);
    return parts.length > 0 ? JSON.stringify(parts) : "";
  }
  function endedByAbort(messages) {
    return (messages ?? []).findLast(message => message?.role === "assistant")?.stopReason === "aborted";
  }
  function stopGoalLoop(session) {
    const loop = session[goalLoopKey];
    if (!loop) return;
    delete session[goalLoopKey];
    clearTimeout(loop.timer);
    loop.unsubscribe();
  }
  function armGoalLoop(session, ctx) {
    stopGoalLoop(session);
    const loop = { key: goalSessionKey(session), ctx, pending: 0, suppressed: false, activity: undefined, timer: undefined, unsubscribe: () => {} };
    // 不可枚举：官方展开/复制 AgentSession 时不得带走循环状态
    Object.defineProperty(session, goalLoopKey, { value: loop, configurable: true, writable: true, enumerable: false });
    loop.unsubscribe = session.subscribe(event => onGoalEvent(session, event));
  }
  function scheduleGoalContinuation(session) {
    const loop = session[goalLoopKey];
    if (!loop) return;
    clearTimeout(loop.timer);
    if (loop.suppressed) return;
    loop.timer = setTimeout(() => {
      loop.timer = undefined;
      // 定时器内异常不得逃逸，否则会杀掉 native omp 进程。
      try { fireGoalContinuation(session, loop); }
      catch (error) { notifyError(loop.ctx, error); }
    }, goalContinuationDelayMs);
  }
  function fireGoalContinuation(session, loop) {
    if (session[goalLoopKey] !== loop || loop.suppressed) return;
    if (goalSessionKey(session) !== loop.key) return stopGoalLoop(session);
    if (session.isStreaming || session.isCompacting || session.hasPostPromptWork || session.hasAdmittedSubmission) return;
    if (session.queuedMessageCount > 0 || !goalActive(session)) return;
    const prompt = session.goalRuntime.buildContinuationPrompt();
    if (!prompt) return;
    loop.pending++;
    void session.promptCustomMessage({ customType: "goal-continuation", content: prompt, display: false })
      .catch(error => { loop.pending = Math.max(0, loop.pending - 1); notifyError(loop.ctx, error); });
  }
  function onGoalEvent(session, event) {
    const loop = session[goalLoopKey];
    if (!loop) return;
    if (event.type === "agent_start") { clearTimeout(loop.timer); return; }
    if (event.type === "message_start" && event.message?.role === "user" && !event.message.synthetic) {
      loop.pending = 0;
      loop.suppressed = false;
      loop.activity = undefined;
      return;
    }
    if (event.type === "goal_updated") { if (event.state?.enabled !== true) stopGoalLoop(session); return; }
    if (event.type !== "agent_end" || event.isTerminal === false) return;
    if (goalSessionKey(session) !== loop.key) return stopGoalLoop(session);
    const activity = loop.pending > 0 ? goalActivity(event.messages) : undefined;
    loop.pending = Math.max(0, loop.pending - 1);
    // 用户 abort 后不自动续跑，直到下一条真实用户消息；续跑轮无新进展时同样抑制（同官方）。
    loop.suppressed = endedByAbort(event.messages) || (activity !== undefined && (activity === "" || activity === loop.activity));
    loop.activity = activity;
    scheduleGoalContinuation(session);
  }
  async function execute(operation, args, ctx) {
    const session = ownSession(ctx);
    switch (operation) {
      case "capabilities": return { operations: ["identity", "queue", "clearQueue", "removeQueuedMessage", "sendQueuedMessage", "submitUserMessage", "prepareStop", "resumeStoppedSession", "navigateTree", "abortBranchSummary", "fork", "branch", "reload", "setLabel", "setScopedModels", "cycleModel", "resources", "tree", "asyncJobs", "goal"] };
      case "identity": return identity(session);
      case "prepareStop": return prepareStop(session);
      case "resumeStoppedSession": resumeStoppedSession(session); return identity(session);
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
        resumeStoppedSession(session);
        configureQueueBatching(session);
        const next = selected.source.slice();
        const moved = next.splice(selected.start, selected.userIndex - selected.start + 1);
        // Keep normalized content/hidden companions; append promotions so
        // sequential Send now clicks cannot reverse the submitted order.
        const steering = args.kind === "steering" ? selected.steering.slice() : [...selected.steering, ...moved];
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
        // goalRuntime 及相关方法都在 AgentSession 上，不在底层 session.agent。
        const runtime = session.goalRuntime;
        const stateReader = session.getGoalModeState;
        // 旧运行时在任何状态改动前整体拒绝，不留半完成的 goal。
        if (!runtime || typeof stateReader !== "function" || typeof runtime.buildContinuationPrompt !== "function"
          || typeof session.subscribe !== "function" || typeof session.setActiveToolsByName !== "function"
          || typeof session.getEnabledToolNames !== "function") {
          throw Object.assign(new Error("The selected OMP runtime does not expose the official goal runtime"), { code: "CAPABILITY_DISABLED" });
        }
        const readState = () => {
          const state = stateReader.call(session);
          return state === undefined || state === null ? null : JSON.parse(JSON.stringify(state));
        };
        const op = args.op;
        if (op === "snapshot") return { state: readState() };
        const objective = typeof args.objective === "string" ? args.objective.trim() : "";
        const tokenBudget = typeof args.tokenBudget === "number" ? args.tokenBudget : undefined;
        let state;
        if (op === "create" || op === "replace") {
          resumeStoppedSession(session);
          const previous = session.getEnabledToolNames().filter(name => name !== "goal");
          state = op === "create"
            ? await runtime.createGoal({ objective, tokenBudget })
            : await runtime.replaceGoal({ objective, tokenBudget });
          await session.setActiveToolsByName([...new Set([...previous, "goal"])]);
          armGoalLoop(session, ctx);
          // 官方 InteractiveMode：流中 steer 目标上下文；空闲时把 objective 作为普通用户输入投递首轮。
          if (session.isStreaming) await session.sendGoalModeContext({ deliverAs: "steer" });
          else if (objective) void session.prompt(objective).catch(error => notifyError(ctx, error));
        }
        else if (op === "pause") {
          stopGoalLoop(session);
          state = await runtime.pauseGoal();
          await session.setActiveToolsByName(session.getEnabledToolNames().filter(name => name !== "goal"));
        }
        else if (op === "resume") {
          resumeStoppedSession(session);
          const previous = session.getEnabledToolNames().filter(name => name !== "goal");
          state = await runtime.resumeGoal();
          await session.setActiveToolsByName([...new Set([...previous, "goal"])]);
          armGoalLoop(session, ctx);
          scheduleGoalContinuation(session);
        }
        else if (op === "drop") {
          stopGoalLoop(session);
          state = await runtime.dropGoal();
          await session.setActiveToolsByName(session.getEnabledToolNames().filter(name => name !== "goal"));
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