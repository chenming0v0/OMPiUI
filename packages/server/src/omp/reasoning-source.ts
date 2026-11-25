import { isJsonObject, type JsonObject, type ReasoningTranslationIntent } from '@ompiui/protocol'
import type { SessionHost } from './session-host.ts'

export type TranslationContext = Array<{ role: 'user' | 'assistant'; text: string }>
export interface ReasoningSource {
  sessionId: string
  entryId: string
  logicalEntryId: string
  source: string
  /** Only the original live checkpoint can establish unfinished tail thinking. */
  streaming?: boolean
  context: TranslationContext
  aliases: Record<string, string>
}
export type ReadReasoningSource = (intent: ReasoningTranslationIntent, aliases: Record<string, string>, signal: AbortSignal) => Promise<ReasoningSource>

const unavailable = () => Object.assign(new Error('Reasoning source unavailable'), { code: 'INVALID_REQUEST' })

/** Active branch only. Never opens a session or accepts source text/paths from a client. */
export function readonlyReasoningSource(host: Pick<SessionHost, 'sessionQuery'>): ReadReasoningSource {
  return async (intent, cachedAliases, signal) => {
    const query = async (type: string, params: JsonObject): Promise<JsonObject> => {
      const result = await host.sessionQuery(intent.sessionId, type, params, signal)
      if (!isJsonObject(result)) throw unavailable()
      return result
    }
    let page = await query('branch.get', { limit: 100, maxBytes: 2 * 1024 * 1024, includeLiveMessage: true })
    const header = isJsonObject(page.head) && isJsonObject(page.head.header) ? page.head.header : undefined
    if (header?.id !== intent.sessionId) throw unavailable()
    const verifiedAliases = isJsonObject(page.stableEntryIds) ? Object.fromEntries(Object.entries(page.stableEntryIds)
      .filter((pair): pair is [string, string] => typeof pair[1] === 'string')) : {}
    const aliases = { ...cachedAliases, ...verifiedAliases }
    const nativeId = Object.keys(aliases).find(id => aliases[id] === intent.entryId) ?? intent.entryId
    const logicalId = aliases[nativeId] ?? intent.entryId
    const checkpoint = isJsonObject(page.checkpoint) ? page.checkpoint : undefined
    const live = checkpoint && isJsonObject(checkpoint.liveMessage) ? checkpoint.liveMessage : undefined
    let target: JsonObject | undefined
    let preceding: JsonObject[] = []
    if (live?.id === intent.entryId && live.complete === true && isJsonObject(live.message)) {
      target = { id: live.id, type: 'message', message: live.message }
    }
    const hydrate = async (entry: JsonObject): Promise<JsonObject> => {
      if (entry.type !== 'ompiui.entry_ref') return entry
      if (typeof entry.id !== 'string') throw unavailable()
      let offset = 0, content = '', etag: string | undefined
      do {
        const chunk = await query('entry.get', { entryId: entry.id, offset, ...(etag ? { etag } : {}) })
        if (typeof chunk.content !== 'string' || chunk.offset !== offset || typeof chunk.etag !== 'string' ||
          typeof chunk.nextOffset !== 'number' || chunk.nextOffset <= offset || chunk.entryId !== entry.id) throw unavailable()
        etag = chunk.etag
        content += chunk.content
        offset = chunk.nextOffset
        if (chunk.hasMore !== true) break
      } while (true)
      const full: unknown = JSON.parse(content)
      if (!isJsonObject(full) || full.id !== entry.id) throw unavailable()
      return full
    }
    let found = Boolean(target)
    const visited = new Set<string>()
    while (true) {
      const items = Array.isArray(page.items) ? page.items.filter(isJsonObject) : []
      if (live?.id === intent.entryId && target) {
        // During the persisting checkpoint, the verified native entry may already be in the page.
        // It is the target itself, never preceding context.
        const nativeIndex = items.findIndex(item => item.id === nativeId && aliases[nativeId] === live.id)
        if (nativeIndex >= 0) preceding = [...items.slice(0, nativeIndex), ...preceding]
        else preceding = [...items, ...preceding]
      } else if (!found) {
        const index = items.findIndex(item => item.id === nativeId)
        if (index >= 0) {
          target = await hydrate(items[index]!)
          preceding = items.slice(0, index)
          found = true
        }
      } else preceding = [...items, ...preceding]
      if (found) {
        const texts: TranslationContext = []
        for (const item of [...preceding].reverse()) {
          const entry = await hydrate(item)
          const message = isJsonObject(entry.message) ? entry.message : undefined
          if (!message || (message.role !== 'user' && message.role !== 'assistant')) continue
          const text = typeof message.content === 'string' ? message.content : Array.isArray(message.content)
            ? message.content.filter(isJsonObject).filter(block => block.type === 'text' && typeof block.text === 'string').map(block => block.text).join('\n') : ''
          if (text) texts.unshift({ role: message.role, text })
          if (texts.length >= 9) break
        }
        if (texts.length >= 9 || page.hasMore !== true) {
          const message = target && isJsonObject(target.message) ? target.message : undefined
          const block = message && Array.isArray(message.content) ? message.content[intent.blockIndex] : undefined
          if (message?.role !== 'assistant' || !isJsonObject(block) || block.type !== 'thinking' || typeof block.thinking !== 'string') throw unavailable()
          const laterContent = (message.content as unknown[]).slice(intent.blockIndex + 1).some(item => {
            if (!isJsonObject(item)) return item !== null && item !== undefined
            if (item.type === 'text') return typeof item.text === 'string' && item.text.length > 0
            if (item.type === 'thinking') return typeof item.thinking === 'string' && item.thinking.length > 0
            return true
          })
          const streaming = Boolean(live && live.id === target!.id && live.phase === 'streaming' && !laterContent)
          return { sessionId: intent.sessionId, entryId: String(target!.id), logicalEntryId: logicalId,
            source: block.thinking, streaming, context: texts, aliases: verifiedAliases }
        }
      }
      if (page.hasMore !== true || typeof page.beforeCursor !== 'string' || visited.has(page.beforeCursor)) throw unavailable()
      visited.add(page.beforeCursor)
      page = await query('branch.get', { cursor: page.beforeCursor, limit: 100, maxBytes: 2 * 1024 * 1024 })
    }
  }
}
