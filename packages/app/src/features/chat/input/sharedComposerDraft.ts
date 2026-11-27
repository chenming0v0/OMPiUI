import { useEffect } from 'react'
import type { JsonObject, SharedComposerDraft } from '@ompiui/protocol'
import { registerSessionConsumer } from '../../../hooks/useGlobalEvents'
import { serverStore } from '../../../store/serverStore'
import { getSharedComposerDraft, setSharedComposerDraft } from '../../../omp/transport/index.js'
import type { Attachment } from '../../attachment'
import { getComposerDraft, getComposerEditBase, getLocalComposerEdit, hydrateComposerDraft, markComposerSynced, subscribeComposerDraft, updateComposerDraft, type ComposerDraft } from './composerDraftStore'

const SYNC_DELAY = 500
const RETRY_DELAY = 3_000
const bindings = new Map<string, { sync: DraftSync; users: number; unsubscribe: () => void }>()
const emptyAttachments: Attachment[] = []

type DraftContent = Pick<ComposerDraft, 'text' | 'attachments' | 'delivery'>

function sameDraft(a: DraftContent, b: DraftContent): boolean {
  return a.text === b.text && (a.delivery ?? 'followUp') === (b.delivery ?? 'followUp') &&
    a.attachments.length === b.attachments.length && a.attachments.every((attachment, index) => attachment === b.attachments[index])
}

class DraftSync {
  private remote?: SharedComposerDraft
  private synced?: ComposerDraft
  private observed?: ComposerDraft
  private pending?: { draft: ComposerDraft; base: SharedComposerDraft }
  private reads = false
  private timer?: ReturnType<typeof setTimeout>
  private flight?: Promise<void>
  private readonly controller = new AbortController()

  private readonly key: string
  private readonly sessionId: string

  constructor(key: string, sessionId: string) {
    this.key = key
    this.sessionId = sessionId
  }

  refresh(version?: string | null): void {
    if (version !== undefined && this.remote?.version === version && !this.flight) return
    this.reads = true
    this.schedule(0)
  }

  changed(): void {
    if (!this.remote || this.controller.signal.aborted) return
    const edit = getLocalComposerEdit(this.key)
    if (!edit || edit === this.observed) return
    this.observed = edit
    this.pending = { draft: getComposerDraft(this.key), base: this.pending?.base ?? this.remote }
    this.schedule(SYNC_DELAY)
  }

  async versionFor(draft: DraftContent): Promise<string | undefined> {
    await this.flush()
    const current = getComposerDraft(this.key)
    if (this.remote?.version === null && !this.pending && sameDraft(draft, current)) {
      this.pending = { draft: current, base: this.remote }
      await this.flush()
    }
    const remote = this.remote
    if (!this.controller.signal.aborted && remote?.version && this.synced && sameDraft(this.synced, draft)) return remote.version
  }

  close(): void {
    this.controller.abort()
    clearTimeout(this.timer)
  }

  private schedule(delay: number): void {
    if (this.controller.signal.aborted) return
    clearTimeout(this.timer)
    this.timer = setTimeout(() => { void this.flush() }, delay)
  }

  private flush(): Promise<void> {
    clearTimeout(this.timer)
    return this.flight ?? this.flushOnce()
  }

  private flushOnce(): Promise<void> {
    if (this.controller.signal.aborted) return Promise.resolve()
    const signal = this.controller.signal
    const run = async () => {
      await hydrateComposerDraft(this.key)
      signal.throwIfAborted()
      do {
        if (this.reads || !this.remote) {
          this.reads = false
          const remote = await getSharedComposerDraft(this.sessionId, signal)
          signal.throwIfAborted()
          this.receive(remote)
        }
        const edit = this.pending
        if (!edit) continue
        const { base, draft } = edit
        const attachments = draft.attachments as unknown as JsonObject[]
        const uploadedAttachments = draft.attachments === this.synced?.attachments && base.version === this.remote?.version && !this.reads
          ? undefined : attachments
        const result = await setSharedComposerDraft(this.sessionId, {
          baseVersion: base.version, text: draft.text, delivery: draft.delivery ?? 'followUp', attachments: uploadedAttachments,
        }, signal)
        signal.throwIfAborted()
        if (result.applied) {
          this.remote = { version: result.version, text: draft.text, delivery: draft.delivery ?? 'followUp', attachments }
          this.synced = draft
          markComposerSynced(this.key, result.version, draft)
          if (this.pending === edit) this.pending = undefined
          else if (this.pending?.base === base) this.pending.base = this.remote
        } else {
          // Re-read before resolving the conflict; an accepted send may have
          // cleared the base while an edit with unchanged attachments was sent.
          this.reads = true
        }
      } while (this.reads || this.pending)
    }
    const flight = run().catch(error => {
      if (!signal.aborted) {
        const code = (error as { code?: unknown } | null)?.code
        if (code === 'INVALID_REQUEST' || code === 'FILE_TOO_LARGE' || code === 'UNKNOWN_COMMAND') {
          this.pending = undefined
          return
        }
        this.reads = true
        this.schedule(RETRY_DELAY)
      }
    }).finally(() => {
      if (this.flight === flight) this.flight = undefined
    })
    this.flight = flight
    return flight
  }

  private receive(remote: SharedComposerDraft): void {
    const previous = this.remote
    this.remote = remote
    if (!previous) {
      const draft = getComposerDraft(this.key)
      const edit = getLocalComposerEdit(this.key)
      this.observed = edit
      const baseVersion = getComposerEditBase(this.key)
      if (edit && (remote.version === baseVersion ||
          (remote.version === null && baseVersion === undefined) ||
          (typeof baseVersion === 'string' && remote.clearedVersion === baseVersion))) {
        this.pending = { draft, base: { ...remote, version: baseVersion ?? null } }
        return
      }
      if (remote.version === null && !edit) {
        markComposerSynced(this.key, null)
        return
      }
    }
    if (this.pending) {
      const { base } = this.pending
      if (remote.version === base.version || (base.version !== null && remote.clearedVersion === base.version)) return
      this.pending = undefined
    }
    if (previous?.version === remote.version && getComposerDraft(this.key) === this.synced) return
    const current = getComposerDraft(this.key)
    const remoteAttachments = remote.attachments as unknown as Attachment[]
    const knownAttachments = this.synced?.attachments ?? current.attachments
    const attachments = (previous?.version === remote.version || this.synced) &&
      knownAttachments.length === remoteAttachments.length && knownAttachments.every((attachment, index) =>
        attachment.id === remoteAttachments[index]?.id && attachment.textRange?.value === remoteAttachments[index]?.textRange?.value &&
        attachment.textRange?.start === remoteAttachments[index]?.textRange?.start && attachment.textRange?.end === remoteAttachments[index]?.textRange?.end &&
        attachment.url === remoteAttachments[index]?.url)
      ? knownAttachments : remoteAttachments.length ? remoteAttachments : emptyAttachments
    updateComposerDraft(this.key, draft => ({ ...draft, text: remote.text, attachments, delivery: remote.delivery }), 'remote')
    this.synced = getComposerDraft(this.key)
    markComposerSynced(this.key, remote.version)
  }
}

export function useSharedComposerDraft(key: string, sessionId: string | null, enabled: boolean, generation: number): void {
  useEffect(() => {
    if (!enabled || !sessionId || generation !== serverStore.getActiveServerGeneration()) return
    let binding = bindings.get(key)
    if (!binding) {
      const sync = new DraftSync(key, sessionId)
      const stopChanges = subscribeComposerDraft(() => sync.changed())
      const stopReconnect = registerSessionConsumer(`draft:${key}`, sessionId, { onReconnected: () => sync.refresh() })
      const onUpdate = (event: Event) => {
        const detail = (event as CustomEvent<{ sessionId: string; version?: string | null }>).detail
        if (detail.sessionId === sessionId) sync.refresh(detail.version)
      }
      window.addEventListener('ompiui:composer-draft-updated', onUpdate)
      const stopServerChange = serverStore.onServerChange(() => sync.close())
      binding = { sync, users: 0, unsubscribe: () => {
        sync.close()
        stopServerChange()
        stopChanges()
        stopReconnect()
        window.removeEventListener('ompiui:composer-draft-updated', onUpdate)
      } }
      bindings.set(key, binding)
      sync.refresh()
    }
    binding.users++
    return () => {
      if (--binding.users) return
      binding.unsubscribe()
      bindings.delete(key)
    }
  }, [key, sessionId, enabled, generation])
}

export async function prepareSharedComposerSend(key: string, draft: DraftContent, sessionId: string) {
  const sync = bindings.get(key)?.sync
  if (sync) return sync.versionFor(draft)
  // The first send can follow home-to-session navigation before the new pane
  // mounts. Prepare its migrated draft through the same versioned path.
  const temporary = new DraftSync(key, sessionId)
  const stop = serverStore.onServerChange(() => temporary.close())
  try {
    return await temporary.versionFor(draft)
  } finally {
    stop()
    temporary.close()
  }
}

export function refreshSharedComposerDraft(key: string): void {
  bindings.get(key)?.sync.refresh()
}
