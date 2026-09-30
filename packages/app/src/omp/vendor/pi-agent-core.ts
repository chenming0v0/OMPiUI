/* eslint-disable @typescript-eslint/no-explicit-any -- faithful copies of the SDK declarations */
/**
 * Vendored type definitions from `@earendil-works/pi-agent-core` (v0.84.2).
 *
 * The app only ever consumed the SDK's *types* (the agent runtime lives in the
 * OMP worker, not here), so the dependency was stripped and the declarations
 * the UI actually renders are kept here as the source of truth.
 *
 * In the SDK, `AgentMessage` is `Message | CustomAgentMessages[keyof ...]`
 * where the coding agent contributes the extra roles via declaration merging.
 * Here that augmentation is inlined directly into the union.
 */

import type {
  AssistantMessageEvent,
  ImageContent,
  Message,
  TextContent,
  ToolResultMessage,
} from './pi-ai'

/**
 * Thinking/reasoning level for models that support it.
 * Note: "xhigh" and "max" are only supported by selected model families. Use model
 * thinking-level metadata to detect support for a concrete model.
 */
export type ThinkingLevel = 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'

// ---------------------------------------------------------------------------
// Coding-agent custom messages (SDK: pi-coding-agent core/messages.d.ts,
// merged into AgentMessage via CustomAgentMessages)
// ---------------------------------------------------------------------------

/** Message type for bash executions via the ! command. */
export interface BashExecutionMessage {
  role: 'bashExecution'
  command: string
  output: string
  exitCode: number | undefined
  cancelled: boolean
  truncated: boolean
  fullOutputPath?: string
  timestamp: number
  /** If true, this message is excluded from LLM context (!! prefix) */
  excludeFromContext?: boolean
}

/** Message type for extension-injected messages via sendMessage(). */
export interface CustomMessage<T = unknown> {
  role: 'custom'
  customType: string
  content: string | (TextContent | ImageContent)[]
  display: boolean
  details?: T
  timestamp: number
}

export interface BranchSummaryMessage {
  role: 'branchSummary'
  summary: string
  fromId: string
  timestamp: number
}

export interface CompactionSummaryMessage {
  role: 'compactionSummary'
  summary: string
  tokensBefore: number
  timestamp: number
}

/** Union of LLM messages + the coding agent's custom message roles. */
export type AgentMessage =
  | Message
  | BashExecutionMessage
  | CustomMessage
  | BranchSummaryMessage
  | CompactionSummaryMessage

// ---------------------------------------------------------------------------
// Agent events
// ---------------------------------------------------------------------------

/**
 * Events emitted by the Agent for UI updates.
 *
 * `agent_end` is the last event emitted for a run, but awaited `Agent.subscribe()`
 * listeners for that event are still part of run settlement. The agent becomes
 * idle only after those listeners finish.
 */
export type AgentEvent = {
  type: 'agent_start'
} | {
  type: 'agent_end'
  messages: AgentMessage[]
} | {
  type: 'turn_start'
} | {
  type: 'turn_end'
  message: AgentMessage
  toolResults: ToolResultMessage[]
} | {
  type: 'message_start'
  message: AgentMessage
} | {
  type: 'message_update'
  message: AgentMessage
  assistantMessageEvent: AssistantMessageEvent
} | {
  type: 'message_end'
  message: AgentMessage
} | {
  type: 'tool_execution_start'
  toolCallId: string
  toolName: string
  args: any
} | {
  type: 'tool_execution_update'
  toolCallId: string
  toolName: string
  args: any
  partialResult: any
} | {
  type: 'tool_execution_end'
  toolCallId: string
  toolName: string
  result: any
  isError: boolean
}
