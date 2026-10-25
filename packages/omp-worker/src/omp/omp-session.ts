import { randomUUID } from "node:crypto";
import { copyFileSync, existsSync } from "node:fs";
import type {
  BranchSyncRequest,
  ImageInput,
  JsonObject,
  JsonValue,
  PiCommandParams,
  RegistrySnapshot,
  SessionActivityStatus,
} from "@ompiui/protocol";
import { isJsonObject, utf8Prefix } from "@ompiui/protocol";
import {
  entriesPageFromEntries,
  imageAttachmentFromEntry,
  sessionHeadFromParts,
  type BranchCheckpoint,
  type EntriesPage,
  type LiveMessage,
  type SessionHead,
} from "../runtime/pagination.js";
import { buildSessionTreeFromEntries, sessionTreePage } from "../runtime/session-tree.js";
import type { PiEventMeta, SessionRuntime, Unsubscribe } from "../runtime.js";
import {
  normalizeCwd,
  readChildSessionPreviewPage,
  resolveUserPath,
} from "./omp-catalog.js";
import { OmpExtensionUiBridge } from "./omp-extension-ui.js";
import { OMP_SDK_VERSION } from "./constants.js";
import {
  detectOmpVersion,
  compareOmpVersions,
  isOmpVersionSupported,
  ompTooOldError,
} from "./omp-version.js";
import {
  OmpRpcClient,
  OmpRpcError,
  unwrapResponse,
  type OmpRpcFrame,
} from "./rpc-client.js";
import { assertOmpSessionFile, backupOmpSession } from "./managed-sessions.js";
import { SubagentEventBuffer } from "./subagent-event-buffer.js";
import { EventSnapshotBuffer } from "./event-snapshot-buffer.js";
import { BranchPageReader } from "../runtime/branch-pages.js";
import { projectStateImages, projectSubagentPayload, projectToolUpdate } from "./event-payload.js";
import { MainMessageStream } from "./main-message-stream.js";
import { getPreviewSettings } from "./preview-settings.js";
import { projectPreviewMessage } from "./subagent-preview.js";
import { requireResourceList, registryFromResources } from './resource-registry.js';
import { requestNativePromptAcceptance } from './native-rpc-prompt.js';

/**
 * OmpRpcSession —— SessionRuntime 契约的 OMP 实现。
 *
 * 每个会话 runtime 对应一个 `omp --mode rpc` 子进程，
 * 通过官方 RPC 协议（docs/rpc.md）驱动，不在 worker 内加载 Agent SDK：
 *
 * - 事件：子进程 stdout 上的 AgentSessionEvent 帧原样转发为 pi.event，
 *   仅做 OMP↔Pi 命名适配（auto_compaction_* → compaction_*、
 *   session_settled → agent_settled），前端 store 零改动。
 * - 历史：get_entries 维护内存态 append-history（播种 + since 增量），
 *   branch 页 = 从 leafId 沿 parentId 回溯的活跃路径。
 * - 子代理：set_subagent_subscription events 订阅 subagent_* 帧，
 *   经 onSubagentFrame 抛给 worker 转发到 omp.subagent 通道。
 * - 扩展 UI：extension_ui_request 帧桥接到 OMPiUI 的 ExtensionUiDialogHost。
 */
export interface OmpSessionOptions {
  bin?: string;
}

interface EntryRecord {
  id: string;
  parentId: string | null;
  timestamp: string;
  [key: string]: JsonValue | undefined;
}


// goal 续跑循环的护栏：单个目标最多自动续跑轮数 / settle 后等 entries 落地的宽限

function toJson(value: unknown): JsonValue | undefined {
  if (value === undefined) return undefined;
  return JSON.parse(
    JSON.stringify(value, (_key, item) => {
      if (typeof item === "bigint") return item.toString();
      if (typeof item === "function" || typeof item === "symbol")
        return undefined;
      if (item instanceof Error)
        return { name: item.name, message: item.message, stack: item.stack };
      return item;
    }),
  ) as JsonValue;
}

/** OMP model_change 条目用合并的 "provider/modelId"，Pi 前端读 provider+modelId —— 双写兼容 */
function adaptEntry(entry: JsonObject): JsonObject {
  if (entry.type === "model_change" && typeof entry.model === "string") {
    const slash = entry.model.indexOf("/");
    const provider = slash > 0 ? entry.model.slice(0, slash) : entry.model;
    const modelId = slash > 0 ? entry.model.slice(slash + 1) : entry.model;
    return { ...entry, provider, modelId };
  }
  // OMP 的 title/title_change/model_usage/session 条目是元数据噪声
  // （title_change 是 18.x 的自动标题写入，标题住在侧栏/session 列表；
  // session 头常见于子代理 jsonl 开头，get_entries 会原样返回），
  // Pi 前端会渲染成 unknown 行 —— 丢弃。保留 id/parentId 占位
  // （omp.dropped），分支回溯的父子链不断。
  if (
    entry.type === "title" ||
    entry.type === "title_change" ||
    entry.type === "model_usage" ||
    entry.type === "session" ||
    entry.type === "session_init"
  ) {
    return {
      type: "omp.dropped",
      id: String(entry.id ?? ""),
      parentId: (entry.parentId as string) ?? null,
      timestamp: String(entry.timestamp ?? ""),
      droppedType: entry.type as string,
    };
  }
  return entry;
}

function unsupported(action: string): never {
  throw Object.assign(new Error(`OMP RPC does not support ${action}`), {
    code: "CAPABILITY_DISABLED",
  });
}

export class OmpRpcSession implements SessionRuntime {
  private client!: OmpRpcClient;
  private readonly extensionUi = new OmpExtensionUiBridge();
  private ompOptions: OmpSessionOptions = {};
  /** 探测到的真实 omp 版本；探测失败时为 null（展示回退 OMP_SDK_VERSION） */
  private ompVersion: string | null = null;

  private sessionId = "";
  private sessionFile: string | undefined;
  private cwd = "";
  private sessionName: string | null = null;
  private closed = false;
  private protocolErrorWindowStart = 0;
  private protocolErrorCount = 0;

  private readonly piEventListeners = new Set<
    (event: JsonObject, meta: PiEventMeta) => void
  >();
  private readonly headListeners = new Set<(head: SessionHead) => void>();
  private readonly activityListeners = new Set<
    (status: SessionActivityStatus | null) => void
  >();
  private readonly subagentListeners = new Set<(event: JsonObject) => void>();
  private readonly subagentEvents = new SubagentEventBuffer((event) => {
    const payload = isJsonObject(event.payload) ? event.payload : undefined;
    if (typeof payload?.runId === "string" && !payload.runId.startsWith(`${this.eventEpoch}:`)) return;
    if (typeof payload?.id === "string" && typeof payload.runId === "string" &&
      this.subagentRuns.get(payload.id)?.runId !== payload.runId) return;
    for (const listener of this.subagentListeners) listener(event);
  });
  private readonly messageStream = new MainMessageStream((event, live) =>
    this.publishPiEvent(event, live),
  );
  private readonly piEvents = new EventSnapshotBuffer<{
    event: JsonObject;
    live?: { id: string; revision: number };
    epoch: string;
    historyGeneration: number;
  }>((buffered) => {
    if (buffered.epoch === this.eventEpoch && buffered.historyGeneration === this.historyGeneration)
      this.messageStream.push(buffered.event, buffered.live);
  });
  private readonly crashListeners = new Set<(error: Error) => void>();
  private readonly closeListeners = new Set<() => void>();
  private outputPaused = false;

  // 历史条目（append 顺序）+ 活跃分支缓存
  private entries: EntryRecord[] = [];
  private readonly branchPages = new BranchPageReader<EntryRecord>();
  private leafId: string | null = null;
  private entriesSeeded = false;
  private syncInFlight: Promise<void> = Promise.resolve();
  private syncDirty = false;
  private historyGeneration = 0;
  private syncTimer: NodeJS.Timeout | undefined;

  private nativeRevision = 1;
  private nativeFingerprint = "";
  private eventEpoch = randomUUID();
  private eventSequence = 0;
  private liveMessage?: {
    value: LiveMessage;
    messageId: string | undefined;
    phase: "streaming" | "persisting";
  };

  private retryShadow: JsonObject = { phase: "idle" };
  private compactionShadow: JsonObject = {
    autoEnabled: true,
    operation: { type: "none" },
  };
  // Queue execution and editing are native operations, never later prompts.
  private nativeQueue: { steering: JsonObject[]; followUp: JsonObject[] } = { steering: [], followUp: [] };
  private queueGeneration = 0;
  /** Native async-work state; unknown until readback after an end event. */
  private pendingAsyncWork: boolean | undefined;
  private nativeSettled = true;
  private activityGeneration = 0;
  private readonly resourcesListeners = new Set<() => void>();
  private scopedModels: JsonValue[] = [];
  private scopedModelPatterns: string[] = [];
  private lastActivity = {
    streaming: false,
    retrying: false,
    compacting: false,
  };
  private abortIntentEpoch?: string;
  private toolInterruption?: JsonObject;
  private abortInFlight: Promise<JsonValue | undefined> | undefined;

  private modelsCache: JsonObject[] = [];
  private modelsGeneration = 0;
  private thinkingLevelsCache: string[] = [];
  private thinkingLevelsGeneration = 0;
  private availableCommandsCache: JsonValue = [];

  private constructor() {}

  static async open(
    cwd: string,
    sessionFile?: string,
    options: OmpSessionOptions = {},
  ): Promise<OmpRpcSession> {
    const session = new OmpRpcSession();
    session.cwd = normalizeCwd(cwd);
    session.ompOptions = options;
    if (sessionFile) {
      session.sessionFile = resolveUserPath(sessionFile);
      assertOmpSessionFile(session.sessionFile);
      backupOmpSession(session.sessionFile);
    }
    await session.start();
    return session;
  }

  private async start(): Promise<void> {
    // 会话 cwd 可能已被清理（如 OMP 的子代理探针临时目录）：快速失败，给出可读错误
    if (!existsSync(this.cwd)) {
      throw Object.assign(
        new Error(`Session workspace no longer exists: ${this.cwd}`),
        { code: "SESSION_CWD_GONE" },
      );
    }
    // 版本探测与 RPC 进程拉起并行，不增加启动延迟；探测通常已被 worker
    // 启动时的同步探测填充缓存，直接命中
    const versionProbe = detectOmpVersion(this.ompOptions.bin);
    this.client = new OmpRpcClient({
      cwd: this.cwd,
      bin: this.ompOptions.bin,
      // 指定原文件在启动阶段直接恢复，避免先自动恢复另一个会话再切换。
      args: this.sessionFile ? ["--resume", this.sessionFile] : [],
      applyRuntimePolicy: true,
      env: { PIUI_EMBEDDED: "1" },
    });
    this.client.on("frame", (frame) => this.handleFrame(frame));
    // Local RPC protocol failures (chunk reassembly, decode) are otherwise only
    // visible in the exit stderr tail; forward them as events while the process
    // is still alive (#367). Bounded so an error storm cannot flood the UI.
    this.client.on("protocolError", (message: unknown) => {
      if (this.closed) return;
      const text = typeof message === "string" ? message : String(message);
      const now = Date.now();
      if (now - this.protocolErrorWindowStart > 60_000) {
        this.protocolErrorWindowStart = now;
        this.protocolErrorCount = 0;
      }
      this.protocolErrorCount += 1;
      if (this.protocolErrorCount > 20) return;
      this.emitPiEvent({
        type: "rpc_frame_error",
        source: "OMP RPC",
        level: "error",
        text:
          this.protocolErrorCount === 20
            ? `${text} (further protocol errors suppressed for 60s)`
            : text,
      });
    });
    this.client.on("exit", () => {
      if (this.closed) return;
      const error =
        this.client.exitInfo.error ??
        new Error("omp RPC process exited unexpectedly");
      for (const listener of this.crashListeners) listener(error);
      for (const listener of this.closeListeners) listener();
    });

    try {
      // ready 帧由协议保证是第一个 stdout 帧；协商 v2 以支持 >1MiB 分帧
      await this.client.waitForReady(30_000);
      // 版本门禁：< 18.2.11 缺 get_entries 等命令且错误响应不带 id，只能烧
      // 超时（打开会话卡 ~150s）——立刻失败并提示升级（issue #5）
      const detected = await versionProbe;
      if (detected && !isOmpVersionSupported(detected)) {
        throw ompTooOldError(detected);
      }
      this.ompVersion = detected;
      unwrapResponse(await this.client.request({
        type: "negotiate_protocol", protocolVersion: 2,
      }));
      // 子代理帧：lifecycle + progress + 完整事件
      unwrapResponse(await this.client.request({
        type: "set_subagent_subscription", level: "events",
      }));
      await this.refreshIdentity();
      this.extensionUi.bind(this.sessionId, (response) =>
        this.client.writeExtensionUiResponse(response),
      );
      await Promise.all([
        this.refreshModels(),
        this.refreshThinkingLevels(),
        this.refreshAvailableCommands(),
      ]);
      await this.syncEntriesNow();
      await this.getState();
    } catch (error) {
      // 启动中途失败：杀掉子进程，避免留下孤儿 omp 进程
      this.client.kill("startup_failed");
      throw error;
    }
  }

  private async refreshIdentity(): Promise<void> {
    // Identity is the committed operation boundary. Projection read failures
    // must not hide a native switch that has already changed the writer's file.
    const identity = await this.client.requestRuntime("identity");
    if (!isJsonObject(identity) || typeof identity.sessionId !== "string" || typeof identity.cwd !== "string")
      throw new Error("Managed runtime returned an invalid session identity");
    if (identity.sessionId !== this.sessionId) this.sessionName = null;
    this.sessionId = identity.sessionId;
    this.sessionFile = typeof identity.sessionFile === "string" ? identity.sessionFile : undefined;
    this.cwd = identity.cwd;
  }

  private async fetchState(): Promise<JsonObject> {
    const response = await this.client.request({ type: "get_state" }, 30_000);
    const data = unwrapResponse<JsonObject>(response);
    return isJsonObject(data) ? data : {};
  }

  private async refreshModels(): Promise<void> {
    const generation = ++this.modelsGeneration;
    const epoch = this.eventEpoch;
    try {
      const response = await this.client.request(
        { type: "get_available_models" },
        60_000,
      );
      const data = unwrapResponse<JsonValue>(response);
      if (generation !== this.modelsGeneration || epoch !== this.eventEpoch) return;
      const list =
        isJsonObject(data) && Array.isArray(data.models)
          ? data.models
          : Array.isArray(data)
            ? data
            : [];
      this.modelsCache = list.filter(isJsonObject);
    } catch {
      if (generation !== this.modelsGeneration || epoch !== this.eventEpoch) return;
      this.modelsCache = [];
    }
  }

  private async refreshThinkingLevels(): Promise<void> {
    const generation = ++this.thinkingLevelsGeneration;
    const epoch = this.eventEpoch;
    const response = await this.client.request(
      { type: "get_available_thinking_levels" },
      30_000,
    );
    const data = unwrapResponse<JsonValue>(response);
    if (generation !== this.thinkingLevelsGeneration || epoch !== this.eventEpoch) return;
    this.thinkingLevelsCache = isJsonObject(data) && Array.isArray(data.levels)
      ? data.levels.filter((level): level is string => typeof level === "string")
      : [];
  }

  private async refreshAvailableCommands(): Promise<void> {
    const epoch = this.eventEpoch;
    const response = await this.client.request({ type: "get_available_commands" }, 30_000);
    const data = unwrapResponse<JsonValue>(response);
    this.assertEventEpoch(epoch);
    if (!isJsonObject(data) || !Array.isArray(data.commands)) {
      throw new OmpRpcError("Native command catalog is unavailable", "RESOURCE_UNAVAILABLE");
    }
    this.availableCommandsCache = data.commands.filter((command) => !isJsonObject(command) || command.name !== "ompiui-runtime");
  }

  // ------------------------------------------------------------------ events

  private handleFrame(frame: OmpRpcFrame): void {
    const type = frame.type;
    switch (type) {
      case "ready":
        return;
      case "message_start":
      case "message_update":
      case "message_end": {
        this.trackLiveMessage(frame);
        this.emitPiEvent(frame);
        if (type === "message_end") this.scheduleEntrySync();
        this.emitActivityIfChanged();
        return;
      }
      case "turn_start":
      case "turn_end":
      case "tool_execution_start":
      case "tool_execution_update":
      case "tool_execution_end":
      case "agent_start":
      case "agent_end":
      case "auto_retry_start":
      case "auto_retry_end":
      case "retry_fallback_applied":
      case "retry_fallback_succeeded":
      case "model_changed":
      case "thinking_level_changed":
      case "todo_reminder":
      case "todo_auto_clear":
      case "ttsr_triggered":
      case "irc_message":
      case "notice":
      case "goal_updated":
      case "bash_execution_update":
      case "session_info_changed":
      case "queue_update": {
        if (type === "agent_start") {
          this.activityGeneration += 1;
          this.currentStreaming = true;
          this.nativeSettled = false;
          this.pendingAsyncWork = undefined;
          this.abortIntentEpoch = undefined;
          this.toolInterruption = undefined;
        }
        if (type === "agent_end" && (frame.isTerminal !== false || frame.awaitingAsyncWork === true)) {
          this.activityGeneration += 1;
          this.currentStreaming = false;
          if (frame.awaitingAsyncWork === true) {
            this.nativeSettled = false;
            this.pendingAsyncWork = true;
          }
        }
        this.trackShadowState(frame);
        if (type === "queue_update") this.trackNativeQueue(frame);
        this.emitPiEvent(type === "queue_update"
          ? { ...frame, ...this.getNativeQueueSnapshot() }
          : frame);
        if (
          type === "agent_end" ||
          type === "turn_end" ||
          type === "irc_message"
        )
          this.scheduleEntrySync();
        this.emitActivityIfChanged();
        if (type === "model_changed") {
          void Promise.all([this.refreshModels(), this.refreshThinkingLevels()])
            .catch((error) => this.reportEntrySyncError(error));
        }
        if (type === "agent_end" && (frame.isTerminal !== false || frame.awaitingAsyncWork === true)) {
          void this.getState().catch((error) => this.reportEntrySyncError(error));
        }
        return;
      }
      // OMP 用 auto_compaction_*，Pi 前端监听 compaction_start/end —— 改名转发
      case "auto_compaction_start":
      case "auto_compaction_end": {
        this.trackShadowState({
          ...frame,
          type:
            type === "auto_compaction_start"
              ? "compaction_start"
              : "compaction_end",
        });
        this.emitPiEvent({
          ...frame,
          type:
            type === "auto_compaction_start"
              ? "compaction_start"
              : "compaction_end",
        });
        if (type === "auto_compaction_end") this.scheduleEntrySync();
        this.emitActivityIfChanged();
        return;
      }
      // OMP 的终态信号 → Pi 的 agent_settled（前端 idle/刷新依赖）
      case "session_settled": {
        this.activityGeneration += 1;
        // 终态时 omp 不再单独发 isStreaming=false 的状态帧：必须在事件侧复位，
        // 否则 activity 一直 busy，前端停止按钮要等下一次 state.get 轮询才解除
        this.currentStreaming = false;
        this.nativeSettled = true;
        this.pendingAsyncWork = false;
        this.scheduleEntrySync();
        if (isJsonObject(frame.toolInterruption)) this.toolInterruption = frame.toolInterruption;
        else if (this.abortIntentEpoch === this.eventEpoch) this.toolInterruption = { kind: 'cancelled', error: 'Stopped by the user before this tool returned a result' };
        this.emitPiEvent({ type: "agent_settled", ...(this.toolInterruption ? { toolInterruption: this.toolInterruption } : {}) });
        this.emitActivityIfChanged();
        return;
      }
      case "prompt_result": {
        if (frame.sessionSettled === true) this.activityGeneration += 1;
        if (frame.sessionSettled === true) {
          this.currentStreaming = false;
          this.nativeSettled = true;
          this.pendingAsyncWork = false;
        }
        this.emitPiEvent(frame);
        this.scheduleEntrySync();
        this.emitActivityIfChanged();
        return;
      }
      case "subagent_lifecycle":
      case "subagent_progress":
      case "subagent_event": {
        const kind =
          type === "subagent_lifecycle"
            ? "lifecycle"
            : type === "subagent_progress"
              ? "progress"
              : "event";
        // RPC 帧已是 JSON；不要对每个 token 再完整序列化一次累计消息。
        const raw = projectSubagentPayload(
          kind,
          isJsonObject(frame.payload) ? frame.payload : {},
        );
        const progress = isJsonObject(raw.progress) ? raw.progress : undefined;
        const payload =
          typeof raw.id !== "string" && typeof progress?.id === "string"
            ? { ...raw, id: progress.id }
            : raw;
        const tracked = this.trackSubagentFrame(kind, {
          ...payload,
          ...(isJsonObject(frame.payload) && frame.payload.parentToolCallId !== undefined
            ? { parentToolCallId: frame.payload.parentToolCallId } : {}),
          ...(isJsonObject(frame.payload) && frame.payload.runId !== undefined
            ? { runId: frame.payload.runId } : {}),
        });
        if (tracked) this.subagentEvents.push(kind, tracked);
        return;
      }
      case "extension_ui_request": {
        this.extensionUi.handleOmpRequest(frame);
        return;
      }
      case "extension_error":
      case "available_commands_update":
      case "command_output":
      case "session_info_update":
      case "config_update":
      case "advisor_cost_changed":
      case "host_tool_call":
      case "host_tool_cancel":
      case "host_uri_request":
      case "host_uri_cancel":
      default: {
        // 未识别/宿主侧帧：统一透传（前端 switch 未命中即忽略）
        if (type === "available_commands_update") {
          this.availableCommandsCache = Array.isArray(frame.commands)
            ? frame.commands.filter((command) => !isJsonObject(command) || command.name !== "ompiui-runtime")
            : [];
          this.nativeFingerprint = ""; // 触发 head 刷新
        }
        this.emitPiEvent(type === "available_commands_update"
          ? { ...frame, commands: this.availableCommandsCache } : frame);
        return;
      }
    }
  }

  private emitPiEvent(event: JsonObject): void {
    const update =
      event.type === "message_update"
        ? "message"
        : event.type === "tool_execution_update"
          ? `tool:${String(event.toolCallId ?? "")}`
          : undefined;
    this.piEvents.push(this.sessionId, update, {
      event: projectToolUpdate(event),
      epoch: this.eventEpoch,
      historyGeneration: this.historyGeneration,
      live: this.liveMessage
        ? {
            id: this.liveMessage.value.id,
            revision: this.liveMessage.value.revision,
          }
        : undefined,
    });
  }

  private publishPiEvent(
    event: JsonObject,
    live?: { id: string; revision: number },
  ): void {
    const meta: PiEventMeta = {
      epoch: this.eventEpoch,
      sequence: ++this.eventSequence,
      liveMessage:
        live ??
        (this.liveMessage
          ? {
              id: this.liveMessage.value.id,
              revision: this.liveMessage.value.revision,
            }
          : undefined),
    };
    for (const listener of this.piEventListeners) listener(event, meta);
    this.emitHeadIfChanged();
  }

  private trackLiveMessage(frame: OmpRpcFrame): void {
    const nativeMessage = isJsonObject(frame.message)
      ? frame.message
      : undefined;
    const role = nativeMessage?.role;
    if (role !== "user" && role !== "assistant" && role !== "toolResult")
      return;
    const messageId =
      typeof frame.messageId === "string" ? frame.messageId : undefined;
    const isStart = frame.type === "message_start";
    const current = this.liveMessage;
    // 同一条消息（messageId 稳定）沿用 checkpoint，前端流式行不跳 key
    const reused =
      current &&
      !isStart &&
      isJsonObject(current.value.message) &&
      current.value.message.role === role &&
      (!messageId || !current.messageId || current.messageId === messageId);
    this.liveMessage = {
      value: {
        id: reused ? current.value.id : (messageId ?? randomUUID()),
        revision: reused ? current.value.revision + 1 : 1,
        phase: frame.type === "message_end" ? "persisting" : "streaming",
        message: nativeMessage ?? null,
        complete: true,
      },
      messageId,
      phase: frame.type === "message_end" ? "persisting" : "streaming",
    };
    if (frame.type === "message_end") {
      const pending = this.liveMessage;
      const generation = this.historyGeneration;
      // 持久化交接：在 microtask 中刷新 branch，完成后再清除 live 行。
      queueMicrotask(() => {
        if (this.closed || generation !== this.historyGeneration) return;
        void this.syncEntriesNow()
          .then(() => {
            if (generation === this.historyGeneration && this.liveMessage === pending)
              this.liveMessage = undefined;
            this.emitHeadIfChanged();
          })
          .catch((error) => this.reportEntrySyncError(error));
      });
    }
    void isStart;
  }

  private trackShadowState(frame: OmpRpcFrame): void {
    switch (frame.type) {
      case "compaction_start": {
        this.compactionShadow = {
          autoEnabled: this.compactionShadow.autoEnabled,
          operation: {
            type: "compaction",
            phase: "running",
            reason: toJson(frame.reason) ?? null,
          },
          lastAborted: null,
          lastError: null,
          lastNotice: null,
        };
        break;
      }
      case "compaction_end": {
        this.compactionShadow = {
          ...this.compactionShadow,
          operation: { type: "none" },
          lastResult:
            toJson(frame.result) ?? this.compactionShadow.lastResult ?? null,
          lastAborted: Boolean(frame.aborted),
          lastError: toJson(frame.errorMessage) ?? null,
        };
        break;
      }
      case "auto_retry_start": {
        const delayMs = Number(frame.delayMs) || 0;
        this.retryShadow = {
          phase: "waiting",
          autoEnabled: true,
          attempt: Number(frame.attempt) || 1,
          maxAttempts: Number(frame.maxAttempts) || 0,
          delayMs,
          nextAttemptAt: new Date(Date.now() + delayMs).toISOString(),
          errorMessage: toJson(frame.errorMessage) ?? null,
        };
        break;
      }
      case "agent_start": {
        if (this.retryShadow.phase === "waiting") {
          this.retryShadow = { ...this.retryShadow, phase: "running" };
        } else if (this.retryShadow.phase === "finished") {
          this.retryShadow = { phase: "idle" };
        }
        break;
      }
      case "auto_retry_end": {
        this.retryShadow = {
          phase: "finished",
          success: Boolean(frame.success),
          attempt: Number(frame.attempt) || 0,
          finalError: toJson(frame.finalError) ?? null,
        };
        break;
      }

      default:
        break;
    }
  }

  private getNativeQueueSnapshot() {
    return {
      steering: this.nativeQueue.steering.map((entry) => String(entry.text ?? "")),
      followUp: this.nativeQueue.followUp.map((entry) => String(entry.text ?? "")),
      steeringEntries: this.nativeQueue.steering.map((entry) => structuredClone(entry)),
      followUpEntries: this.nativeQueue.followUp.map((entry) => structuredClone(entry)),
      editable: true,
    };
  }

  private trackNativeQueue(frame: JsonObject): void {
    this.queueGeneration += 1;
    for (const kind of ["steering", "followUp"] as const) {
      const entries = frame[`${kind}Entries`];
      const values = Array.isArray(entries) ? entries : frame[kind];
      if (Array.isArray(values)) {
        this.nativeQueue[kind] = values.map((item) => typeof item === "string"
          ? { text: item }
          : isJsonObject(item) ? projectStateImages(item) : undefined).filter(isJsonObject);
      }
    }
  }

  private async refreshQueue(publish = true): Promise<void> {
    const epoch = this.eventEpoch;
    const generation = ++this.queueGeneration;
    const value = await this.client.requestRuntime("queue");
    if (epoch !== this.eventEpoch || generation !== this.queueGeneration) return;
    if (isJsonObject(value)) {
      this.trackNativeQueue(value);
      if (Array.isArray(value.scopedModels)) this.scopedModels = value.scopedModels;
      if (Array.isArray(value.scopedModelPatterns)) this.scopedModelPatterns = value.scopedModelPatterns.filter((pattern): pattern is string => typeof pattern === "string");
    }
    if (publish) this.emitPiEvent({ type: "queue_update", ...this.getNativeQueueSnapshot() });
  }

  private emitActivityIfChanged(): void {
    // Native isSettled also includes retained queues. Keep activity conservative
    // until readback, then show busy only for actual foreground or async work.
    let status: SessionActivityStatus | null = null;
    if (
      this.retryShadow.phase === "waiting" ||
      this.retryShadow.phase === "running"
    ) {
      const nextAtIso =
        typeof this.retryShadow.nextAttemptAt === "string"
          ? this.retryShadow.nextAttemptAt
          : undefined;
      const nextAt = nextAtIso ? Date.parse(nextAtIso) : 0;
      status = {
        type: "retry",
        attempt:
          typeof this.retryShadow.attempt === "number"
            ? this.retryShadow.attempt
            : 1,
        message:
          typeof this.retryShadow.errorMessage === "string"
            ? this.retryShadow.errorMessage
            : "",
        next: Number.isFinite(nextAt) ? nextAt : 0,
      };
    } else if (this.currentStreaming || (this.pendingAsyncWork ?? !this.nativeSettled)) {
      status = { type: "busy" };
    } else if (
      isJsonObject(this.compactionShadow.operation) &&
      this.compactionShadow.operation.type === "compaction"
    ) {
      status = { type: "compacting" };
    }
    const next = {
      streaming: status?.type === "busy",
      retrying: status?.type === "retry",
      compacting: status?.type === "compacting",
    };
    if (
      next.streaming === this.lastActivity.streaming &&
      next.retrying === this.lastActivity.retrying &&
      next.compacting === this.lastActivity.compacting
    ) {
      return;
    }
    this.lastActivity = next;
    for (const listener of this.activityListeners) listener(status);
  }

  private currentStreaming = false;

  // ---------------------------------------------------------------- entries

  private scheduleEntrySync(): void {
    this.syncDirty = true;
    if (this.syncTimer) return;
    this.syncTimer = setTimeout(() => {
      this.syncTimer = undefined;
      void this.syncEntriesNow().catch((error) =>
        this.reportEntrySyncError(error),
      );
    }, 150);
    this.syncTimer.unref?.();
  }

  private reportEntrySyncError(error: unknown): void {
    if (this.closed) return;
    if (error instanceof Error && "code" in error && error.code === "SESSION_REPLACED") return;
    console.error("Failed to synchronize OMP session history:", error);
    this.syncDirty = true;
  }

  private async syncEntriesNow(): Promise<void> {
    if (this.closed) return;
    this.syncDirty = false;
    this.syncInFlight = this.syncInFlight
      .catch(() => undefined)
      .then(() => this.doSyncEntries());
    await this.syncInFlight;
  }

  private async doSyncEntries(): Promise<void> {
    if (this.closed) return;
    const generation = this.historyGeneration;
    try {
      const command: JsonObject =
        this.entriesSeeded && this.entries.length > 0
          ? {
              type: "get_entries",
              since: this.entries[this.entries.length - 1]!.id,
            }
          : { type: "get_entries" };
      const response = await this.client.request(command, 120_000);
      const data = unwrapResponse<JsonObject>(response);
      if (generation !== this.historyGeneration) return;
      if (!isJsonObject(data) || !Array.isArray(data.entries)) return;
      const rawEntries = data.entries.filter(isJsonObject);
      if (!this.entriesSeeded) {
        this.entries = rawEntries.map((entry) => this.recordEntry(entry));
        this.entriesSeeded = true;
      } else if (rawEntries.length > 0) {
        const known = new Set(this.entries.map((entry) => entry.id));
        for (const raw of rawEntries) {
          const record = this.recordEntry(raw);
          if (!known.has(record.id)) {
            this.entries.push(record);
            known.add(record.id);
          }
        }
      }
      if (typeof data.leafId === "string" || data.leafId === null) {
        this.leafId = data.leafId as string | null;
      }
      this.emitHeadIfChanged();
    } catch (error) {
      if (generation !== this.historyGeneration) return;
      if (error instanceof OmpRpcError && error.code === "unknown_since") {
        // 历史被改写（压缩/切换）：全量重播种
        this.entriesSeeded = false;
        this.entries = [];
        this.branchPages.clear();
        await this.doSyncEntries();
        return;
      }
      throw error;
    }
  }

  private recordEntry(entry: JsonObject): EntryRecord {
    const adapted = adaptEntry(entry);
    return {
      id: String(adapted.id ?? ""),
      parentId: typeof adapted.parentId === "string" ? adapted.parentId : null,
      timestamp: typeof adapted.timestamp === "string" ? adapted.timestamp : "",
      ...adapted,
    } as EntryRecord;
  }

  private branchEntries(): EntryRecord[] {
    if (!this.leafId) return [];
    const byId = new Map(this.entries.map((entry) => [entry.id, entry]));
    const path: EntryRecord[] = [];
    let cursor: string | null = this.leafId;
    const seen = new Set<string>();
    while (cursor && !seen.has(cursor)) {
      seen.add(cursor);
      const entry = byId.get(cursor);
      if (!entry) break;
      path.push(entry);
      cursor = entry.parentId;
    }
    path.reverse();
    // append 顺序对齐（叶子链可能与 append 顺序不同，按 entries 里的位置排序）
    const position = new Map(
      this.entries.map((entry, index) => [entry.id, index]),
    );
    path.sort((a, b) => (position.get(a.id) ?? 0) - (position.get(b.id) ?? 0));
    return path;
  }

  private getNativeFingerprint(): string {
    const last = this.entries.at(-1);
    return `${this.entries.length}:${this.leafId ?? ""}:${last?.id ?? ""}:${last?.timestamp ?? ""}`;
  }

  private emitHeadIfChanged(): void {
    const fingerprint = this.getNativeFingerprint();
    if (fingerprint === this.nativeFingerprint) return;
    this.nativeFingerprint = fingerprint;
    this.nativeRevision += 1;
    const head = this.getHead();
    for (const listener of this.headListeners) listener(head);
  }

  getHead(): SessionHead {
    const header: JsonObject = {
      version: 3,
      id: this.sessionId,
      cwd: utf8Prefix(this.cwd, 4096),
      name: utf8Prefix(this.sessionName ?? "", 1024),
    };
    return sessionHeadFromParts(
      {
        sdkVersion: this.ompVersion ?? OMP_SDK_VERSION,
        revision: this.nativeRevision,
        sessionFormatVersion: 3,
        header,
        leafId: this.leafId,
        entryCount: this.entries.length,
      },
      [this.sessionId, header, this.entries.length],
    );
  }

  async ensureSynced(): Promise<void> {
    if (this.syncDirty || !this.entriesSeeded) await this.syncEntriesNow();
    await this.syncInFlight;
  }

  async getEntriesPage(
    cursor: string | undefined,
    limit: number,
    maxBytes: number,
  ): Promise<EntriesPage> {
    await this.ensureSynced();
    return entriesPageFromEntries(
      this.getHead(),
      this.entries,
      { cursor, limit, maxBytes },
      (entry) => entry as unknown as JsonObject,
    );
  }

  async getBranchPage(
    cursor: string | undefined,
    limit: number,
    maxBytes: number,
    sync?: BranchSyncRequest,
  ): Promise<EntriesPage> {
    await this.ensureSynced();
    const checkpoint: BranchCheckpoint | undefined =
      cursor || (sync?.beforeId && !sync.syncCursor)
        ? undefined
        : {
            position: { epoch: this.eventEpoch, sequence: this.eventSequence },
            liveMessage: this.liveMessage?.value,
          };
    if (
      checkpoint?.liveMessage &&
      ((sync?.syncCursor && !sync.includeLiveMessage) ||
        Buffer.byteLength(JSON.stringify(checkpoint.liveMessage)) >
          maxBytes - 4096)
    ) {
      checkpoint.liveMessage = undefined;
      checkpoint.liveMessageOmitted = true;
    }
    return this.branchPages.read(
      this.getHead(),
      this.branchEntries(),
      { cursor, limit, maxBytes, checkpoint, ...sync },
      (entry) => entry as unknown as JsonObject,
    );
  }

  async getTree(params?: { cursor?: string; limit?: number; maxBytes?: number }): Promise<JsonValue> {
    await this.ensureSynced();
    if (params) return sessionTreePage(this.entries as unknown as JsonObject[], this.getHead(), params);
    // SDK getTree() 语义：整棵树（含所有分支）的嵌套 { entry, children }，
    // 前端 sessionTreeGraph 按该形状消费（issue #10）
    return buildSessionTreeFromEntries(
      this.entries as unknown as JsonObject[],
      true,
    );
  }

  async getAttachment(
    entryId: string,
    blockIndex: number,
    offset = 0,
    source: "content" | "details" = "content",
  ): Promise<JsonObject> {
    await this.ensureSynced();
    const entry = this.entries.find((item) => item.id === entryId);
    if (!entry)
      throw Object.assign(new Error("entry not found"), { code: "NOT_FOUND" });
    const serialized = entry as unknown as JsonObject;
    return imageAttachmentFromEntry(serialized, blockIndex, offset, source);
  }

  private stateFlight: Promise<JsonObject> | undefined;

  async getState(): Promise<JsonObject> {
    if (this.stateFlight) return this.stateFlight;
    const flight = this.buildState().finally(() => {
      if (this.stateFlight === flight) this.stateFlight = undefined;
    });
    this.stateFlight = flight;
    return flight;
  }

  private async buildState(): Promise<JsonObject> {
    // A read opened by the source must never return target state to its caller.
    // Same-identity history/activity changes may retry; replacement must expire.
    const epoch = this.eventEpoch;
    const historyGeneration = this.historyGeneration;
    const modelsGeneration = this.modelsGeneration;
    const activityGeneration = this.activityGeneration;
    const [native] = await Promise.all([
      this.fetchState(),
      this.ensureSynced(),
      this.listSubagents(),
    ]);
    this.assertEventEpoch(epoch);
    if (epoch !== this.eventEpoch || historyGeneration !== this.historyGeneration || modelsGeneration !== this.modelsGeneration || activityGeneration !== this.activityGeneration) return this.buildState();
    this.sessionName = typeof native.sessionName === "string" ? native.sessionName : null;
    this.currentStreaming = Boolean(native.isStreaming);
    this.nativeSettled = native.isSettled === true ||
      (native.isSettled === undefined && native.isStreaming === false &&
        !native.hasPendingAsyncWork && !native.queuedMessageCount);
    this.trackNativeQueue(native);
    await Promise.all([this.refreshQueue(false), this.refreshThinkingLevels()]);
    this.assertEventEpoch(epoch);
    if (epoch !== this.eventEpoch || historyGeneration !== this.historyGeneration || modelsGeneration !== this.modelsGeneration || activityGeneration !== this.activityGeneration) return this.buildState();
    const model = this.resolveModelDescriptor(native.model);
    const contextUsage = isJsonObject(native.contextUsage)
      ? native.contextUsage
      : null;
    let sessionStats: JsonValue = null;
    const statsEpoch = this.eventEpoch;
    try {
      const statsResponse = await this.client.request(
        { type: "get_session_stats" },
        15_000,
      );
      sessionStats =
        toJson(unwrapResponse<JsonValue>(statsResponse) ?? null) ?? null;
    } catch {
      /* stats 是增强信息 */
    }
    const head = this.getHead();
    this.assertEventEpoch(epoch);
    if (statsEpoch !== this.eventEpoch || historyGeneration !== this.historyGeneration || modelsGeneration !== this.modelsGeneration || activityGeneration !== this.activityGeneration) return this.buildState();
    this.pendingAsyncWork = Boolean(native.hasPendingAsyncWork);
    this.emitActivityIfChanged();
    return {
      sessionId: this.sessionId,
      sessionFile: this.sessionFile ?? null,
      sessionName: this.sessionName,
      cwd: this.cwd,
      model: toJson(model) ?? null,
      thinkingLevel:
        typeof native.thinkingLevel === "string" ? native.thinkingLevel : "off",
      isStreaming: Boolean(native.isStreaming),
      isCompacting:
        Boolean(native.isCompacting) ||
        (isJsonObject(this.compactionShadow.operation) &&
          this.compactionShadow.operation.type === "compaction"),
      steeringMode:
        native.steeringMode === "all" || native.steeringMode === "one-at-a-time"
          ? native.steeringMode
          : null,
      followUpMode:
        native.followUpMode === "all" || native.followUpMode === "one-at-a-time"
          ? native.followUpMode
          : null,
      interruptMode: native.interruptMode === "immediate" || native.interruptMode === "wait" ? native.interruptMode : null,
      autoCompactionEnabled: Boolean(native.autoCompactionEnabled),
      autoRetryEnabled: true,
      messageCount:
        typeof native.messageCount === "number"
          ? native.messageCount
          : this.entries.length,
      pendingMessageCount:
        typeof native.queuedMessageCount === "number"
          ? native.queuedMessageCount
          : 0,
      availableThinkingLevels: [...this.thinkingLevelsCache],
      supportedThinkingLevels: [...this.thinkingLevelsCache],
      isSettled: this.nativeSettled,
      isIdle: this.nativeSettled,
      ...(this.toolInterruption ? { toolInterruption: this.toolInterruption } : {}),
      // 上游 get_state 的两个「还会被唤醒」信号，宿主回收空闲 runtime 时依赖：
      // hasPendingAsyncWork 覆盖后台 bash / async task / eval 尚未回灌的长尾，
      // isSettled 是 session_settled 的同一谓词。isBashRunning 在 OMP RPC 下
      // 恒为 false；后台作业通过 hasPendingAsyncWork 透出。
      hasPendingAsyncWork: Boolean(native.hasPendingAsyncWork),
      isBashRunning: false,
      hasPendingBashMessages: false,
      isRetrying:
        this.retryShadow.phase === "waiting" ||
        this.retryShadow.phase === "running",
      retryAttempt:
        typeof this.retryShadow.attempt === "number"
          ? this.retryShadow.attempt
          : 0,
      queue: {
        ...this.getNativeQueueSnapshot(),
        steeringMode:
          native.steeringMode === "all" || native.steeringMode === "one-at-a-time"
            ? native.steeringMode
            : null,
        followUpMode:
          native.followUpMode === "all" || native.followUpMode === "one-at-a-time"
            ? native.followUpMode
            : null,
      },
      submittedMessages: [],
      pendingExtensionUiRequests: this.extensionUi.listPending(),
      extensionUiState: this.extensionUi.getStateMirror(),
      extensionTuiPanels: [],
      supportsThinking: this.resolveSupportsThinking(native.model),
      activeTools: Array.isArray(native.dumpTools)
        ? native.dumpTools
            .filter(isJsonObject)
            .map((tool) => String(tool.name ?? ""))
            .filter(Boolean)
        : [],
      scopedModels: this.scopedModels,
      scopedModelPatterns: this.scopedModelPatterns,
      contextUsage,
      sessionStats,
      retry: this.retryShadow,
      compaction: this.compactionShadow,
      head,
      // OMP 扩展：子代理注册表快照 + todo 阶段（前端子代理面板重连恢复用）
      subagents: this.getSubagentsSnapshot(),
      todoPhases: Array.isArray(native.todoPhases) ? native.todoPhases : [],
      goal: isJsonObject(native.goal) && isJsonObject(native.goal.goal) ? native.goal.goal : null,
      goalState: native.goal ?? null,
    };
  }

  private getSubagentsSnapshot(): JsonValue {
    // 同步快照：从 lifecycle/progress 帧累计的注册表（前端重连恢复用）。
    // 终态条目也保留一段时间供 HUD 恢复，但总量有界，避免 state.get 随会话寿命增长。
    return [...this.subagentRuns.values()];
  }

  private readonly subagentRuns = new Map<string, JsonObject>();
  private readonly supersededSubagentParents = new Map<string, Set<string>>();
  private subagentRunSequence = 0;
  private readonly MAX_SUBAGENT_RUNS = 200;

  private rememberSubagent(id: string, value: JsonObject): void {
    this.subagentRuns.set(id, value);
    while (this.subagentRuns.size > this.MAX_SUBAGENT_RUNS) {
      const removable = [...this.subagentRuns.entries()].find(([, item]) =>
        item.status === "completed" || item.status === "failed" || item.status === "aborted",
      );
      const id = removable?.[0] ?? this.subagentRuns.keys().next().value!;
      this.subagentRuns.delete(id);
      this.supersededSubagentParents.delete(id);
    }
  }

  private trackSubagentFrame(kind: string, payload: JsonObject): JsonObject | undefined {
    const id = typeof payload.id === "string" ? payload.id : undefined;
    if (!id) return payload;
    const existing = this.subagentRuns.get(id);
    const parent = typeof payload.parentToolCallId === "string" ? payload.parentToolCallId : undefined;
    if (parent && this.supersededSubagentParents.get(id)?.has(parent) &&
      !(kind === "lifecycle" && payload.status === "started")) return;
    const parentChanged = typeof payload.parentToolCallId === "string" &&
      typeof existing?.parentToolCallId === "string" &&
      payload.parentToolCallId !== existing.parentToolCallId;
    if (parentChanged && !(kind === "lifecycle" && payload.status === "started")) return;
    const terminal = existing?.status === "completed" || existing?.status === "failed" || existing?.status === "aborted";
    if (typeof payload.runId === "string" && existing && payload.runId !== existing.runId) return;
    const restart = kind === "lifecycle" && payload.status === "started" && (parentChanged || terminal);
    if (restart && parent) this.supersededSubagentParents.get(id)?.delete(parent);
    if (parentChanged && typeof existing?.parentToolCallId === "string") {
      const superseded = this.supersededSubagentParents.get(id) ?? new Set<string>();
      superseded.add(existing.parentToolCallId);
      if (superseded.size > this.MAX_SUBAGENT_RUNS) superseded.delete(superseded.values().next().value!);
      this.supersededSubagentParents.set(id, superseded);
    }
    const runId = !existing || restart
      ? `${this.eventEpoch}:${id}:${++this.subagentRunSequence}`
      : String(existing.runId);
    const tracked: JsonObject = { ...payload, runId };
    if (kind === "event") {
      if (!existing) this.rememberSubagent(id, { id, runId });
      return tracked;
    }
    const merged: JsonObject = restart || !existing ? { id, runId } : { ...existing, runId };
    if (restart) merged.isFollowUp = typeof parent === "string" && parent === existing?.parentToolCallId &&
      typeof payload.sessionFile === "string" && payload.sessionFile === existing?.sessionFile;
    tracked.isFollowUp = merged.isFollowUp;
    for (const key of ["agent", "agentSource", "description", "task", "assignment",
      "sessionFile", "parentToolCallId", "index", "detached"]) {
      if (payload[key] !== undefined) merged[key] = payload[key];
    }
    if (kind === "lifecycle" && typeof payload.status === "string") {
      const status = payload.status === "started" ? "running" : payload.status;
      if (!(terminal && !restart && (status === "running" || status === "pending"))) merged.status = status;
    } else if (kind === "progress" && isJsonObject(payload.progress)) {
      merged.progress = payload.progress;
      const status = payload.progress.status;
      if (typeof status === "string" && !(terminal && !restart && (status === "running" || status === "pending"))) {
        merged.status = status;
      }
    }
    this.rememberSubagent(id, merged);
    return tracked;
  }

  private resolveModelDescriptor(
    model: JsonValue | undefined,
  ): JsonValue | undefined {
    if (!isJsonObject(model)) return undefined;
    const provider = typeof model.provider === "string" ? model.provider : "";
    const id = typeof model.id === "string" ? model.id : "";
    const found = this.modelsCache.find(
      (item) =>
        (item.provider === provider || item.provider === undefined) &&
        item.id === id,
    );
    if (found) return { ...found, ...model, provider: model.provider ?? found.provider };
    // get_state 的 model 没有完整描述符时，用缓存的最小形状补齐
    if (provider || id)
      return {
        ...model,
        provider,
        id,
        name: model.name ?? id,
        reasoning: model.reasoning ?? false,
        input: model.input ?? ["text"],
      };
    return undefined;
  }

  private resolveSupportsThinking(model: JsonValue | undefined): boolean {
    if (!isJsonObject(model)) return false;
    const provider = typeof model.provider === "string" ? model.provider : "";
    const id = typeof model.id === "string" ? model.id : "";
    const found = this.modelsCache.find(
      (item) =>
        (item.provider === provider || item.provider === undefined) &&
        item.id === id,
    );
    return Boolean(model.reasoning ?? found?.reasoning ?? false);
  }

  private async discoverResources(): Promise<JsonObject> {
    const value = await this.client.requestRuntime("resources", {}, 60_000);
    if (!isJsonObject(value)) throw Object.assign(new Error('Runtime resources are unavailable'), { code: 'RESOURCE_UNAVAILABLE' });
    return value;
  }

  async listSkills(): Promise<JsonValue> {
    const resources = await this.discoverResources();
    return requireResourceList(resources, 'skills');
  }

  async listPrompts(): Promise<JsonValue> {
    const resources = await this.discoverResources();
    return requireResourceList(resources, 'prompts');
  }

  async listAgentsFiles(): Promise<JsonValue> {
    const resources = await this.discoverResources();
    return requireResourceList(resources, 'contextFiles');
  }

  async getRegistry(): Promise<RegistrySnapshot> {
    const resources = await this.discoverResources();
    // ExtensionAPI.getCommands excludes builtins and file commands. The RPC
    // catalog is the authoritative set dispatched by this running mode.
    return registryFromResources({ ...resources, commands: this.availableCommandsCache }, this.ompVersion ?? OMP_SDK_VERSION);
  }

  // ---------------------------------------------------------------- prompting

  async prompt(
    text: string,
    images?: ImageInput[],
    options: {
      expandPromptTemplates?: boolean;
      streamingBehavior?: "steer" | "followUp";
    } = {},
  ): Promise<void> {
    await this.submitPrompt(text, images, options);
  }

  private async submitPrompt(
    text: string,
    images?: ImageInput[],
    options: { streamingBehavior?: "steer" | "followUp" } = {},
    shouldSubmit?: () => boolean,
  ): Promise<void> {
    const epoch = this.eventEpoch;
    await this.abortInFlight;
    // 自动投递在等待期间可能已被暂停或清队列，写入 RPC 前重新确认。
    if (shouldSubmit && !shouldSubmit()) return;
    if (epoch !== this.eventEpoch) {
      if (shouldSubmit) return;
      throw Object.assign(new Error("Session replaced before prompt submission"), { code: "SESSION_REPLACED" });
    }
    const command: JsonObject = { type: "prompt", message: text };
    // Let the native session decide at dispatch time whether this starts a turn
    // or joins its queue; event-side streaming state can lag admitted prompts.
    if (options.streamingBehavior) command.streamingBehavior = options.streamingBehavior;
    if (images?.length)
      command.images = images.map((image) => ({
        type: "image",
        data: image.data,
        mimeType: image.mimeType,
      }));
    try {
      unwrapResponse(await (text.startsWith('/') ? requestNativePromptAcceptance(this.client, command, 300_000) : this.client.request(command, 30_000)));
      void this.refreshQueue().catch((error) => this.reportEntrySyncError(error));
    } finally {
      this.scheduleEntrySync();
    }
  }

  private async submitQueuedMessage(type: "steer" | "follow_up", text: string, images?: ImageInput[]): Promise<void> {
    const epoch = this.eventEpoch;
    await this.abortInFlight;
    if (epoch !== this.eventEpoch)
      throw Object.assign(new Error("Session replaced before queue submission"), { code: "SESSION_REPLACED" });
    const command: JsonObject = { type, message: text };
    if (images?.length) command.images = images.map((image) => ({ ...image }));
    unwrapResponse(await this.client.request(command, 60_000));
    await this.refreshQueue().catch(error => this.reportEntrySyncError(error));
    this.scheduleEntrySync();
  }

  async steer(text: string, images?: ImageInput[]): Promise<void> {
    await this.submitQueuedMessage("steer", text, images);
  }

  async followUp(text: string, images?: ImageInput[]): Promise<void> {
    await this.submitQueuedMessage("follow_up", text, images);
  }

  async sendUserMessage(
    text: string,
    images?: ImageInput[],
    deliverAs?: "steer" | "followUp",
  ): Promise<void> {
    if (text.startsWith('/')) {
      await this.prompt(text, images, { streamingBehavior: deliverAs ?? 'followUp' });
      return;
    }
    const epoch = this.eventEpoch;
    await this.abortInFlight;
    if (epoch !== this.eventEpoch) throw Object.assign(new Error('Session replaced before message submission'), { code: 'SESSION_REPLACED' });
    await this.client.requestRuntime('submitUserMessage', {
      text, deliverAs: deliverAs ?? 'followUp',
      ...(images?.length ? { images: images.map(image => ({ type: 'image', data: image.data, mimeType: image.mimeType })) } : {}),
    });
    await this.refreshQueue().catch(error => this.reportEntrySyncError(error));
    this.scheduleEntrySync();
  }

  async sendQueuedMessage(kind: "steering" | "followUp", index: number, entryId: string, maxResultBytes?: number): Promise<void> {
    const epoch = this.eventEpoch;
    await this.abortInFlight;
    if (epoch !== this.eventEpoch) throw Object.assign(new Error('Session replaced before queue submission'), { code: 'SESSION_REPLACED' });
    await this.client.requestRuntime("sendQueuedMessage", {
      kind, index, entryId, ...(maxResultBytes === undefined ? {} : { maxResultBytes }),
    });
    await this.refreshQueue().catch(error => this.reportEntrySyncError(error));
    this.scheduleEntrySync();
  }

  // ---------------------------------------------------------------- goal

  /** Official GoalRuntime lifecycle; never infer an operation from cached goal state. */
  async manageGoal(params: PiCommandParams["goal"]): Promise<JsonObject> {
    const epoch = this.eventEpoch;
    if ("images" in params) throw Object.assign(new Error("The official goal runtime does not support image attachments on goals"), { code: "INVALID_REQUEST" });
    if (params.tokenBudget !== undefined && (!Number.isSafeInteger(params.tokenBudget) || params.tokenBudget <= 0)) throw Object.assign(new Error("Goal token budget must be a positive integer"), { code: "INVALID_REQUEST" });
    if (params.clearBudget && params.tokenBudget !== undefined) throw Object.assign(new Error("Specify a token budget or clearBudget, not both"), { code: "INVALID_REQUEST" });
    if ((params.op === "create" || params.op === "replace") && !params.objective?.trim()) throw Object.assign(new Error("Goal objective is required"), { code: "INVALID_REQUEST" });
    if (params.op === "budget" && params.tokenBudget === undefined && !params.clearBudget) throw Object.assign(new Error("Specify tokenBudget or clearBudget for budget"), { code: "INVALID_REQUEST" });
    let result: JsonValue | undefined;
    if (["get", "create", "pause", "resume", "drop"].includes(params.op)) {
      result = unwrapResponse(await this.client.request({ type: "goal", op: params.op,
        ...(params.objective === undefined ? {} : { objective: params.objective.trim() }),
        ...(params.tokenBudget === undefined ? {} : { token_budget: params.tokenBudget }),
      }));
    } else if (["replace", "complete", "budget"].includes(params.op)) {
      result = await this.client.requestRuntime("goal", {
        op: params.op,
        ...(params.objective === undefined ? {} : { objective: params.objective.trim() }),
        ...(params.tokenBudget === undefined ? {} : { tokenBudget: params.tokenBudget }),
        ...(params.clearBudget === undefined ? {} : { clearBudget: params.clearBudget }),
      });
    } else throw Object.assign(new Error("Invalid goal operation"), { code: "INVALID_REQUEST" });
    if (epoch !== this.eventEpoch) throw Object.assign(new Error("Session changed before goal operation completed"), { code: "SESSION_REPLACED" });
    this.scheduleEntrySync();
    if (!isJsonObject(result)) throw new OmpRpcError("Invalid native goal result", "OMP_PROTOCOL_ERROR");
    return result;
  }

  async abort(): Promise<JsonValue | undefined> {
    if (this.abortInFlight) return this.abortInFlight;
    const epoch = this.eventEpoch;
    this.abortIntentEpoch = epoch;
    const flight = (async () => {
      const result = unwrapResponse(
        await this.client.request({ type: "abort" }, 30_000),
      );
      if (epoch !== this.eventEpoch) return toJson(result) ?? undefined;
      // An abort ACK is not proof of full settle: async work and retained native
      // user queues still belong to the session. Only native settle emits it.
      void this.buildState().then(() => {
        if (epoch === this.eventEpoch) this.emitActivityIfChanged();
      }).catch((error) => this.reportEntrySyncError(error));
      void this.syncEntriesNow().catch((error) => this.reportEntrySyncError(error));
      return toJson(result) ?? undefined;
    })();
    this.abortInFlight = flight;
    try {
      return await flight;
    } catch (error) {
      if (this.abortIntentEpoch === epoch) this.abortIntentEpoch = undefined;
      throw error;
    } finally {
      if (this.abortInFlight === flight) this.abortInFlight = undefined;
    }
  }

  async newSession(parentSession?: string): Promise<JsonObject> {
    const sourceSessionId = this.sessionId;
    const command: JsonObject = { type: "new_session" };
    if (parentSession) command.parentSession = parentSession;
    const result = unwrapResponse<JsonObject>(await this.client.request(command, 60_000));
    if (result?.cancelled === true) return { operation: "new", sourceSessionId, cancelled: true };
    await this.refreshIdentity();
    this.resetHistory();
    const projectionError = await this.restoreReplacementProjection();
    return {
      operation: "new",
      sourceSessionId,
      targetSessionId: this.sessionId,
      targetSessionFile: this.sessionFile ?? null,
      targetCwd: this.cwd,
      ...(projectionError === undefined ? {} : { projectionError }),
      cancelled: false,
    };
  }

  async switchSession(
    sessionPath: string,
    _cwdOverride?: string,
  ): Promise<JsonObject> {
    const sourceSessionId = this.sessionId;
    const target = resolveUserPath(sessionPath);
    assertOmpSessionFile(target);
    backupOmpSession(target);
    const result = unwrapResponse<JsonObject>(await this.client.request(
      { type: "switch_session", sessionPath: target }, 120_000,
    ));
    if (result?.cancelled === true) return { operation: "switch", sourceSessionId, cancelled: true };
    await this.refreshIdentity();
    if (this.sessionId !== sourceSessionId) this.resetHistory();
    else this.resetHistoryProjection();
    const projectionError = await this.restoreReplacementProjection();
    return {
      operation: "switch",
      sourceSessionId,
      targetSessionId: this.sessionId,
      targetSessionFile: this.sessionFile ?? null,
      targetCwd: this.cwd,
      ...(projectionError === undefined ? {} : { projectionError }),
      cancelled: false,
    };
  }

  private async restoreReplacementProjection(): Promise<string | undefined> {
    const epoch = this.eventEpoch;
    let projectionError: string | undefined;
    try {
      await Promise.all([
        this.refreshModels(), this.refreshAvailableCommands(),
      ]);
      this.assertEventEpoch(epoch);
      await this.syncEntriesNow();
      await this.getState();
    } catch (error) {
      this.reportEntrySyncError(error);
      projectionError = error instanceof Error ? error.message : String(error);
    }
    this.assertEventEpoch(epoch);
    this.emitHeadIfChanged();
    for (const listener of this.resourcesListeners) listener();
    return projectionError;
  }

  private assertEventEpoch(epoch: string): void {
    if (epoch !== this.eventEpoch) {
      throw Object.assign(new Error("Session replaced while reading native state"), { code: "SESSION_REPLACED" });
    }
  }

  private resetHistoryProjection(): void {
    this.historyGeneration += 1;
    this.messageStream.clear();
    this.entries = [];
    this.entriesSeeded = false;
    this.branchPages.clear();
    this.liveMessage = undefined;
    this.nativeFingerprint = "";
  }

  private resetHistory(): void {
    this.historyGeneration += 1;
    this.thinkingLevelsGeneration += 1;
    this.abortIntentEpoch = undefined;
    this.abortInFlight = undefined;
    this.toolInterruption = undefined;
    this.entries = [];
    this.branchPages.clear();
    this.leafId = null;
    this.entriesSeeded = false;
    this.liveMessage = undefined;
    this.eventEpoch = randomUUID();
    this.eventSequence = 0;
    this.retryShadow = { phase: "idle" };
    this.compactionShadow = { autoEnabled: true, operation: { type: "none" } };
    this.nativeQueue = { steering: [], followUp: [] };
    this.pendingAsyncWork = undefined;
    this.nativeSettled = true;
    this.currentStreaming = false;
    this.scopedModels = [];
    this.scopedModelPatterns = [];
    this.subagentRuns.clear();
    this.supersededSubagentParents.clear();
    this.subagentRunSequence = 0;
    this.subagentEvents.clear();
    this.messageStream.clear();
    this.modelsCache = [];
    this.modelsGeneration += 1;
    this.thinkingLevelsCache = [];
    clearTimeout(this.syncTimer);
    this.syncTimer = undefined;
    this.syncDirty = false;
    this.stateFlight = undefined;
    this.nativeFingerprint = "";
    this.lastActivity = { streaming: false, retrying: false, compacting: false };
    // Settle old dialogs with their original identity before publishing any
    // extension events from the refreshed session (including entry sync).
    this.extensionUi.cancelAll("session_replaced", false);
    this.extensionUi.bind(this.sessionId, (response) =>
      this.client.writeExtensionUiResponse(response),
    );
  }

  async fork(entryId: string, position: "before" | "at"): Promise<JsonObject> {
    if (position === "at" && (!this.ompVersion || compareOmpVersions(this.ompVersion, "18.12.6") < 0)) {
      throw Object.assign(new Error("Native inclusive message fork requires OMP 18.12.6 or newer"), { code: "CAPABILITY_DISABLED" });
    }
    const sourceSessionId = this.sessionId;
    const value = await this.client.requestRuntime("fork", { entryId, position }, 120_000);
    if (!isJsonObject(value)) throw new Error("Native fork returned an invalid operation receipt");
    const result = value;
    if (result.cancelled === true || result.aborted === true) return { ...result, operation: "fork", sourceSessionId };
    if (result.cancelled !== false || typeof result.sessionId !== "string" || typeof result.sessionFile !== "string" ||
      result.sessionId === sourceSessionId || result.sessionFile === this.sessionFile ||
      typeof result.cwd !== "string" || (typeof result.leafId !== "string" && result.leafId !== null))
      throw new Error("Native fork returned an invalid committed identity");
    // The native operation receipt is authoritative; a later read cannot undo
    // the file switch or turn it into a safely retriable operation failure.
    this.sessionId = result.sessionId;
    this.sessionFile = result.sessionFile;
    this.cwd = result.cwd;
    this.sessionName = null;
    this.resetHistory();
    this.leafId = result.leafId;
    const projectionError = await this.restoreReplacementProjection();
    return {
      ...result, operation: "fork", sourceSessionId,
      targetSessionId: this.sessionId,
      targetSessionFile: this.sessionFile ?? null,
      targetCwd: this.cwd,
      selectedText: result.selectedText ?? result.text ?? null,
      ...(projectionError === undefined ? {} : { projectionError }),
      cancelled: false,
    };
  }

  async importSession(
    _inputPath: string,
    _cwdOverride?: string,
  ): Promise<JsonObject> {
    unsupported("session import");
  }

  async setSessionName(name: string): Promise<void> {
    unwrapResponse(await this.client.request({ type: "set_session_name", name }, 30_000));
    this.sessionName = name;
    this.nativeFingerprint = "";
    this.emitHeadIfChanged();
  }

  async setModel(provider: string, modelId: string): Promise<void> {
    unwrapResponse(
      await this.client.request(
        { type: "set_model", provider, modelId },
        60_000,
      ),
    );
    await Promise.all([this.refreshModels(), this.refreshThinkingLevels()]);
  }

  async cycleModel(direction: "forward" | "backward" = "forward"): Promise<void> {
    await this.client.requestRuntime("cycleModel", { direction }, 60_000);
    await Promise.all([this.refreshModels(), this.refreshThinkingLevels()]);
  }

  async setScopedModels(patterns: string[]): Promise<JsonValue | undefined> {
    const epoch = this.eventEpoch;
    const result = await this.client.requestRuntime("setScopedModels", { patterns }, 60_000);
    if (epoch !== this.eventEpoch) return result;
    this.scopedModels = isJsonObject(result) && Array.isArray(result.scopedModels)
      ? result.scopedModels : [];
    this.scopedModelPatterns = isJsonObject(result) && Array.isArray(result.scopedModelPatterns)
      ? result.scopedModelPatterns.filter((pattern): pattern is string => typeof pattern === "string") : [];
    return result;
  }

  async setThinkingLevel(level: string): Promise<void> {
    unwrapResponse(
      await this.client.request({ type: "set_thinking_level", level }, 30_000),
    );
  }

  async cycleThinkingLevel(): Promise<JsonValue | undefined> {
    const response = await this.client.request(
      { type: "cycle_thinking_level" },
      30_000,
    );
    const data = unwrapResponse<JsonValue>(response);
    return data === undefined ? undefined : toJson(data);
  }

  async setSteeringMode(mode: "all" | "one-at-a-time"): Promise<void> {
    unwrapResponse(await this.client.request({ type: "set_steering_mode", mode }, 30_000));
    this.stateFlight = undefined;
  }

  async setFollowUpMode(mode: "all" | "one-at-a-time"): Promise<void> {
    unwrapResponse(await this.client.request({ type: "set_follow_up_mode", mode }, 30_000));
    this.stateFlight = undefined;
  }

  async setInterruptMode(mode: "immediate" | "wait"): Promise<void> {
    const epoch = this.eventEpoch;
    unwrapResponse(await this.client.request({ type: "set_interrupt_mode", mode }, 30_000));
    const native = await this.fetchState();
    if (epoch !== this.eventEpoch) throw Object.assign(new Error("Session replaced while setting interrupt mode"), { code: "SESSION_REPLACED" });
    if (native.interruptMode !== mode) throw Object.assign(new Error("Native interrupt mode readback did not match the requested value"), { code: "SUBMISSION_NOT_ADMITTED" });
  }

  private interruptSubmissionEpoch: string | undefined;

  async abortAndPrompt(text: string, images?: ImageInput[]): Promise<void> {
    if (this.interruptSubmissionEpoch === this.eventEpoch) throw Object.assign(new Error("An interrupt-and-prompt submission is already pending"), { code: "SESSION_BUSY" });
    const epoch = this.eventEpoch;
    this.interruptSubmissionEpoch = epoch;
    const assertIdentity = () => {
      if (epoch !== this.eventEpoch) throw Object.assign(new Error("Session replaced before interrupt submission"), { code: "SESSION_REPLACED" });
    };
    try {
      await this.abortInFlight;
      assertIdentity();
      const command: JsonObject = { type: "abort_and_prompt", message: text };
      if (images?.length) command.images = images.map((image) => ({ type: "image", data: image.data, mimeType: image.mimeType }));
      // The official ACK precedes prompt setup. Only this command's correlated
      // result can distinguish pre-agent rejection from an admitted turn.
      unwrapResponse(await requestNativePromptAcceptance(this.client, command, 300_000, assertIdentity));
      if (epoch === this.eventEpoch) await this.refreshQueue().catch(error => this.reportEntrySyncError(error));
    } finally {
      if (this.interruptSubmissionEpoch === epoch) this.interruptSubmissionEpoch = undefined;
      if (epoch === this.eventEpoch) this.scheduleEntrySync();
    }
  }

  async clearQueue(maxResultBytes?: number): Promise<JsonValue | undefined> {
    const result = await this.client.requestRuntime("clearQueue", {
      ...(maxResultBytes === undefined ? {} : { maxResultBytes }),
    });
    await this.refreshQueue();
    return result;
  }

  async removeQueuedMessage(
    kind: "steering" | "followUp", index: number, entryId: string,
    maxResultBytes?: number, returnContent = true,
  ): Promise<JsonValue> {
    const epoch = this.eventEpoch;
    await this.abortInFlight;
    if (epoch !== this.eventEpoch) throw Object.assign(new Error('Session replaced before queue selection'), { code: 'SESSION_REPLACED' });
    const result = await this.client.requestRuntime("removeQueuedMessage", {
      kind, index, entryId, returnContent,
      ...(maxResultBytes === undefined ? {} : { maxResultBytes }),
    });
    await this.refreshQueue().catch(error => this.reportEntrySyncError(error));
    return result;
  }

  async compact(customInstructions?: string): Promise<JsonValue | undefined> {
    const command: JsonObject = { type: "compact" };
    if (customInstructions) command.customInstructions = customInstructions;
    try {
      const response = await this.client.request(command, 300_000);
      const result = toJson(unwrapResponse(response));
      return { status: "completed", result };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/nothing to compact/i.test(message)) {
        return { status: "skipped", reason: "session_too_small", message };
      }
      throw error;
    }
  }

  async abortCompaction(): Promise<void> {
    // OMP RPC 无独立 abort compaction：abort 会话运行（含压缩）
    await this.abort();
  }

  async abortBranchSummary(): Promise<void> {
    await this.client.requestRuntime("abortBranchSummary");
  }

  async setAutoCompaction(enabled: boolean): Promise<void> {
    unwrapResponse(await this.client.request({ type: "set_auto_compaction", enabled }, 30_000));
  }

  async setAutoRetry(enabled: boolean): Promise<void> {
    unwrapResponse(await this.client.request({ type: "set_auto_retry", enabled }, 30_000));
  }

  async abortRetry(): Promise<void> {
    unwrapResponse(await this.client.request({ type: "abort_retry" }, 30_000));
  }

  async bash(
    command: string,
    _excludeFromContext = false,
    clientId?: string,
  ): Promise<JsonValue | undefined> {
    const normalized = command.trim();
    if (!normalized)
      throw Object.assign(new Error("empty bash command"), {
        code: "INVALID_REQUEST",
      });
    try {
      const response = await this.client.request(
        { type: "bash", command: normalized },
        600_000,
      );
      return toJson(unwrapResponse(response)) ?? undefined;
    } finally {
      void clientId;
      this.scheduleEntrySync();
    }
  }

  async abortBash(): Promise<void> {
    unwrapResponse(await this.client.request({ type: "abort_bash" }, 30_000));
  }

  async setActiveTools(_toolNames: string[]): Promise<void> {
    unsupported("runtime tool activation");
  }

  async invokeTool(
    _name: string,
    _args?: JsonObject,
  ): Promise<JsonValue | undefined> {
    unsupported("direct tool invocation");
  }

  async invokeCommand(
    name: string,
    args?: string,
  ): Promise<JsonValue | undefined> {
    // OMP 的 slash 命令通过 prompt 触发；command_output 事件帧承载输出
    const message = args ? `/${name} ${args}` : `/${name}`;
    await this.prompt(message, undefined, { streamingBehavior: "followUp" });
    return undefined;
  }

  async getCommandCompletions(name: string, prefix: string): Promise<JsonValue | undefined> {
    const commands = Array.isArray(this.availableCommandsCache) ? this.availableCommandsCache.filter(isJsonObject) : [];
    const command = commands.find((item) => item.name === name ||
      (Array.isArray(item.aliases) && item.aliases.includes(name)));
    if (!Array.isArray(command?.subcommands)) return undefined;
    return command.subcommands.flatMap((item) => {
      const value = typeof item === "string" ? item : isJsonObject(item) ? item.name : undefined;
      if (typeof value !== "string" || !value.startsWith(prefix)) return [];
      return [{ value, label: value,
        ...(isJsonObject(item) && typeof item.description === "string" ? { description: item.description } : {}) }];
    });
  }

  async navigateTree(
    entryId: string,
    options: { summarize?: boolean; customInstructions?: string } = {},
  ): Promise<JsonObject> {
    const sourceSessionId = this.sessionId;
    const value = await this.client.requestRuntime("navigateTree", { entryId, ...options }, 300_000);
    if (!isJsonObject(value)) throw new Error("Native navigation returned an invalid operation receipt");
    const result = value;
    if (result.cancelled === true || result.aborted === true) return result;
    if (result.cancelled !== false || result.sessionId !== sourceSessionId || result.sessionFile !== (this.sessionFile ?? null) ||
      (typeof result.leafId !== "string" && result.leafId !== null))
      throw new Error("Native navigation returned an invalid committed identity");
    if (result.noOp === true) return { ...result, sourceSessionId, targetSessionId: this.sessionId };
    // Navigation keeps the native file and identity; never implement it as branch.
    // Only invalidate the history projection. Native same-file navigation does
    // not replace the runtime's model scope, queues, subagents, or extension UI.
    this.resetHistoryProjection();
    this.leafId = result.leafId;
    let projectionError: string | undefined;
    try {
      await this.syncEntriesNow();
      await this.refreshQueue();
    } catch (error) {
      this.reportEntrySyncError(error);
      projectionError = error instanceof Error ? error.message : String(error);
    }
    this.emitHeadIfChanged();
    return { ...result, sourceSessionId, targetSessionId: this.sessionId,
      editorText: result.editorText ?? null, cancelled: false,
      aborted: false, summaryEntry: result.summaryEntry ?? null,
      ...(projectionError === undefined ? {} : { projectionError }) };
  }

  async setLabel(entryId: string, label?: string): Promise<void> {
    await this.client.requestRuntime("setLabel", { entryId, ...(label === undefined ? {} : { label }) });
    await this.syncEntriesNow();
  }

  async sendCustomMessage(
    customType: string,
    _content: never,
    _options: unknown,
  ): Promise<void> {
    void customType;
    unsupported("custom message delivery");
  }

  async appendCustomEntry(
    _customType: string,
    _data?: JsonValue,
  ): Promise<void> {
    unsupported("custom entry append");
  }

  async exportHtml(outputPath: string): Promise<JsonValue | undefined> {
    await this.waitForIdle();
    const response = await this.client.request(
      { type: "export_html", outputPath },
      120_000,
    );
    const data = unwrapResponse<JsonValue>(response);
    return toJson({
      path:
        isJsonObject(data) && typeof data.path === "string"
          ? data.path
          : outputPath,
    });
  }

  async exportJsonl(outputPath: string): Promise<JsonValue | undefined> {
    // 会话文件本身就是 JSONL：直接复制
    if (!this.sessionFile)
      throw Object.assign(new Error("session file not persisted yet"), {
        code: "NOT_FOUND",
      });
    await this.waitForIdle();
    await this.syncEntriesNow();
    copyFileSync(this.sessionFile, outputPath);
    return { path: outputPath };
  }

  async waitForIdle(): Promise<void> {
    const deadline = Date.now() + 10 * 60_000;
    while (Date.now() < deadline) {
      if (this.closed) throw new Error("Session closed before settling");
      const native = await this.fetchState();
      const settled = native.isSettled === true ||
        (native.isSettled === undefined && native.isStreaming === false &&
          !native.hasPendingAsyncWork && !native.queuedMessageCount);
      if (settled) return;
      await new Promise<void>(resolve => setTimeout(resolve, 300));
    }
    throw Object.assign(new Error("Session did not settle before the deadline"), { code: "SESSION_BUSY" });
  }

  async reload(): Promise<void> {
    await this.client.requestRuntime("reload", {}, 120_000);
    await Promise.all([this.refreshModels(), this.refreshThinkingLevels(), this.refreshAvailableCommands()]);
    this.nativeFingerprint = "";
    this.emitHeadIfChanged();
    for (const listener of this.resourcesListeners) listener();
  }

  respondExtensionUi(
    requestId: string,
    response: JsonObject,
  ): Promise<boolean> {
    return Promise.resolve(this.extensionUi.respond(requestId, response));
  }

  async setExtensionEditorState(_text: string): Promise<void> {
    // host→extension 编辑器状态在 OMP RPC 中无对应帧：no-op
  }

  extensionTuiInput(_data: string): void {
    /* offscreen 扩展 TUI 不支持 */
  }

  extensionTuiResize(_cols: number, _rows: number): void {
    /* offscreen 扩展 TUI 不支持 */
  }

  extensionTuiRedraw(): void {
    /* offscreen 扩展 TUI 不支持 */
  }

  // ---------------------------------------------------------------- subagents

  /** 子代理帧监听（worker 转发到 omp.subagent 通道） */
  onSubagentFrame(listener: (event: JsonObject) => void): Unsubscribe {
    this.subagentListeners.add(listener);
    return () => this.subagentListeners.delete(listener);
  }

  setOutputPaused(paused: boolean): void {
    this.outputPaused = paused;
    this.messageStream.setPaused(this.outputPaused);
    this.subagentEvents.setPaused(this.outputPaused);
    this.client.setOutputPaused?.(this.outputPaused);
  }

  async listSubagents(): Promise<JsonValue> {
    const epoch = this.eventEpoch;
    const observed = new Map(this.subagentRuns);
    try {
      const response = await this.client.request(
        { type: "get_subagents" },
        30_000,
      );
      const data = unwrapResponse<JsonValue>(response);
      if (epoch !== this.eventEpoch) throw new OmpRpcError("The native session was replaced", "SESSION_REPLACED");
      const list =
        isJsonObject(data) && Array.isArray(data.subagents)
          ? data.subagents
          : Array.isArray(data)
            ? data
            : [];
      for (const item of list) {
        if (isJsonObject(item) && typeof item.id === "string") {
          // A registry read can finish after a newer lifecycle/progress frame.
          // Preserve that generation rather than replaying its previous status.
          if (this.subagentRuns.get(item.id) !== observed.get(item.id)) continue;
          const existing = this.subagentRuns.get(item.id);
          const ownerChanged = existing && (
            (typeof item.parentToolCallId === "string" && item.parentToolCallId !== existing.parentToolCallId) ||
            (typeof item.sessionFile === "string" && item.sessionFile !== existing.sessionFile));
          const active = item.status === "running" || item.status === "pending";
          const terminal = existing?.status === "completed" || existing?.status === "failed" || existing?.status === "aborted";
          const restart = Boolean(existing && (ownerChanged || (terminal && active)));
          const runId = !existing || restart
            ? `${this.eventEpoch}:${item.id}:${++this.subagentRunSequence}` : existing.runId;
          this.rememberSubagent(item.id, {
            ...(!restart ? existing : undefined), ...item, runId,
            isFollowUp: restart ? !ownerChanged : existing?.isFollowUp,
          });
        }
      }
      return this.getSubagentsSnapshot();
    } catch (error) {
      if (epoch !== this.eventEpoch || (error instanceof OmpRpcError && error.code === "SESSION_REPLACED"))
        throw new OmpRpcError("The native session was replaced", "SESSION_REPLACED");
      return [...this.subagentRuns.values()];
    }
  }

  async getSubagentMessages(params: import("@ompiui/protocol").SubagentMessagesParams): Promise<JsonValue> {
    if (params.sessionFile) {
      try {
        return await readChildSessionPreviewPage(
          params.sessionFile,
          params.fromByte ?? 0,
          params.sync,
        );
      } catch (error) {
        if ((error as { code?: string }).code !== "NOT_FOUND") throw error;
      }
    }
    const command: JsonObject = { type: "get_subagent_messages" };
    if (params.subagentId) command.subagentId = params.subagentId;
    if (params.sessionFile) command.sessionFile = params.sessionFile;
    if (typeof params.fromByte === "number") command.fromByte = params.fromByte;
    try {
      const response = await this.client.request(command, 60_000);
      const result = unwrapResponse<JsonValue>(response) ?? {};
      const settings = getPreviewSettings();
      if (isJsonObject(result) && Array.isArray(result.messages))
        return {
          ...result,
          messages: result.messages
            .filter(isJsonObject)
            .map(
              (message) =>
                projectPreviewMessage(message, settings.subagentThinking)
                  .message,
            ),
        };
      return result;
    } catch (error) {
      // OMP 的子代理注册表是进程内的：worker/omp 重启后旧 run 的
      // sessionFile 一律 "Unknown subagent session file"。转录落盘在
      // 子会话 jsonl 里——读磁盘兜底（返回形状与 RPC 一致），重开
      // 会话/换实例后内联转录仍能回填。
      if (params.sessionFile) {
        return readChildSessionPreviewPage(
          params.sessionFile,
          params.fromByte ?? 0,
          params.sync,
        );
      }
      throw error;
    }
  }

  onCrash(listener: (error: Error) => void): Unsubscribe {
    this.crashListeners.add(listener);
    return () => this.crashListeners.delete(listener);
  }

  onClose(listener: () => void): Unsubscribe {
    this.closeListeners.add(listener);
    return () => this.closeListeners.delete(listener);
  }

  getCwd(): string {
    return this.cwd;
  }

  /** 崩溃诊断用：omp 子进程 stderr 末尾 */
  get stderrTail(): string {
    return this.client?.stderrTail ?? "";
  }

  get runtimeExitInfo(): JsonObject {
    return this.client.runtimeExitInfo;
  }

  getSessionId(): string {
    return this.sessionId;
  }

  getSessionFile(): string | undefined {
    return this.sessionFile;
  }

  onPiEvent(
    listener: (event: JsonObject, meta: PiEventMeta) => void,
  ): Unsubscribe {
    this.piEventListeners.add(listener);
    return () => this.piEventListeners.delete(listener);
  }

  onHead(listener: (head: SessionHead) => void): Unsubscribe {
    this.headListeners.add(listener);
    // 迟到订阅者立即拿到当前 head
    listener(this.getHead());
    return () => this.headListeners.delete(listener);
  }

  onActivity(
    listener: (status: SessionActivityStatus | null) => void,
  ): Unsubscribe {
    this.activityListeners.add(listener);
    return () => this.activityListeners.delete(listener);
  }

  onExtensionUi(listener: (event: JsonObject) => void): Unsubscribe {
    return this.extensionUi.onEvent(listener as never);
  }

  onResourcesChanged(listener: () => void): Unsubscribe {
    this.resourcesListeners.add(listener);
    return () => this.resourcesListeners.delete(listener);
  }

  async dispose(): Promise<void> {
    this.closed = true;
    clearTimeout(this.syncTimer);
    this.extensionUi.cancelAll("runtime_disposed");
    this.piEvents.flush();
    this.piEventListeners.clear();
    this.messageStream.clear();
    this.headListeners.clear();
    this.activityListeners.clear();
    this.subagentEvents.dispose();
    this.subagentListeners.clear();
    this.crashListeners.clear();
    this.closeListeners.clear();
    this.resourcesListeners.clear();
    await this.client.close();
  }
}

export { OMP_SDK_VERSION };
