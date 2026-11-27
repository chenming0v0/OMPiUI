import { randomUUID } from 'node:crypto'
import { jsonByteSize, type JsonObject, type SetSharedComposerDraftParams, type SharedComposerDraft } from '@ompiui/protocol'
import type { EventHub } from '../event-hub.ts'

const EMPTY: SharedComposerDraft = { version: null, text: '', attachments: [], delivery: 'followUp' }
const MAX_DRAFT_BYTES = 24 * 1024 * 1024
const MAX_TOTAL_BYTES = 128 * 1024 * 1024

/** Host-local state, independent of runtime attachment and native session files. */
export class ComposerDrafts {
  private readonly drafts = new Map<string, { draft: SharedComposerDraft; bytes: number }>()
  private bytes = 0

  constructor(private readonly hub: EventHub) {}

  read(sessionId: string): SharedComposerDraft {
    return this.drafts.get(sessionId)?.draft ?? EMPTY
  }

  write(sessionId: string, update: SetSharedComposerDraftParams): { applied: boolean; version: string | null } {
    const previous = this.read(sessionId)
    if (update.baseVersion !== previous.version &&
        !(update.attachments !== undefined && typeof update.baseVersion === 'string' && update.baseVersion === previous.clearedVersion)) {
      return { applied: false, version: previous.version }
    }
    const draft = this.save(sessionId, {
      text: update.text,
      attachments: update.attachments ?? previous.attachments,
      delivery: update.delivery,
    })
    return { applied: true, version: draft.version }
  }

  prefill(sessionId: string, command: JsonObject): void {
    if (typeof command.text !== 'string' || (command.kind !== 'set' && command.kind !== 'paste')) return
    const previous = this.read(sessionId)
    this.save(sessionId, {
      text: command.kind === 'paste' ? previous.text + command.text : command.text,
      attachments: previous.attachments.filter(attachment => !attachment.textRange),
      delivery: previous.delivery,
    })
  }

  restorePrefill(sessionId: string, text: unknown): void {
    // The regular route versions the edit as soon as the frame arrives. The
    // worker mirror is only a seed, never a replacement for a newer draft.
    if (typeof text === 'string' && this.read(sessionId).version === null)
      this.prefill(sessionId, { kind: 'set', text })
  }

  accept(sessionId: string, version: string): void {
    const previous = this.read(sessionId)
    if (previous.version !== version) return
    this.save(sessionId, { text: '', attachments: [], delivery: previous.delivery, clearedVersion: version })
  }

  remove(sessionId: string): void {
    const entry = this.drafts.get(sessionId)
    if (!entry) return
    this.bytes -= entry.bytes
    this.drafts.delete(sessionId)
    this.hub.publish({ kind: 'session', id: sessionId }, 'composerDraft.updated', { version: null })
  }

  private save(sessionId: string, content: Omit<SharedComposerDraft, 'version'>): SharedComposerDraft {
    const draft = { ...content, version: randomUUID() }
    const bytes = jsonByteSize(draft, MAX_DRAFT_BYTES) + 256
    if (bytes > MAX_DRAFT_BYTES)
      throw Object.assign(new Error('Composer draft exceeds its byte limit'), { code: 'FILE_TOO_LARGE' })
    const old = this.drafts.get(sessionId)
    this.bytes -= old?.bytes ?? 0
    this.drafts.delete(sessionId)
    while (this.bytes + bytes > MAX_TOTAL_BYTES || this.drafts.size >= 4096) {
      this.remove(this.drafts.keys().next().value!)
    }
    this.drafts.set(sessionId, { draft, bytes })
    this.bytes += bytes
    // Do not retain attachment bodies in the WebSocket replay history.
    this.hub.publish({ kind: 'session', id: sessionId }, 'composerDraft.updated', { version: draft.version })
    return draft
  }
}
