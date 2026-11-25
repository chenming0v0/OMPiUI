import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import {
  REASONING_TRANSLATION_CONCURRENCY, type ReasoningTranslationChunk, type ReasoningTranslationConfig,
  type ReasoningTranslationIntent, type ReasoningTranslationPriority, type ReasoningTranslationReading,
  type ReasoningTranslationSnapshot,
} from '@ompiui/protocol'
import { streamReasoningTranslation } from '@ompiui/omp-worker'
import { ompiuiDataDir } from '../host/auth-token.ts'
import type { ReadReasoningSource, ReasoningSource, TranslationContext } from './reasoning-source.ts'

const PROMPT_VERSION = 'line-preserving-1'
const DAY = 86_400_000
const READ_LEASE_MS = 90_000
const priorityOrder: Record<ReasoningTranslationPriority, number> = { reading: 0, visible: 1, prewarm: 2 }
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const invalid = () => Object.assign(new Error('Invalid reasoning translation input'), { code: 'INVALID_REQUEST' })

export function translationIntent(body: Record<string, unknown>): ReasoningTranslationIntent {
  const string = (key: string, max = 256) => typeof body[key] === 'string' && (body[key] as string).length > 0 &&
    (body[key] as string).length <= max && !(body[key] as string).includes('\0')
  if (!string('sessionId') || !string('entryId') || !string('readerId') || !string('model', 1024) ||
    !Number.isSafeInteger(body.blockIndex) || (body.blockIndex as number) < 0 ||
    ![6144, 8192, 16384, 32768].includes(body.budget as number) ||
    !['reading', 'visible', 'prewarm'].includes(body.priority as string) ||
    (body.interactionId !== undefined && !string('interactionId')) ||
    Object.keys(body).some(key => !['sessionId', 'entryId', 'readerId', 'model', 'blockIndex', 'budget', 'priority', 'interactionId'].includes(key))) throw invalid()
  return body as unknown as ReasoningTranslationIntent
}

export function translationReading(body: Record<string, unknown>): ReasoningTranslationReading {
  if (typeof body.sessionId !== 'string' || !body.sessionId || body.sessionId.length > 256 ||
    typeof body.readerId !== 'string' || !body.readerId || body.readerId.length > 256 || typeof body.active !== 'boolean' ||
    Object.keys(body).some(key => !['sessionId', 'readerId', 'active'].includes(key))) throw invalid()
  return body as unknown as ReasoningTranslationReading
}

/** Stable suffix fragments; a committed short tail never gets rechunked when new source arrives. */
export function nextReasoningFragment(source: string, offset: number): string {
  let end = Math.min(source.length, offset + 1024)
  if (end < source.length && source.charCodeAt(end) >= 0xdc00 && source.charCodeAt(end) <= 0xdfff &&
    source.charCodeAt(end - 1) >= 0xd800 && source.charCodeAt(end - 1) <= 0xdbff) end--
  const fragment = source.slice(offset, end)
  if (Buffer.byteLength(fragment) > 4096) throw invalid()
  return fragment
}

type PersistedJob = { logicalEntryId: string; blockIndex: number; model: string; budget: number; contextHash: string; chunks: ReasoningTranslationChunk[] }
type SessionData = { version: 1; sessionId: string; createdAt: number; lastViewedAt: number; aliases: Record<string, string>; interactions: Record<string, true>; jobs: Record<string, PersistedJob> }
type Session = { data: SessionData; reads: Map<string, number>; executions: number }
type Listener = { intent: ReasoningTranslationIntent; notify(snapshot: ReasoningTranslationSnapshot): void; close(): void }
type Job = {
  key: string; session: Session; intent: ReasoningTranslationIntent; logicalEntryId: string; source: string; streaming?: boolean;
  context: TranslationContext; contextHash: string; chunks: ReasoningTranslationChunk[];
  listeners: Map<string, Listener>; grants: Set<string>; failed: boolean; sourceFailed?: boolean; refreshing?: Promise<void>;
  running?: { controller: AbortController; source: string; offset: number; contextHash: string; translation: string; prewarm: boolean; promise: Promise<void> }
}
export interface ReasoningTranslationOptions {
  directory?: string
  readSource: ReadReasoningSource
  translate?: typeof streamReasoningTranslation
  now?: () => number
  refreshMs?: number
  /** Set false for deterministic CI unit tests which call refresh/heartbeat explicitly. */
  timers?: boolean
  timeoutMs?: number
}
export interface TranslationSubscription { detach(): void }

/** One backend owns provider jobs. HTTP connections own only listeners and demand. */
export class ReasoningTranslations {
  private readonly directory: string
  private readonly now: () => number
  private readonly translate: typeof streamReasoningTranslation
  private readonly sessions = new Map<string, Session>()
  private readonly jobs = new Map<string, Job>()
  private readonly locks = new Map<string, Promise<unknown>>()
  private configLock: Promise<unknown> = Promise.resolve()
  private readonly timers: NodeJS.Timeout[] = []
  private readonly controllers = new Set<AbortController>()
  private readonly cursors = new Map<number, { session?: string; readers: Map<string, string> }>()
  private config: ReasoningTranslationConfig = { concurrency: REASONING_TRANSLATION_CONCURRENCY.default }
  private active = 0
  private prewarmActive = 0
  private disposed = false
  readonly ready: Promise<void>

  constructor(private readonly options: ReasoningTranslationOptions) {
    this.directory = options.directory ?? path.join(ompiuiDataDir(), 'reasoning-translations')
    this.now = options.now ?? Date.now
    this.translate = options.translate ?? streamReasoningTranslation
    this.ready = this.initialize()
    // Observe startup I/O failure immediately; API callers still receive the rejection.
    void this.ready.catch(() => undefined)
    if (options.timers !== false) {
      const interval = (fn: () => Promise<void>, ms: number) => {
        const timer = setInterval(() => { void this.ready.then(() => this.disposed ? undefined : fn()).catch(() => undefined) }, ms)
        timer.unref(); this.timers.push(timer)
      }
      interval(() => this.refresh(), options.refreshMs ?? 1500)
      interval(() => this.heartbeat(), 30_000)
      interval(() => this.cleanup(), DAY)
    }
  }

  private async initialize(): Promise<void> {
    await mkdir(path.join(this.directory, 'sessions'), { recursive: true })
    try {
      const config = JSON.parse(await readFile(path.join(this.directory, 'config.json'), 'utf8')) as ReasoningTranslationConfig
      this.assertConcurrency(config.concurrency); this.config = { concurrency: config.concurrency }
    } catch (error) { if (!isMissing(error)) throw error }
    await this.cleanup()
  }

  async getConfig(): Promise<ReasoningTranslationConfig> { await this.ready; return { ...this.config } }
  private assertConcurrency(value: unknown): asserts value is number {
    if (!Number.isInteger(value) || (value as number) < REASONING_TRANSLATION_CONCURRENCY.min ||
      (value as number) > REASONING_TRANSLATION_CONCURRENCY.max) throw invalid()
  }
  async setConfig(body: Record<string, unknown>): Promise<ReasoningTranslationConfig> {
    this.assertConcurrency(body.concurrency)
    if (Object.keys(body).some(key => key !== 'concurrency')) throw invalid()
    await this.ready
    const config = { concurrency: body.concurrency }
    const operation = this.configLock.catch(() => undefined).then(async () => {
      this.assertOpen()
      await this.atomic(path.join(this.directory, 'config.json'), config)
      this.config = config; this.pump()
      return { ...config }
    })
    this.configLock = operation
    return operation
  }

  async reading(value: ReasoningTranslationReading): Promise<void> {
    await this.ready
    await this.lock(value.sessionId, async () => {
      this.assertOpen()
      const session = await this.load(value.sessionId)
      if (value.active) {
        session.reads.set(value.readerId, this.now() + READ_LEASE_MS)
        session.data.lastViewedAt = this.now()
        await this.save(session)
      } else session.reads.delete(value.readerId)
    })
  }

  async heartbeat(): Promise<void> {
    await Promise.all([...this.sessions].map(([id, session]) => this.lock(id, async () => {
      if (!this.hasReading(session) || this.disposed) return
      session.data.lastViewedAt = this.now()
      await this.save(session)
    })))
  }
  private hasReading(session: Session): boolean {
    for (const [reader, expires] of session.reads) if (expires <= this.now()) session.reads.delete(reader)
    return session.reads.size > 0
  }

  async subscribe(intent: ReasoningTranslationIntent, notify: Listener['notify'], close: Listener['close'] = () => {}): Promise<TranslationSubscription> {
    await this.ready
    const listenerId = randomUUID()
    let job!: Job
    await this.lock(intent.sessionId, async () => {
      this.assertOpen()
      const session = await this.load(intent.sessionId)
      const source = await this.read(intent, session)
      this.assertOpen()
      this.mergeAliases(session, source)
      const contextHash = hash(source.context)
      const key = this.jobKey(source.logicalEntryId, intent, contextHash)
      const mapKey = `${intent.sessionId}:${key}`
      const current = this.jobs.get(mapKey) ?? [...this.jobs.values()].find(candidate => candidate.session === session &&
        (candidate.logicalEntryId === source.logicalEntryId || session.data.aliases[candidate.logicalEntryId] === source.logicalEntryId) &&
        candidate.intent.blockIndex === intent.blockIndex && candidate.intent.model === intent.model && candidate.intent.budget === intent.budget)
      job = current ?? { key, session, intent, logicalEntryId: source.logicalEntryId, source: source.source,
        context: source.context, contextHash, chunks: structuredClone(session.data.jobs[key]?.chunks ?? []),
        listeners: new Map(), grants: new Set(), failed: false }
      if (!current) this.jobs.set(mapKey, job)
      this.updateSource(job, source)
      job.listeners.set(listenerId, { intent, notify, close })
      if (job.failed) job.failed = false // An explicit new demand retries only the missing fragment.
      const nonce = intent.interactionId && intent.priority !== 'prewarm' && hash([intent.readerId, source.logicalEntryId, intent.blockIndex, intent.interactionId]);
      if (nonce && !session.data.interactions[nonce]) {
        // Joining an already executing fragment consumes the interaction as well.
        session.data.interactions[nonce] = true
        if (!job.running) job.grants.add(nonce)
      }
      await this.save(session)
      this.emit(job)
    })
    this.pump()
    let detached = false
    return { detach: () => {
      if (detached) return; detached = true
      job.listeners.delete(listenerId)
      if (!job.listeners.size) job.grants.clear()
      // Do not abort a running provider request. No future fragments are scheduled without demand.
      if (!job.listeners.size && !job.running && !job.refreshing) this.jobs.delete(`${intent.sessionId}:${job.key}`)
      this.pump()
    } }
  }

  private jobKey(logicalEntryId: string, intent: Pick<ReasoningTranslationIntent, 'blockIndex' | 'model' | 'budget'>, contextHash: string): string {
    return hash([logicalEntryId, intent.blockIndex, intent.model, intent.budget, PROMPT_VERSION, contextHash])
  }
  private mergeAliases(session: Session, source: ReasoningSource): void {
    if (source.sessionId !== session.data.sessionId) throw invalid()
    for (const [nativeId, liveId] of Object.entries(source.aliases)) {
      const old = session.data.aliases[nativeId]
      if ((!old || old === liveId) && !Object.entries(session.data.aliases).some(([id, alias]) => id !== nativeId && alias === liveId)) {
        session.data.aliases[nativeId] = liveId
        // A job first observed after native handoff may already be keyed by native ID.
        for (const [key, saved] of Object.entries(session.data.jobs)) if (saved.logicalEntryId === nativeId) {
          const migrated = this.jobKey(liveId, saved, saved.contextHash)
          if (!session.data.jobs[migrated]) session.data.jobs[migrated] = { ...saved, logicalEntryId: liveId }
          delete session.data.jobs[key]
        }
      }
    }
  }
  private updateSource(job: Job, source: ReasoningSource): void {
    const contextHash = hash(source.context)
    if (job.sourceFailed) { job.failed = false; job.sourceFailed = false }
    if (source.logicalEntryId !== job.logicalEntryId || contextHash !== job.contextHash) {
      this.jobs.delete(`${job.intent.sessionId}:${job.key}`)
      job.logicalEntryId = source.logicalEntryId
      job.contextHash = contextHash; job.context = source.context
      job.key = this.jobKey(job.logicalEntryId, job.intent, contextHash)
      job.chunks = structuredClone(job.session.data.jobs[job.key]?.chunks ?? [])
      job.failed = false
      this.jobs.set(`${job.intent.sessionId}:${job.key}`, job)
    }
    if (job.source !== source.source) job.failed = false
    job.source = source.source
    job.streaming = source.streaming === true
    let offset = 0, count = 0
    for (const chunk of job.chunks) {
      if (!chunk.source || !job.source.startsWith(chunk.source, offset)) break
      offset += chunk.source.length; count++
    }
    job.chunks.length = count
    this.record(job)
  }
  private offset(job: Job): number { return job.chunks.reduce((sum, chunk) => sum + chunk.source.length, 0) }
  private record(job: Job): void {
    job.session.data.jobs[job.key] = { logicalEntryId: job.logicalEntryId, blockIndex: job.intent.blockIndex,
      model: job.intent.model, budget: job.intent.budget, contextHash: job.contextHash, chunks: structuredClone(job.chunks) }
  }
  private snapshot(job: Job): ReasoningTranslationSnapshot {
    const running = job.running
    const validPartial = running && running.contextHash === job.contextHash && running.offset === this.offset(job) &&
      job.source.startsWith(running.source, running.offset)
    return { blockId: `${job.logicalEntryId}:${job.intent.blockIndex}`, source: job.source, chunks: structuredClone(job.chunks),
      ...(validPartial ? { partial: { source: running.source, translation: running.translation } } : {}),
      status: running ? 'running' : job.failed ? 'failed' : this.offset(job) === job.source.length ? 'complete' : 'queued' }
  }
  private emit(job: Job): void {
    const snapshot = this.snapshot(job)
    for (const [id, listener] of job.listeners) {
      try { listener.notify(snapshot) } catch { job.listeners.delete(id); try { listener.close() } catch {} }
    }
  }

  private priority(job: Job): number {
    return Math.min(...[...job.listeners.values()].map(listener => priorityOrder[listener.intent.priority]))
  }
  private pump(): void {
    if (this.disposed) return
    const eligible = () => [...this.jobs.values()].filter(job => job.listeners.size && !job.running && !job.refreshing && !job.failed && this.offset(job) < job.source.length)
    // Explicit expansion's first missing fragment bypasses the quota, once per nonce.
    for (const job of eligible()) if (job.grants.size) { job.grants.clear(); this.start(job, false) }
    while (this.active < this.config.concurrency) {
      const jobs = eligible().filter(job => (!job.streaming || job.source.length - this.offset(job) >= 1024) &&
        (this.priority(job) !== 2 || this.prewarmActive === 0))
      if (!jobs.length) break
      const level = Math.min(...jobs.map(job => this.priority(job)))
      const selected = this.fair(jobs.filter(job => this.priority(job) === level), level)
      this.start(selected, level === 2)
    }
  }
  private fair(jobs: Job[], level: number): Job {
    let cursor = this.cursors.get(level)
    if (!cursor) { cursor = { readers: new Map() }; this.cursors.set(level, cursor) }
    const sessionIds = [...new Set(jobs.map(job => job.intent.sessionId))]
    const sessionId = rotate(sessionIds, cursor.session)
    cursor.session = sessionId
    const sameSession = jobs.filter(job => job.intent.sessionId === sessionId)
    const readers = [...new Set(sameSession.flatMap(job => [...job.listeners.values()]
      .filter(listener => priorityOrder[listener.intent.priority] === level).map(listener => listener.intent.readerId)))]
    const readerId = rotate(readers, cursor.readers.get(sessionId))
    cursor.readers.set(sessionId, readerId)
    const job = sameSession.find(item => [...item.listeners.values()].some(listener => listener.intent.readerId === readerId && priorityOrder[listener.intent.priority] === level))!
    // Move serviced blocks to the end as well, so one device's long block cannot monopolize its turn.
    this.jobs.delete(`${job.intent.sessionId}:${job.key}`); this.jobs.set(`${job.intent.sessionId}:${job.key}`, job)
    return job
  }

  private start(job: Job, prewarm: boolean): void {
    const controller = new AbortController()
    const offset = this.offset(job)
    const source = nextReasoningFragment(job.source, offset)
    const running = { controller, source, offset, contextHash: job.contextHash, translation: '', prewarm, promise: Promise.resolve() }
    job.running = running; this.active++; if (prewarm) this.prewarmActive++
    job.session.executions++; this.controllers.add(controller)
    const timeout = setTimeout(() => controller.abort(), this.options.timeoutMs ?? 120_000); timeout.unref()
    running.promise = (async () => {
      try {
        await this.translate({ model: job.intent.model, text: source, budget: job.intent.budget, history: job.context }, controller.signal, async delta => {
          if (controller.signal.aborted) throw new Error('translation interrupted')
          running.translation += delta
          if (Buffer.byteLength(running.translation) > 96 * 1024) throw new Error('translation output exceeded')
          this.emit(job)
        })
        if (controller.signal.aborted || !running.translation) throw new Error('translation interrupted')
        await this.lock(job.intent.sessionId, async () => {
          if (job.contextHash !== running.contextHash || this.offset(job) !== offset || !job.source.startsWith(source, offset)) return
          job.chunks.push({ source, translation: running.translation })
          this.record(job)
          try { await this.save(job.session) } catch (error) { job.chunks.pop(); this.record(job); throw error }
        })
      } catch {
        // Failed/incomplete output stays in RAM only and is never mistaken for a committed chunk.
        job.failed = true
      } finally {
        clearTimeout(timeout); this.controllers.delete(controller)
        job.running = undefined; this.active--; if (prewarm) this.prewarmActive--
        job.session.executions--
        this.emit(job)
        if (!job.listeners.size && !job.refreshing) this.jobs.delete(`${job.intent.sessionId}:${job.key}`)
        this.pump()
      }
    })()
    this.emit(job)
  }

  private async read(intent: ReasoningTranslationIntent, session: Session): Promise<ReasoningSource> {
    const controller = new AbortController(); this.controllers.add(controller)
    const timer = setTimeout(() => controller.abort(), 30_000); timer.unref()
    try { return await this.options.readSource(intent, session.data.aliases, controller.signal) }
    finally { clearTimeout(timer); this.controllers.delete(controller) }
  }

  /** Poll only blocks with current demand; coalesce per job, never enumerate native history. */
  async refresh(): Promise<void> {
    // Different model/budget jobs for the same demanded block share one readonly source refresh.
    const sources = new Map<string, Promise<ReasoningSource>>()
    await Promise.all([...this.jobs.values()].filter(job => job.listeners.size).map(job => {
      if (job.refreshing) return job.refreshing
      const operation = this.lock(job.intent.sessionId, async () => {
        if (this.disposed || !job.listeners.size) return
        try {
          const nativeId = Object.keys(job.session.data.aliases).find(id => job.session.data.aliases[id] === job.intent.entryId) ?? job.intent.entryId
          const sourceKey = `${job.intent.sessionId}:${nativeId}:${job.intent.blockIndex}`
          let flight = sources.get(sourceKey)
          if (!flight) { flight = this.read(job.intent, job.session); sources.set(sourceKey, flight) }
          const source = await flight
          if (this.disposed) return
          this.mergeAliases(job.session, source)
          this.updateSource(job, source)
          await this.save(job.session)
        } catch { job.failed = true; job.sourceFailed = true }
        this.emit(job)
      }).finally(() => {
        job.refreshing = undefined
        if (!job.listeners.size && !job.running) this.jobs.delete(`${job.intent.sessionId}:${job.key}`)
        this.pump()
      })
      job.refreshing = operation
      return operation
    }))
  }

  /** Derived files only. Eligibility is rechecked under the same per-session write lock as commits/reads. */
  async cleanup(): Promise<void> {
    let files: string[]
    try { files = await readdir(path.join(this.directory, 'sessions')) } catch (error) { if (isMissing(error)) return; throw error }
    for (const filename of files) {
      if (!/^[a-f0-9]{64}\.json$/.test(filename)) continue
      let data: SessionData
      try { data = JSON.parse(await readFile(path.join(this.directory, 'sessions', filename), 'utf8')) as SessionData } catch { continue }
      if (data.version !== 1 || typeof data.sessionId !== 'string' || filename !== `${hash(data.sessionId)}.json`) continue
      await this.lock(data.sessionId, async () => {
        const session = await this.load(data.sessionId)
        if (Math.max(session.data.lastViewedAt, session.data.createdAt) > this.now() - 30 * DAY ||
          this.hasReading(session) || session.executions) return
        await rm(this.sessionPath(data.sessionId), { force: true })
        this.sessions.delete(data.sessionId)
        for (const [key, job] of this.jobs) if (job.session === session) {
          for (const listener of job.listeners.values()) { try { listener.close() } catch {} }
          job.listeners.clear(); job.grants.clear(); this.jobs.delete(key)
        }
      })
    }
  }

  async dispose(): Promise<void> {
    this.disposed = true
    for (const timer of this.timers) clearInterval(timer)
    for (const controller of this.controllers) controller.abort()
    for (const job of this.jobs.values()) for (const listener of job.listeners.values()) { try { listener.close() } catch {} }
    for (const job of this.jobs.values()) job.listeners.clear()
    await this.ready.catch(() => undefined)
    await Promise.all([...this.jobs.values()].map(job => job.running?.promise).filter(Boolean))
    await Promise.all([...this.locks.values()].map(operation => operation.catch(() => undefined)))
    await this.configLock.catch(() => undefined)
    this.jobs.clear(); this.sessions.clear(); this.cursors.clear()
  }
  private assertOpen(): void { if (this.disposed) throw new Error('Translation service closed') }
  private lock<T>(id: string, action: () => Promise<T>): Promise<T> {
    const operation = (this.locks.get(id) ?? Promise.resolve()).catch(() => undefined).then(action)
    this.locks.set(id, operation)
    void operation.finally(() => { if (this.locks.get(id) === operation) this.locks.delete(id) }).catch(() => undefined)
    return operation
  }
  private sessionPath(id: string): string { return path.join(this.directory, 'sessions', `${hash(id)}.json`) }
  private async load(id: string): Promise<Session> {
    const current = this.sessions.get(id); if (current) return current
    let data: SessionData
    try {
      data = JSON.parse(await readFile(this.sessionPath(id), 'utf8')) as SessionData
      if (data.version !== 1 || data.sessionId !== id || !data.jobs || !data.aliases || !data.interactions) throw new Error('Invalid translation cache')
    } catch (error) {
      if (!isMissing(error)) throw error
      data = { version: 1, sessionId: id, createdAt: this.now(), lastViewedAt: 0, aliases: {}, interactions: {}, jobs: {} }
    }
    const session: Session = { data, reads: new Map(), executions: 0 }; this.sessions.set(id, session)
    return session
  }
  private save(session: Session): Promise<void> { return this.atomic(this.sessionPath(session.data.sessionId), session.data) }
  private async atomic(filename: string, value: unknown): Promise<void> {
    const temporary = `${filename}.${randomUUID()}.tmp`
    try { await writeFile(temporary, JSON.stringify(value), { mode: 0o600 }); await rename(temporary, filename) }
    finally { await rm(temporary, { force: true }) }
  }
}
function isMissing(error: unknown): boolean { return !!error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT' }
function rotate(values: string[], previous?: string): string { return values[(values.indexOf(previous ?? '') + 1) % values.length]! }
