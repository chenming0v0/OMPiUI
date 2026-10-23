/**
 * OMPiUI domain types, re-exported from src/omp/vendor.
 * Those local declarations originated in PiUI and describe the UI-facing
 * message/session shapes adapted from OMP RPC. They do not load a Pi SDK.
 */

// Session entries and metadata
export type {
  SessionEntry,
  SessionEntryBase,
  SessionMessageEntry,
  ThinkingLevelChangeEntry,
  ModelChangeEntry,
  CompactionEntry,
  BranchSummaryEntry,
  CustomEntry,
  CustomMessageEntry,
  SessionInfoEntry,
  SessionInfo,
  SessionHeader,
  SessionTreeNode,
  SessionContext,
} from '../vendor/pi-coding-agent'

// Agent messages and content blocks
export type { AgentMessage, AgentEvent, ThinkingLevel } from '../vendor/pi-agent-core'
export type {
  UserMessage,
  AssistantMessage,
  ToolResultMessage,
  TextContent,
  ThinkingContent,
  ImageContent,
  ToolCall,
  Usage,
  StopReason,
  Model,
} from '../vendor/pi-ai'

// Agent session runtime
export type { AgentSessionEvent, SessionStats, PromptOptions, ModelCycleResult } from '../vendor/pi-coding-agent'

// Custom messages (bashExecution, custom, branchSummary, compactionSummary)
// are part of the vendored AgentMessage union — extract them by role.
export type BashExecutionMessage = Extract<AgentMessage, { role: 'bashExecution' }>
export type CustomMessage = Extract<AgentMessage, { role: 'custom' }>
export type BranchSummaryMessage = Extract<AgentMessage, { role: 'branchSummary' }>
export type CompactionSummaryMessage = Extract<AgentMessage, { role: 'compactionSummary' }>

// Registry
export type {
  ToolDescriptor,
  CommandDescriptor,
  ExtensionDescriptor,
  PiCapability,
  PiRegistrySnapshot,
} from '@ompiui/protocol'

// Protocol primitives
export type {
  JsonValue,
  JsonObject,
  CommandEnvelope,
  CommandRecord,
  CommandStatus,
  EventEnvelope,
  EventCursor,
  EventChannel,
  EventStreamRef,
  Problem,
  ErrorCode,
} from '@ompiui/protocol'

// ============================================================
// OMPiUI-specific derived view models (not domain types)
// ============================================================

import type { SessionEntry } from '../vendor/pi-coding-agent'
import type { AgentMessage } from '../vendor/pi-agent-core'
import type {
  UserMessage,
  AssistantMessage,
  ToolResultMessage,
  TextContent,
  ThinkingContent,
  ImageContent,
  ToolCall,
} from '../vendor/pi-ai'
import type { JsonObject, JsonValue, EntriesPage, BranchCheckpoint, LiveMessage } from '@ompiui/protocol'

/**
 * Pi Session row for sidebar display.
 * Derived from SessionInfo for UI consumption.
 */
export type PiSessionRow = {
  id: string
  sessionFile: string
  cwd: string
  title: string
  preview?: string
  createdAt: number
  modifiedAt: number
  messageCount: number
  parentSessionPath?: string
  forkParent?: {
    id: string
    title: string
  }
}

/**
 * Pi timeline item for chat rendering.
 * Each item preserves its raw entry and provides type-safe rendering data.
 * Tool results are paired back into their owning assistant item so the
 * message keeps its embedded tool calls (matching chat UI structure).
 */
export type PiTimelineItem = (
  | PiUserMessageItem
  | PiAssistantMessageItem
  | PiToolResultItem
  | PiBashExecutionItem
  | PiBashExecutionGroupItem
  | PiCompactionItem
  | PiBranchSummaryItem
  | PiCustomMessageItem
  | PiModeChangeItem
  | PiUnknownItem
) & {
  /** Stable React identity while a live message becomes a persisted entry. */
  renderKey?: string
}

export type PiUserMessageItem = {
  kind: 'user_message'
  entryId: string
  timestamp: number
  rawEntry: SessionEntry
  message: UserMessage
  blocks: (TextContent | ImageContent)[]
  renderKey?: string
}

export type PiAssistantMessageItem = {
  kind: 'assistant_message'
  entryId: string
  timestamp: number
  rawEntry: SessionEntry
  message: AssistantMessage
  blocks: (TextContent | ThinkingContent | ToolCall)[]
  /** Tool results paired by toolCallId; empty while a call has no result yet */
  toolResults: Record<string, ToolResultMessage>
  /** Execution evidence keyed by call id; message timestamps are never tool starts. */
  toolExecutions?: Record<string, PiToolExecutionState>
  /** True for the live streaming message (not yet persisted as an entry) */
  isStreaming?: boolean
  renderKey?: string
}

/** Result/start visible even when pagination omits the owning assistant. */
export type PiToolResultItem = {
  kind: 'tool_result'
  entryId: string
  timestamp: number
  rawEntry?: SessionEntry
  execution: PiToolExecution
}

export type PiBashExecutionItem = {
  kind: 'bash_execution'
  entryId: string
  timestamp: number
  rawEntry: SessionEntry
  message: BashExecutionMessage
}

/**
 * 相邻 bash 执行（用户 `!cmd` / `/bash cmd` 发起的）合并为一个工具组，
 * 与 AI 连续调用工具时的 ToolGroup 渲染一致（steps header + timeline）。
 * entryId 取组内第一个 bash 的 entryId（稳定渲染 key）。
 */
export type PiBashExecutionGroupItem = {
  kind: 'bash_execution_group'
  entryId: string
  timestamp: number
  items: PiBashExecutionItem[]
}

/** Per-call execution evidence from persisted starts or the live event stream. */
export type PiToolExecutionState = {
  startedAt?: number
  /** Updates prove execution without inventing a start time when the start frame was missed. */
  isRunning?: boolean
  result?: ToolResultMessage
  call?: ToolCall
  completedAt?: number
  /** Authoritative interruption/crash evidence; never inferred from elapsed time. */
  error?: string
  interruption?: 'failed' | 'cancelled' | 'unknown'
  endedAt?: number
}

/** One tool call plus its authoritative result and execution evidence. */
export type PiToolExecution = PiToolExecutionState & {
  call: ToolCall
}

export function getToolExecutionStatus(execution: PiToolExecution): 'pending' | 'running' | 'completed' | 'error' {
  if (execution.result) {
    const details = execution.result.details as { error?: unknown; mergeError?: unknown; nativeDetails?: { error?: unknown; mergeError?: unknown }; results?: Array<{ error?: unknown; mergeError?: unknown; aborted?: boolean; exitCode?: number }> } | undefined
    const failed = execution.result.isError || Boolean(details?.error || details?.mergeError || details?.nativeDetails?.error || details?.nativeDetails?.mergeError) ||
      (execution.call.name === 'task' && Array.isArray(details?.results) && details.results.some(result => result && (result.error || result.mergeError || result.aborted || (result.exitCode !== undefined && result.exitCode !== 0))))
    return failed ? 'error' : 'completed'
  }
  if (execution.error) return 'error'
  if (execution.completedAt !== undefined) return 'completed'
  return (execution.isRunning ?? execution.startedAt !== undefined) ? 'running' : 'pending'
}

export type PiCompactionItem = {
  kind: 'compaction'
  entryId: string
  timestamp: number
  rawEntry: SessionEntry
  summary: string
  tokensBefore: number
  firstKeptEntryId: string
  details?: unknown
}

export type PiBranchSummaryItem = {
  kind: 'branch_summary'
  entryId: string
  timestamp: number
  rawEntry: SessionEntry
  summary: string
  fromId: string
  details?: unknown
}

export type PiCustomMessageItem = {
  kind: 'custom_message'
  entryId: string
  timestamp: number
  rawEntry: SessionEntry
  customType: string
  content: string | (TextContent | ImageContent)[]
  display: boolean
  details?: unknown
}

/**
 * OMP `mode_change` 条目（agent 模式切换标记，如 goal / plan；mode "none"
 * 表示退出模式）。vendored Pi union 没有该变体——OMP 18.x 在 Pi 基础上
 * 扩展的条目类型，运行时透传到前端，这里按结构读取。
 */
export type PiModeChangeItem = {
  kind: 'mode_change'
  entryId: string
  timestamp: number
  rawEntry: SessionEntry
  mode: string
  data?: unknown
}

export type PiUnknownItem = {
  kind: 'unknown'
  entryId: string
  timestamp: number
  rawEntry: SessionEntry
  entryType: string
}

/**
 * Pi session runtime state (from state.get command).
 * Raw state from backend, kept as JsonObject for forward compatibility.
 */
export type PiSessionRuntimeState = JsonObject

/**
 * Native settings snapshot (worker settings.get). Shape is defined by the
 * worker's catalog: raw scopes plus the resolved effective values.
 */
export type PiSettingsSnapshot = {
  workspacePath: string
  global: JsonObject
  project: JsonObject
  effective: JsonObject
  errors: Array<{ scope: string; message: string }>
  definitions?: Array<{ id: string; type: string; values?: string[] }>
}

/** Native provider auth info (worker providers.list). */
export type PiProviderAuthMethod = {
  type: 'api_key' | 'oauth'
  name?: string
  loginAvailable: boolean
}

export type PiProviderAuthInfo = {
  id: string
  name: string
  methods: PiProviderAuthMethod[]
  configured: boolean
  status?: JsonValue
}

/** Native model runtime inspection (worker modelRuntime.inspect). */
export type PiModelRuntimeSnapshot = {
  providers?: PiProviderAuthInfo[]
  models?: JsonValue
  availableModels?: JsonValue[]
  availableSnapshot?: JsonValue
  credentials?: JsonValue
  registeredProviderIds?: string[]
  registeredProviderConfigs?: JsonObject
  authChecks?: JsonObject
  error?: string | null
}

/** One custom model definition inside `~/.omp/agent/models.yml` → `providers.<id>.models[]`. */
export type PiModelProviderModelConfig = {
  id: string
  /** 编辑已有模型时记录原 id；服务端据此合并不在编辑器里暴露的字段（cost/compat 等）。 */
  originalId?: string
  name?: string
  api?: string
  baseUrl?: string
  contextWindow?: number
  maxTokens?: number
  reasoning?: boolean
  input?: Array<'text' | 'image'>
  thinking?: {
    mode?: string
    efforts?: string[]
    defaultLevel?: string
    effortMap?: Record<string, string>
  } | null
  cost?: {
    input?: number
    output?: number
    cacheRead?: number
    cacheWrite?: number
  }
}

/** One custom provider (`~/.omp/agent/models.yml` → `providers.<id>`). */
export type PiModelProviderConfig = {
  id: string
  name: string
  api: string
  baseUrl: string
  apiKey: string
  authHeader?: boolean
  models: PiModelProviderModelConfig[]
}

/** `models.providers.get` / `models.providers.save` / `models.providers.delete` result. */
export type PiModelProvidersSnapshot = {
  /** Absolute path of the models.yml file the server read or wrote. */
  path: string
  /** False when the file does not exist yet (still saveable). */
  exists: boolean
  /** False for the mock driver or other runtimes without a config file. */
  supported: boolean
  providers: PiModelProviderConfig[]
  error?: string
}

/** `models.providers.fetch` result — upstream ids plus configured ids missing upstream. */
export type PiModelProviderFetchResult = {
  models: string[]
  removed: string[]
  total: number
}

/** 模型编辑器使用的可选 models.dev 能力匹配结果。 */
export type PiModelsDevLookupResult = {
  found: boolean
  provider?: string
  modelId?: string
  name?: string
  contextWindow?: number
  maxTokens?: number
  reasoning?: boolean
  input?: Array<'text' | 'image'>
  thinking?: {
    mode?: 'effort' | 'anthropic-adaptive' | 'anthropic-budget-effort' | 'budget' | 'google-level'
    efforts?: string[]
    defaultLevel?: string
  } | null
}

/** Native OMP plugin manager snapshots, not the obsolete Pi SDK package manager. */
export type PiConfiguredPackage = {
  source: string
  scope: 'user' | 'project'
  enabled: boolean
  version: string
  type: 'npm' | 'git' | 'link' | 'marketplace'
  installedPath: string
  shadowedBy?: 'project'
}

export type PiMarketplaceSource = {
  name: string
  source: string
  sourceType: 'github' | 'git' | 'url' | 'local'
  catalogPath: string
}

export type PiPackagesSnapshot = {
  packages: PiConfiguredPackage[]
  marketplaces: PiMarketplaceSource[]
}

export type OmpPackageResource = {
  path: string
  name?: string
  enabled: boolean
  scope: 'user' | 'project'
  source: string
}

export type OmpResolvedPackageResources = {
  extensions: OmpPackageResource[]
  tools: OmpPackageResource[]
  hooks: OmpPackageResource[]
  commands: OmpPackageResource[]
  skills: OmpPackageResource[]
  prompts: OmpPackageResource[]
  rules: OmpPackageResource[]
  mcpServers: OmpPackageResource[]
  warnings: string[]
}

export type PiPackageUpdate = {
  source: string
  displayName: string
  type: 'marketplace'
  scope: 'user' | 'project'
  from: string
  to: string
}

/**
 * Pi branch page (from branch.get command).
 * Structure comes from protocol EntriesPage; items and liveMessage are
 * narrowed to SDK types since the backend guarantees their shapes.
 */
export type PiLiveMessage = Omit<LiveMessage, 'message'> & { message: AgentMessage }
export type PiBranchCheckpoint = Omit<BranchCheckpoint, 'liveMessage'> & { liveMessage?: PiLiveMessage }
export type PiBranchPage = Omit<EntriesPage, 'items' | 'checkpoint'> & {
  items: SessionEntry[]
  checkpoint?: PiBranchCheckpoint
  client?: {
    stableEntryIds?: Record<string, string>
    historyWindowed?: boolean
    toolExecutions?: Record<string, PiToolExecutionState>
  }
}

/**
 * Pi session data store shape.
 * Contains all raw data for one active session.
 */
export type PiActiveSessionData = {
  sessionId: string
  state: PiSessionRuntimeState
  branch: PiBranchPage
  entries: SessionEntry[]
  status: 'loading' | 'loaded' | 'error'
  error?: Error
}

/**
 * Pi composer mode derived from session state.
 */
export type PiComposerMode =
  | { type: 'idle' }
  | { type: 'streaming'; steeringMode: 'all' | 'one-at-a-time' }
  | { type: 'streaming'; followUpMode: 'all' | 'one-at-a-time' }

/**
 * Pi command lifecycle for UI tracking.
 */
export type PiCommandLifecycle = {
  id: string
  name: string
  status: 'accepted' | 'running' | 'completed' | 'failed' | 'cancelled' | 'unknown_after_crash'
  submittedAt: string
  completedAt?: string
  result?: unknown
  error?: unknown
}

/**
 * Pi event cursor for WS subscription.
 */
export type PiEventCursor = {
  epoch: string
  sequence: number
}
