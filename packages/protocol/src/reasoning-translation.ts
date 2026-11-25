export const REASONING_TRANSLATION_CONCURRENCY = { default: 5, min: 1, max: 32 } as const
export type ReasoningTranslationPriority = 'reading' | 'visible' | 'prewarm'

export interface ReasoningTranslationIntent {
  sessionId: string
  entryId: string
  blockIndex: number
  readerId: string
  model: string
  budget: number
  priority: ReasoningTranslationPriority
  /** Each explicit expansion may start its first missing fragment above the automatic quota. */
  interactionId?: string
}

export interface ReasoningTranslationChunk {
  source: string
  translation: string
}

export interface ReasoningTranslationSnapshot {
  blockId: string
  source: string
  chunks: ReasoningTranslationChunk[]
  partial?: ReasoningTranslationChunk
  status: 'queued' | 'running' | 'complete' | 'failed'
}

export interface ReasoningTranslationConfig {
  concurrency: number
}

export interface ReasoningTranslationReading {
  sessionId: string
  readerId: string
  active: boolean
}
