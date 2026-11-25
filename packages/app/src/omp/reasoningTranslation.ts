import { createContext, useContext, useEffect, useEffectEvent, useMemo, useState } from 'react'
import type { PiAssistantMessageItem, PiUserMessageItem } from './domain/index.js'
import { getApiBase, piFetch } from './httpClient'
import type { ReasoningTranslationBudget } from '../store/reasoningTranslationSettings'
import { buildReasoningTranslationLines, composeReasoningTranslationLines, type ReasoningTranslationChunk } from './reasoningTranslationDisplay'

export const ReasoningTranslationContext = createContext<{
  scope: string
  model: string
  budget: ReasoningTranslationBudget
  getItems: () => readonly ContextTimelineItem[]
} | null>(null)

const encoder = new TextEncoder()
export type TranslationHistoryItem = { role: 'user' | 'assistant'; text: string }
export type ContextTimelineItem = PiAssistantMessageItem | PiUserMessageItem
const MAX_HISTORY_ITEMS = 9
const decoder = new TextDecoder()
const CHUNK_UNITS = 1024
const completed = new Map<string, { source: string; chunks: ReasoningTranslationChunk[] }>()
let translationLane: Promise<unknown> = Promise.resolve()

function recentContext(items: readonly ContextTimelineItem[], entryId: string, budget: number): TranslationHistoryItem[] {
  const result: TranslationHistoryItem[] = []
  const anchor = items.findIndex(item => item.entryId === entryId)
  let remaining = Math.max(0, budget - 512)
  let userMessages = 0
  for (let index = anchor - 1; index >= 0 && remaining > 0 && result.length < MAX_HISTORY_ITEMS; index--) {
    const item = items[index]
    if (item.kind === 'user_message' && ++userMessages > 5) break
    let text = ''
    for (let i = item.blocks.length - 1; i >= 0 && text.length < remaining; i--) {
      const block = item.blocks[i]
      if (block.type === 'text') text = block.text.slice(-remaining) + (text ? `\n${text}` : '')
    }
    const bytes = encoder.encode(JSON.stringify(text))
    if (bytes.length > remaining) text = decoder.decode(encoder.encode(text).slice(-Math.floor(remaining / 6))).replace(/^\uFFFD/, '')
    if (!text.trim()) continue
    remaining -= encoder.encode(JSON.stringify(text)).length + 48
    result.unshift({ role: item.kind === 'user_message' ? 'user' : 'assistant', text })
    if (bytes.length > remaining + encoder.encode(JSON.stringify(text)).length + 48) break
  }
  return result
}
async function requestTranslation(body: { model: string; text: string; history: TranslationHistoryItem[]; budget: number }, signal: AbortSignal, onDelta: (translation: string) => void) {
  const response = await piFetch(`${getApiBase()}/api/v1/pi/reasoning/translate`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    signal, timeoutMs: 125_000, privateStream: true,
  })
  if (!response.ok || !response.body || !response.headers.get('content-type')?.startsWith('application/x-ndjson')) {
    await response.body?.cancel()
    throw new Error('Translation unavailable')
  }
  const reader = response.body.getReader()
  const utf8 = new TextDecoder()
  let pending = ''
  let translation = ''
  try {
    for (;;) {
      const { value, done } = await reader.read()
      signal.throwIfAborted()
      if (done) throw new Error('Incomplete translation stream')
      pending += utf8.decode(value, { stream: true })
      let newline: number
      while ((newline = pending.indexOf('\n')) >= 0) {
        const frame = JSON.parse(pending.slice(0, newline)) as { delta?: string; done?: boolean; error?: boolean }
        pending = pending.slice(newline + 1)
        if (frame.error) throw new Error('Translation failed')
        if (frame.done) return translation
        if (typeof frame.delta === 'string') translation += frame.delta
      }
      if (pending.length > 128 * 1024 || translation.length > 96 * 1024) throw new Error('Translation too large')
      onDelta(translation)
    }
  } finally {
    void reader.cancel().catch(() => undefined)
    reader.releaseLock()
  }
}

type Progress = { key: string; source: string; chunks: ReasoningTranslationChunk[]; failed?: boolean }
export function useReasoningTranslation(entryId: string | undefined, partKey: string, source: string, streaming: boolean, paused: boolean) {
  const context = useContext(ReasoningTranslationContext)
  const key = context && entryId ? JSON.stringify([context.scope, context.model, context.budget, partKey]) : ''
  const [progress, setProgress] = useState<Progress | null>(null)
  const [partial, setPartial] = useState<{ key: string; chunk: string; text: string } | null>(null)
  const [reveal, setReveal] = useState(() => {
    const cached = completed.get(key)
    return { key, source: cached?.source ?? '', line: cached ? cached.source.split(/\r?\n/).length - 1 : -1 }
  })
  const previous = progress?.key === key ? progress : null
  const cached = key ? completed.get(key) : undefined
  const result = previous && source.startsWith(previous.source) ? previous
    : cached && source.startsWith(cached.source) ? cached : null
  const offset = result?.source.length ?? 0
  const rest = source.slice(offset)
  let chunk = !streaming || rest.length >= CHUNK_UNITS ? rest.slice(0, CHUNK_UNITS) : ''
  if (chunk.length < rest.length) {
    // 避免拆开 UTF-16 代理对，优先在后半段已有的换行或空格处分块。
    const boundary = Math.max(chunk.lastIndexOf('\n'), chunk.lastIndexOf(' '))
    if (boundary > CHUNK_UNITS / 2) chunk = chunk.slice(0, boundary + 1)
    else chunk = chunk.replace(/[\uD800-\uDBFF]$/, '')
  }
  const enabled = Boolean(key) && !paused
  const failed = previous?.failed === true && result === previous
  const run = useEffectEvent(async (piece: string, signal: AbortSignal) => {
    if (!context || !entryId || !enabled) return
    const baseSource = source.slice(0, offset)
    const baseChunks = result?.chunks ?? []
    const requestKey = key
    const body = { model: context.model, text: piece, history: recentContext(context.getItems(), entryId, context.budget), budget: context.budget }
    const job = translationLane.then(async () => {
      if (signal.aborted) return
      try {
        const translated = piece.trim() ? await requestTranslation(body, signal, text => {
          if (!signal.aborted) setPartial({ key: requestKey, chunk: piece, text })
        }) : piece
        if (signal.aborted) return
        const next = { key: requestKey, source: baseSource + piece, chunks: [...baseChunks, { source: piece, translation: translated }] }
        setProgress(next)
        setPartial(null)
        completed.set(requestKey, next)
        if (completed.size > 64) completed.delete(completed.keys().next().value!)
      } catch {
        if (!signal.aborted) {
          setPartial(null)
          setProgress({ key: requestKey, source: baseSource, chunks: baseChunks, failed: true })
        }
      }
    })
    translationLane = job
    await job
  })
  useEffect(() => {
    if (!enabled || !chunk || failed) return
    const controller = new AbortController()
    void run(chunk, controller.signal)
    return () => controller.abort()
  }, [enabled, key, chunk, offset, failed])

  const delta = partial?.key === key && partial.chunk === chunk ? partial.text : ''
  const lines = useMemo(() => buildReasoningTranslationLines(source, [
    ...(result?.chunks ?? []), ...(delta ? [{ source: chunk, translation: delta }] : []),
  ]), [source, result?.chunks, chunk, delta])
  const revealedThroughLine = reveal.key === key && source.startsWith(reveal.source) ? reveal.line : -1
  const nextLine = lines.findIndex((line, index) => line.ready && index > revealedThroughLine)
  const revealNextLine = useEffectEvent(() => setReveal({ key, source, line: nextLine }))
  useEffect(() => {
    if (!enabled || nextLine < 0) return
    // 即使同一网络帧包含多行译文，也每帧只替换一行原文。
    const frame = requestAnimationFrame(() => revealNextLine())
    return () => cancelAnimationFrame(frame)
  }, [enabled, key, nextLine])
  return {
    available: Boolean(key),
    failed: enabled && failed,
    pending: enabled && !failed && Boolean(rest),
    text: enabled ? composeReasoningTranslationLines(lines, revealedThroughLine) : '',
  }
}
