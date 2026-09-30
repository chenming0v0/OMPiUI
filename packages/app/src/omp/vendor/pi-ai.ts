/* eslint-disable @typescript-eslint/no-explicit-any -- faithful copies of the SDK declarations */
/**
 * Vendored type definitions from `@earendil-works/pi-ai` (v0.84.2).
 *
 * The app only ever consumed the SDK's *types* (the agent runtime lives in the
 * OMP worker, not here), so the dependency was stripped and the declarations
 * the UI actually renders are kept here as the source of truth. Shapes mirror
 * the SDK declarations verbatim; if the wire format changes, update them here.
 */

// ---------------------------------------------------------------------------
// Provider / API identifiers
// ---------------------------------------------------------------------------

export type KnownApi =
  | 'openai-completions'
  | 'mistral-conversations'
  | 'openai-responses'
  | 'azure-openai-responses'
  | 'openai-codex-responses'
  | 'anthropic-messages'
  | 'bedrock-converse-stream'
  | 'google-generative-ai'
  | 'google-vertex'
  | 'pi-messages'
export type Api = KnownApi | (string & {})

export type KnownProvider =
  | 'amazon-bedrock'
  | 'ant-ling'
  | 'anthropic'
  | 'google'
  | 'google-vertex'
  | 'openai'
  | 'azure-openai-responses'
  | 'openai-codex'
  | 'radius'
  | 'nvidia'
  | 'deepseek'
  | 'github-copilot'
  | 'xai'
  | 'groq'
  | 'cerebras'
  | 'openrouter'
  | 'vercel-ai-gateway'
  | 'zai'
  | 'zai-coding-cn'
  | 'mistral'
  | 'minimax'
  | 'minimax-cn'
  | 'moonshotai'
  | 'moonshotai-cn'
  | 'huggingface'
  | 'fireworks'
  | 'together'
  | 'baseten'
  | 'opencode'
  | 'opencode-go'
  | 'kimi-coding'
  | 'cloudflare-workers-ai'
  | 'cloudflare-ai-gateway'
  | 'qwen-token-plan'
  | 'qwen-token-plan-cn'
  | 'qwen-token-plan-individual'
  | 'xiaomi'
  | 'xiaomi-token-plan-cn'
  | 'xiaomi-token-plan-ams'
  | 'xiaomi-token-plan-sgp'
export type ProviderId = KnownProvider | string

// ---------------------------------------------------------------------------
// Content blocks
// ---------------------------------------------------------------------------

export interface TextContent {
  type: 'text'
  text: string
  textSignature?: string
}

export interface ThinkingContent {
  type: 'thinking'
  thinking: string
  thinkingSignature?: string
  /** When true, the thinking content was redacted by safety filters. The opaque
   *  encrypted payload is stored in `thinkingSignature` so it can be passed back
   *  to the API for multi-turn continuity. */
  redacted?: boolean
}

export interface ImageContent {
  type: 'image'
  data: string
  mimeType: string
}

export interface ToolCall {
  type: 'toolCall'
  id: string
  name: string
  arguments: Record<string, any>
  thoughtSignature?: string
  /** OpenAI Responses namespace for calls to dynamically loaded or namespaced tools. */
  namespace?: string
}

// ---------------------------------------------------------------------------
// Usage / stop reasons
// ---------------------------------------------------------------------------

export interface Usage {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  /** Subset of `cacheWrite` written with 1h retention. Only Anthropic reports this split. */
  cacheWrite1h?: number
  /**
   * Reasoning/thinking tokens, when the provider reports them. This is a subset of
   * `output`: `output` already includes these tokens. Set to a number (possibly 0) by
   * providers that expose a reasoning breakdown; left undefined by providers that don't.
   */
  reasoning?: number
  totalTokens: number
  cost: {
    input: number
    output: number
    cacheRead: number
    cacheWrite: number
    total: number
  }
}

export type StopReason = 'pending' | 'stop' | 'length' | 'toolUse' | 'error' | 'aborted' | 'deferred'

export interface DeferredHandle {
  provider: string
  modelId: string
  api: string
  /** Provider token, such as a response id or batch id plus row id. */
  id: string
  expiresAt?: number
  pollAfterMs?: number
  /** Provider conversion data required to reconstruct the final assistant message. */
  data?: JsonValue
}

export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue }

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

export interface AssistantMessageDiagnostic {
  type: string
  timestamp: number
  error?: DiagnosticErrorInfo
  details?: Record<string, unknown>
}

export interface DiagnosticErrorInfo {
  name?: string
  message: string
  stack?: string
  code?: string | number
}

export interface UserMessage {
  role: 'user'
  content: string | (TextContent | ImageContent)[]
  timestamp: number
}

export interface AssistantMessage {
  role: 'assistant'
  content: (TextContent | ThinkingContent | ToolCall)[]
  api: Api
  provider: ProviderId
  model: string
  responseModel?: string
  responseId?: string
  diagnostics?: AssistantMessageDiagnostic[]
  usage: Usage
  stopReason: StopReason
  deferred?: DeferredHandle
  errorMessage?: string
  rawStopReason?: string
  /**
   * Provider indication of whether the model explicitly ended its turn.
   * Preserved for debugging and does not currently affect agent control flow.
   */
  endTurn?: boolean
  timestamp: number
}

export interface ToolResultMessage<TDetails = any> {
  role: 'toolResult'
  toolCallId: string
  toolName: string
  content: (TextContent | ImageContent)[]
  details?: TDetails
  /** Usage from the tool execution itself, if available. Not part of main LLM context accounting. */
  usage?: Usage
  /**
   * Names from `Context.tools` that became available after this result.
   * Providers with native deferred tool loading use this as the load point;
   * other providers ignore it and use `Context.tools` normally.
   */
  addedToolNames?: string[]
  isError: boolean
  timestamp: number
}

export type Message = UserMessage | AssistantMessage | ToolResultMessage

// ---------------------------------------------------------------------------
// Assistant stream events
// ---------------------------------------------------------------------------

/**
 * Event protocol for AssistantMessageEventStream.
 *
 * Streams should emit `start` before partial updates, then terminate with either:
 * - `done` carrying the final successful AssistantMessage, or
 * - `error` carrying the final AssistantMessage with stopReason "error" or "aborted"
 *   and errorMessage.
 */
export type AssistantMessageEvent = {
  type: 'start'
  partial: AssistantMessage
} | {
  type: 'text_start'
  contentIndex: number
  partial: AssistantMessage
} | {
  type: 'text_delta'
  contentIndex: number
  delta: string
  partial: AssistantMessage
} | {
  type: 'text_end'
  contentIndex: number
  content: string
  partial: AssistantMessage
} | {
  type: 'thinking_start'
  contentIndex: number
  partial: AssistantMessage
} | {
  type: 'thinking_delta'
  contentIndex: number
  delta: string
  partial: AssistantMessage
} | {
  type: 'thinking_end'
  contentIndex: number
  content: string
  partial: AssistantMessage
} | {
  type: 'toolcall_start'
  contentIndex: number
  partial: AssistantMessage
} | {
  type: 'toolcall_delta'
  contentIndex: number
  delta: string
  partial: AssistantMessage
} | {
  type: 'toolcall_end'
  contentIndex: number
  toolCall: ToolCall
  partial: AssistantMessage
} | {
  type: 'done'
  reason: Extract<StopReason, 'stop' | 'length' | 'toolUse' | 'deferred'>
  message: AssistantMessage
} | {
  type: 'error'
  reason: Extract<StopReason, 'aborted' | 'error'>
  error: AssistantMessage
}

// ---------------------------------------------------------------------------
// Models
// ---------------------------------------------------------------------------

/** pi thinking levels (without "off"); see `ModelThinkingLevel` for the model-facing union. */
type ThinkingLevel = 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'

export type ModelThinkingLevel = 'off' | ThinkingLevel
export type ThinkingLevelMap = Partial<Record<ModelThinkingLevel, string | null>>

export type CacheRetention = 'none' | 'short' | 'long'
export type SessionAffinityFormat = 'openai' | 'openai-nosession' | 'openrouter'
/** Top-level request field used to cap reasoning tokens on OpenAI-compatible servers. */
export type ThinkingTokenBudgetField = 'thinking_token_budget' | 'thinking_budget' | 'thinking_budget_tokens'

export type ChatTemplateKwargValue =
  | string
  | number
  | boolean
  | null
  | {
      $var: 'thinking.enabled' | 'thinking.effort' | 'thinking.budget'
      omitWhenOff?: boolean
    }

/**
 * OpenRouter provider routing preferences.
 * Controls which upstream providers OpenRouter routes requests to.
 */
export interface OpenRouterRouting {
  /** Whether to allow backup providers to serve requests. Default: true. */
  allow_fallbacks?: boolean
  /** Whether to filter providers to only those that support all parameters in the request. Default: false. */
  require_parameters?: boolean
  /** Data collection setting. "allow" (default): allow providers that may store/train on data. "deny": only use providers that don't collect user data. */
  data_collection?: 'deny' | 'allow'
  /** Whether to restrict routing to only ZDR (Zero Data Retention) endpoints. */
  zdr?: boolean
  /** Whether to restrict routing to only models that allow text distillation. */
  enforce_distillable_text?: boolean
  /** An ordered list of provider names/slugs to try in sequence, falling back to the next if unavailable. */
  order?: string[]
  /** List of provider names/slugs to exclusively allow for this request. */
  only?: string[]
  /** List of provider names/slugs to skip for this request. */
  ignore?: string[]
  /** A list of quantization levels to filter providers by (e.g., ["fp16", "bf16", "fp8", "fp6", "int8", "int4", "fp4", "fp32"]). */
  quantizations?: string[]
  /** Sorting strategy. Can be a string with sort direction (e.g., "price") or an object with `by` and optional `direction` (ascending/descending). */
  sort?: string | {
    /** The sorting metric: "price", "throughput", "latency". */
    by?: string
    /** Partitioning strategy: "model" (default) or "none". */
    partition?: string | null
  }
  /** Maximum price per million tokens (USD). */
  max_price?: {
    /** Price per million prompt tokens. */
    prompt?: number | string
    /** Price per million completion tokens. */
    completion?: number | string
    /** Price per image. */
    image?: number | string
    /** Price per audio unit. */
    audio?: number | string
    /** Price per request. */
    request?: number | string
  }
}

/**
 * Vercel AI Gateway routing preferences.
 * Controls which upstream providers the gateway routes requests to.
 */
export interface VercelGatewayRouting {
  /** List of provider slugs to exclusively use for this request (e.g., ["bedrock", "anthropic"]). */
  only?: string[]
  /** List of provider slugs to try in order (e.g., ["anthropic", "openai"]). */
  order?: string[]
}

/**
 * Compatibility settings for OpenAI-compatible completions APIs.
 * Use this to override URL-based auto-detection for custom providers.
 */
export interface OpenAICompletionsCompat {
  /** Whether the provider supports the `store` field. Default: auto-detected from URL. */
  supportsStore?: boolean
  /** Whether the provider supports the `developer` role (vs `system`). Default: auto-detected from URL. */
  supportsDeveloperRole?: boolean
  /** Whether the provider supports `reasoning_effort`. Default: auto-detected from URL. */
  supportsReasoningEffort?: boolean
  /** Whether the provider supports `stream_options: { include_usage: true }` for token usage in streaming responses. Default: true. */
  supportsUsageInStreaming?: boolean
  /** Whether streamed responses include `finish_reason`. When false, pi infers `stop` or `toolUse` when the stream ends. Default: true. */
  supportsFinishReason?: boolean
  /** Which field to use for max tokens. Default: auto-detected from URL. */
  maxTokensField?: 'max_completion_tokens' | 'max_tokens'
  /** Whether tool results require the `name` field. Default: auto-detected from URL. */
  requiresToolResultName?: boolean
  /** Whether a user message after tool results requires an assistant message in between. Default: auto-detected from URL. */
  requiresAssistantAfterToolResult?: boolean
  /** Whether thinking blocks must be converted to text blocks with <thinking> delimiters. Default: auto-detected from URL. */
  requiresThinkingAsText?: boolean
  /** Whether all replayed assistant messages must include an empty reasoning_content field when reasoning is enabled. Default: auto-detected from URL. */
  requiresReasoningContentOnAssistantMessages?: boolean
  /** Format for reasoning/thinking parameter. */
  thinkingFormat?:
    | 'openai'
    | 'openrouter'
    | 'deepseek'
    | 'together'
    | 'baseten'
    | 'zai'
    | 'qwen'
    | 'chat-template'
    | 'qwen-chat-template'
    | 'string-thinking'
    | 'ant-ling'
  /** Kwargs to send as `chat_template_kwargs` when `thinkingFormat` is `chat-template`. */
  chatTemplateKwargs?: Record<string, ChatTemplateKwargValue>
  /** Arguments to send as `chat_template_args` when `thinkingFormat` is `baseten`. */
  chatTemplateArgs?: Record<string, ChatTemplateKwargValue>
  /** OpenRouter-compatible routing preferences sent as the `provider` request field. */
  openRouterRouting?: OpenRouterRouting
  /** Vercel AI Gateway routing preferences. Only used when baseUrl points to Vercel AI Gateway. */
  vercelGatewayRouting?: VercelGatewayRouting
  /** Whether z.ai supports top-level `tool_stream: true` for streaming tool call deltas. Default: false. */
  zaiToolStream?: boolean
  /**
   * Top-level request field used to cap reasoning tokens from `thinkingBudgets`.
   */
  thinkingTokenBudgetField?: ThinkingTokenBudgetField
  /** Alias for `thinkingTokenBudgetField: "thinking_token_budget"` (vLLM). */
  supportsThinkingTokenBudget?: boolean
  /** Whether the provider supports OpenAI custom tools with Lark/regex grammar formats. Default: false. */
  supportsOpenAIGrammarTools?: boolean
  /** Whether the provider supports the `strict` field in tool definitions. Default: true. */
  supportsStrictMode?: boolean
  /** Cache control convention for prompt caching. */
  cacheControlFormat?: 'anthropic'
  /** Whether to send session-affinity data from `options.sessionId`. Default: false. */
  sendSessionAffinityHeaders?: boolean
  /** Provider-specific deferred tool serialization mode. */
  deferredToolsMode?: 'kimi'
  /** Session-affinity header format. Default: auto-detected. */
  sessionAffinityFormat?: SessionAffinityFormat
  /** Whether the provider supports long prompt cache retention. Default: true. */
  supportsLongCacheRetention?: boolean
}

/** Compatibility settings for OpenAI Responses APIs. */
export interface OpenAIResponsesCompat {
  /** Whether the provider supports the `developer` role (vs `system`). Default: true. */
  supportsDeveloperRole?: boolean
  /** Session-affinity header format. */
  sessionAffinityFormat?: SessionAffinityFormat
  /** Whether the provider supports `prompt_cache_retention: "24h"`. Default: true. */
  supportsLongCacheRetention?: boolean
  /** Whether the provider supports strict JSON-schema function tools. */
  supportsStrictMode?: boolean
  /** Whether to emit OpenAI custom tools with Lark/regex grammar formats. Default: false. */
  supportsOpenAIGrammarTools?: boolean
  /** Whether the model supports message-anchored `additional_tools` input items. Default: false. */
  supportsAdditionalTools?: boolean
  /** Whether the model supports client-executed tool search for deferred tools. Default: false. */
  supportsToolSearch?: boolean
  /** Whether the model accepts `prompt_cache_options` (OpenAI GPT-5.6+ explicit prompt caching). Default: false. */
  supportsExplicitPromptCacheMode?: boolean
}

/** Compatibility settings for Anthropic Messages-compatible APIs. */
export interface AnthropicMessagesCompat {
  /**
   * Whether the provider accepts per-tool `eager_input_streaming`.
   * Default: true.
   */
  supportsEagerToolInputStreaming?: boolean
  /** Whether the provider supports Anthropic long cache retention (`cache_control.ttl: "1h"`). Default: true. */
  supportsLongCacheRetention?: boolean
  /**
   * Whether to send the `x-session-affinity` header from `options.sessionId`
   * when caching is enabled. Default: false.
   */
  sendSessionAffinityHeaders?: boolean
  /**
   * Whether the provider supports Anthropic-style `cache_control` markers on
   * tool definitions. Default: true.
   */
  supportsCacheControlOnTools?: boolean
  /**
   * Whether the model accepts the Anthropic `temperature` request field. Default: true.
   */
  supportsTemperature?: boolean
  /**
   * Whether to force adaptive thinking (`thinking.type: "adaptive"` plus
   * `output_config.effort`) regardless of the model id. Default: false.
   */
  forceAdaptiveThinking?: boolean
  /** Whether to replay empty thinking signatures as `signature: ""` instead of converting thinking to text. Default: false. */
  allowEmptySignature?: boolean
  /** Whether the provider supports Anthropic strict tool schemas. Default: false. */
  supportsStrictTools?: boolean
  /**
   * Models Anthropic accepts in `fallbacks` for server-side refusal fallback,
   * with local pricing metadata for returned fallback responses.
   */
  allowedFallbackModels?: Array<{
    provider: ProviderId
    model: string
    cost: ModelCost
  }>
  /**
   * Whether the provider supports deferred tools loaded by `tool_reference`
   * blocks in tool results. Default: true for first-party Anthropic models.
   */
  supportsToolReferences?: boolean
}

/** Compatibility settings for Amazon Bedrock models. */
export interface BedrockCompat {
  /** Whether the model supports Bedrock strict tool schemas. Default: false. */
  supportsStrictMode?: boolean
}

export interface ModelCostRates {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
}

export interface ModelCostTier extends ModelCostRates {
  /** Use this tier for requests whose total input usage exceeds this token count. */
  inputTokensAbove: number
}

export interface ModelCost extends ModelCostRates {
  /** Request-wide pricing tiers. The highest matching input threshold applies to the full request. */
  tiers?: ModelCostTier[]
}

export interface Model<TApi extends Api> {
  id: string
  name: string
  api: TApi
  provider: ProviderId
  baseUrl: string
  reasoning: boolean
  /**
   * Maps pi thinking levels to provider/model-specific values.
   * Missing keys use provider defaults. null marks a level as unsupported.
   */
  thinkingLevelMap?: ThinkingLevelMap
  input: ('text' | 'image')[]
  cost: ModelCost
  contextWindow: number
  maxTokens: number
  /** Default sampling parameters for this model. Per-request keys override these. */
  samplingParams?: Record<string, unknown>
  headers?: Record<string, string>
  /** Compatibility overrides for OpenAI-compatible APIs. If not set, auto-detected from baseUrl. */
  compat?: TApi extends 'openai-completions'
    ? OpenAICompletionsCompat
    : TApi extends 'openai-responses' | 'azure-openai-responses' | 'openai-codex-responses'
      ? OpenAIResponsesCompat
      : TApi extends 'anthropic-messages'
        ? AnthropicMessagesCompat
        : TApi extends 'bedrock-converse-stream'
          ? BedrockCompat
          : never
}
