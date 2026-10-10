import type { Attachment } from '../../attachment'

export interface ComposerDraft {
  text: string
  attachments: Attachment[]
  ready: boolean
}

interface DraftRecord {
  text: string
  attachmentRevision: string | null
}

interface DraftEntry {
  draft: ComposerDraft
  record: DraftRecord
  persisted: boolean
  movedFrom?: string
  loading?: Promise<void>
}

const STORAGE_PREFIX = 'ompiui-composer-draft:'
const DATABASE_NAME = 'ompiui-composer-drafts'
const ATTACHMENT_STORE = 'attachments'
const entries = new Map<string, DraftEntry>()
const listeners = new Set<() => void>()
let database: Promise<IDBDatabase> | undefined

export function composerDraftKey(
  server: { id: string; url: string } | null,
  sessionId: string | null,
  directory: string,
  paneId: string,
): string {
  return JSON.stringify([server?.id ?? '', server?.url ?? '', sessionId, ...(sessionId ? [] : [directory, paneId])])
}

function entryFor(key: string): DraftEntry {
  const cached = entries.get(key)
  if (cached) return cached
  let record: DraftRecord = { text: '', attachmentRevision: null }
  let persisted = false
  try {
    const saved = localStorage.getItem(STORAGE_PREFIX + key)
    const parsed = saved ? JSON.parse(saved) as DraftRecord : null
    if (parsed && typeof parsed.text === 'string'
      && (parsed.attachmentRevision === null || typeof parsed.attachmentRevision === 'string')) {
      record = parsed
      persisted = true
    }
  } catch {
    // 损坏或不可用的浏览器存储不能阻止输入框打开。
  }
  const entry: DraftEntry = {
    record,
    persisted,
    draft: { text: record.text, attachments: [], ready: record.attachmentRevision === null },
  }
  entries.set(key, entry)
  return entry
}

function emit() {
  for (const listener of listeners) listener()
}

function openDatabase(): Promise<IDBDatabase> {
  if (!database) {
    database = new Promise((resolve, reject) => {
      const request = indexedDB.open(DATABASE_NAME, 1)
      request.onupgradeneeded = () => request.result.createObjectStore(ATTACHMENT_STORE)
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
    void database.catch(() => { database = undefined })
  }
  return database
}

async function readAttachments(key: string): Promise<{ revision: string; attachments: Attachment[] } | undefined> {
  const db = await openDatabase()
  return new Promise((resolve, reject) => {
    const request = db.transaction(ATTACHMENT_STORE).objectStore(ATTACHMENT_STORE).get(key)
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

async function writeAttachments(key: string, revision: string | null, attachments: Attachment[]): Promise<void> {
  const db = await openDatabase()
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(ATTACHMENT_STORE, 'readwrite')
    const store = transaction.objectStore(ATTACHMENT_STORE)
    if (revision) store.put({ revision, attachments }, key)
    else store.delete(key)
    transaction.oncomplete = () => resolve()
    transaction.onerror = () => reject(transaction.error)
    transaction.onabort = () => reject(transaction.error)
  })
}

export function getComposerDraft(key: string): ComposerDraft {
  return entryFor(key).draft
}

export function hasComposerDraft(key: string): boolean {
  return entryFor(key).persisted
}

export function subscribeComposerDraft(listener: () => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

export function hydrateComposerDraft(key: string): Promise<void> {
  const entry = entryFor(key)
  if (entry.loading) return entry.loading
  if (entry.draft.ready) return Promise.resolve()
  const revision = entry.record.attachmentRevision
  entry.loading = readAttachments(key).then(saved => {
    if (entry.record.attachmentRevision !== revision) return
    entry.draft = {
      ...entry.draft,
      attachments: saved?.revision === revision ? saved.attachments : [],
      ready: true,
    }
    emit()
  }).catch(error => {
    console.warn('Failed to restore composer attachments', error)
    if (entry.record.attachmentRevision !== revision) return
    entry.draft = { ...entry.draft, ready: true }
    emit()
  }).finally(() => { entry.loading = undefined })
  return entry.loading
}

export function updateComposerDraft(key: string, update: (draft: ComposerDraft) => ComposerDraft): void {
  const entry = entryFor(key)
  const previous = entry.draft
  const next = update(previous)
  if (next.text === previous.text && next.attachments === previous.attachments) return
  const attachmentsChanged = next.attachments !== previous.attachments
  const revision = attachmentsChanged
    ? (next.attachments.length ? crypto.randomUUID() : null)
    : entry.record.attachmentRevision
  entry.draft = { ...next, ready: attachmentsChanged || previous.ready }
  entry.record = { text: next.text, attachmentRevision: revision }
  entry.persisted = true
  try {
    // 文字同步落盘，不依赖网络、防抖计时器或卸载事件。
    localStorage.setItem(STORAGE_PREFIX + key, JSON.stringify(entry.record))
  } catch (error) {
    console.warn('Failed to save composer text', error)
  }
  if (attachmentsChanged && (revision || entry.loading || previous.attachments.length)) {
    void writeAttachments(key, revision, next.attachments).catch(error => {
      console.warn('Failed to save composer attachments', error)
    })
  }
  emit()
}

export function copyComposerDraft(from: string, to: string): void {
  const source = getComposerDraft(from)
  updateComposerDraft(to, () => ({ ...source, attachments: [...source.attachments] }))
}

export function moveComposerDraft(from: string, to: string): void {
  copyComposerDraft(from, to)
  entryFor(to).movedFrom = from
  updateComposerDraft(from, () => ({ text: '', attachments: [], ready: true }))
}

export function wasComposerDraftMovedFrom(key: string, source: string): boolean {
  return entryFor(key).movedFrom === source
}

export function acceptComposerDraft(key: string, submitted: Pick<ComposerDraft, 'text' | 'attachments'>): void {
  updateComposerDraft(key, current => ({
    ...current,
    text: current.text === submitted.text ? '' : current.text,
    attachments: current.attachments.filter(attachment => !submitted.attachments.some(sent => sent.id === attachment.id)),
  }))
}
