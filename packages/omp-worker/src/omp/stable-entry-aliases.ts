import { createHash } from 'node:crypto'
import { isJsonObject, type JsonObject } from '@ompiui/protocol'

/** Only native transport evidence is accepted; IDs supplied by a browser are never aliases. */
export class StableEntryAliases {
  private sessionId = ''
  private readonly aliases = new Map<string, string>()
  private readonly pending = new Map<string, { fingerprint: string; known: Set<string> }>()

  reset(sessionId: string): void {
    if (this.sessionId === sessionId) return
    this.sessionId = sessionId
    this.aliases.clear()
    this.pending.clear()
  }

  completed(sessionId: string, liveId: string, message: JsonObject, knownIds: Iterable<string>): void {
    this.reset(sessionId)
    const fingerprint = assistantFingerprint(message)
    if (!fingerprint) return
    this.pending.set(liveId, { fingerprint, known: new Set(knownIds) })
    while (this.pending.size > 64) this.pending.delete(this.pending.keys().next().value!)
  }

  observe(sessionId: string, entries: readonly JsonObject[]): void {
    this.reset(sessionId)
    for (const [liveId, pending] of this.pending) {
      const matches = entries.filter(entry => entry.type === 'message' && typeof entry.id === 'string' &&
        !pending.known.has(entry.id) && isJsonObject(entry.message) &&
        assistantFingerprint(entry.message) === pending.fingerprint)
      if (matches.length !== 1) {
        // Ambiguity is terminal: a later refresh must not make a guess look authoritative.
        if (matches.length > 1) this.pending.delete(liveId)
        continue
      }
      const nativeId = String(matches[0]!.id)
      if (!this.aliases.has(nativeId) && ![...this.aliases.values()].includes(liveId)) this.aliases.set(nativeId, liveId)
      this.pending.delete(liveId)
      while (this.aliases.size > 512) this.aliases.delete(this.aliases.keys().next().value!)
    }
  }

  snapshot(sessionId: string): Record<string, string> {
    this.reset(sessionId)
    return Object.fromEntries(this.aliases)
  }
}

function assistantFingerprint(message: JsonObject): string | undefined {
  if (message.role !== 'assistant' || typeof message.timestamp !== 'number' || !Array.isArray(message.content)) return
  // Canonicalize object key ordering, not content order or any original values.
  return createHash('sha256').update(JSON.stringify({ timestamp: message.timestamp, content: message.content }, (_key, value: unknown) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return value
    const object = value as Record<string, unknown>
    return Object.fromEntries(Object.keys(object).sort().map(key => [key, object[key]]))
  })).digest('hex')
}
