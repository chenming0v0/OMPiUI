import assert from 'node:assert/strict'
import { AsyncLocalStorage } from 'node:async_hooks'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'
import { SUBAGENT_OBSERVATION_PREFIX, type SubagentObservationPayload } from './native-subagent-observation.js'
import { runtimeBridgeExtension } from './runtime-bridge.js'
import { nativeSessionTitleSource } from './native-session-title.js'

type Activity = 'running' | 'idle'
class PublicSession {
  readonly callbacks = new Set<(activity: Activity) => void>()
  readonly staleCallbacks: Array<(activity: Activity) => void> = []
  subscriptions = 0
  unsubscriptions = 0
  pending = false
  isStreaming = false
  readonly sessionManager = {
    getSessionId: () => this.id,
    getSessionFile: () => this.file,
    getLeafId: () => 'leaf',
    getCwd: () => '/workspace',
  }
  constructor(public id: string, public file: string | null = `${id}.jsonl`) {}
  hasPendingAsyncWork() { return this.pending }
  subscribeRunState(callback: (activity: Activity) => void) {
    this.subscriptions++
    this.callbacks.add(callback)
    this.staleCallbacks.push(callback)
    return () => { this.unsubscriptions++; this.callbacks.delete(callback) }
  }
  emit(activity: Activity) {
    this.isStreaming = activity === 'running'
    for (const callback of this.callbacks) callback(activity)
  }
  // Observing must never replay transcript/event history or touch the driver.
  get agent(): never { throw new Error('native agent access is forbidden') }
  subscribe(): never { throw new Error('event/transcript replay is forbidden') }
  settleAsyncWork(): never { throw new Error('async mutation is forbidden') }
  prompt(): never { throw new Error('prompting is forbidden') }
  dispose(): never { throw new Error('native disposal is forbidden') }
  async refreshSkillsAndCommands() {}
}
interface PublicRef {
  id: string
  kind: 'main' | 'sub' | 'advisor'
  parentId?: string
  session: PublicSession | null
  sessionFile: string | null
  status: string
}
class PublicRegistry {
  readonly refs = new Map<string, PublicRef>()
  readonly listeners = new Set<() => void>()
  readonly staleListeners: Array<() => void> = []
  list() { return [...this.refs.values()] }
  onChange(callback: () => void) {
    this.listeners.add(callback)
    this.staleListeners.push(callback)
    return () => { this.listeners.delete(callback) }
  }
  add(id: string, kind: PublicRef['kind'], parentId?: string, session: PublicSession | null = new PublicSession(id), silent = false) {
    const ref = { id, kind, parentId, session, sessionFile: session?.file ?? `${id}.jsonl`, status: 'running' }
    this.refs.set(id, ref)
    if (!silent) this.emit()
    return ref
  }
  emit() { for (const callback of this.listeners) callback() }
  remove(id: string, silent = false) { this.refs.delete(id); if (!silent) this.emit() }
}

function observationHarness() {
  const registry = new PublicRegistry()
  let currentRegistry = registry
  const rootSession = new PublicSession('root-session', 'root.jsonl')
  // Registry ids are not necessarily native session ids.
  const root = registry.add('root-ref', 'main', undefined, rootSession)
  const events = new Map<string, Array<(event: unknown, ctx: unknown) => void>>()
  const timers = new Map<number, { callback: () => void, ms: number }>()
  const staleTimers: Array<() => void> = []
  const notifications: Array<{ message: string, level: string }> = []
  let timerId = 0
  let uuid = 0
  let handler!: (text: string, ctx: unknown) => Promise<void>
  const ctx = {
    sessionManager: rootSession.sessionManager,
    setInterval(callback: () => void, ms: number) {
      const id = ++timerId
      timers.set(id, { callback, ms })
      staleTimers.push(callback)
      return id
    },
    clearTimer(id: number) { timers.delete(id) },
    setTimeout(callback: () => Promise<void>) { void callback() },
    ui: { notify(message: string, level: string) { notifications.push({ message, level }) } },
  }
  const pi = {
    pi: { AgentRegistry: { global: () => currentRegistry } },
    registerCommand(_name: string, spec: { handler: typeof handler }) { handler = spec.handler },
    on(name: string, callback: (event: unknown, ctx: unknown) => void) {
      const handlers = events.get(name) ?? []
      handlers.push(callback)
      events.set(name, handlers)
    },
  }
  const source = runtimeBridgeExtension()
    .replace(nativeSessionTitleSource, '')
    .replace(/^import[^\n]+\n/gm, '')
    .replace('export default function (pi)', 'function extension(pi)') + '\nextension'
  const globals = {
    randomUUID: () => `local-${++uuid}`, AsyncLocalStorage, Buffer,
    isUserQueuedMessage: () => false, isHiddenUserCompanion: () => false,
    toRestoredQueuedMessage: (value: unknown) => value,
    cfgDisabledExtensions: { get: () => [] },
  }
  let extension = runInNewContext(source, globals) as (value: typeof pi) => void
  extension(pi)
  return {
    registry, root, rootSession, ctx, timers, staleTimers, notifications,
    setRegistry(value: PublicRegistry) { currentRegistry = value },
    replaceExtension() {
      extension = runInNewContext(`(() => { ${source}\nreturn extension; })()`, globals) as (value: typeof pi) => void
      extension(pi)
    },
    bindInherited(session: PublicSession) {
      const inheritedEvents = new Map<string, (event: unknown, ctx: unknown) => void>()
      const inheritedNotifications: string[] = []
      const inheritedTimers = new Set<() => void>()
      const inheritedCtx = {
        sessionManager: session.sessionManager,
        setInterval(callback: () => void) { inheritedTimers.add(callback); return callback },
        clearTimer(callback: () => void) { inheritedTimers.delete(callback) },
        ui: { notify(message: string) { inheritedNotifications.push(message) } },
      }
      extension({
        ...pi,
        registerCommand() {},
        on(name: string, callback: (event: unknown, ctx: unknown) => void) { inheritedEvents.set(name, callback) },
      })
      return {
        notifications: inheritedNotifications, timers: inheritedTimers,
        start() { inheritedEvents.get('session_start')?.({}, inheritedCtx) },
        shutdown() { inheritedEvents.get('session_shutdown')?.({}, inheritedCtx) },
      }
    },
    start() { for (const callback of events.get('session_start') ?? []) callback({}, ctx) },
    shutdown() { for (const callback of events.get('session_shutdown') ?? []) callback({}, ctx) },
    tick() { for (const { callback } of [...timers.values()]) callback() },
    observations() {
      return notifications.filter(item => item.message.startsWith(SUBAGENT_OBSERVATION_PREFIX))
        .map(item => JSON.parse(item.message.slice(SUBAGENT_OBSERVATION_PREFIX.length)) as SubagentObservationPayload)
    },
    async execute(operation: string, extraContext: Record<string, unknown> = {}) {
      const done = Promise.withResolvers<void>()
      await handler(JSON.stringify({ id: 'request', operation }), {
        ...ctx, ...extraContext,
        setTimeout(callback: () => Promise<void>) { void callback().then(done.resolve, done.reject) },
      })
      await done.promise
      const notification = notifications.findLast(item => item.message.startsWith('ompiui-runtime:'))
      assert.ok(notification)
      return JSON.parse(notification.message.slice('ompiui-runtime:'.length)) as { success: boolean, code?: string }
    },
  }
}

function sessionOf(ref: PublicRef) { assert.ok(ref.session); return ref.session }

test('automatic public observer sends small current snapshots, never history or task lifecycle replay', () => {
  const h = observationHarness()
  const child = h.registry.add('task-id', 'sub', 'root-ref', new PublicSession('child-session', 'child.jsonl'))
  sessionOf(child).isStreaming = true
  sessionOf(child).pending = true
  Object.defineProperty(child, 'lifecycle', { get() { throw new Error('task lifecycle is not activity') } })
  assert.equal(h.notifications.length, 0)
  h.start()
  const payload = h.observations()[0]!
  assert.deepEqual(payload, {
    protocolVersion: 1, rootSessionId: 'root-session', rootSessionFile: 'root.jsonl',
    id: 'task-id', sessionFile: 'child.jsonl', observationEpoch: 'local-2', observationId: 'local-3',
    activityVersion: 1, observationSequence: 1, activity: 'running', pendingAsync: true,
  })
  assert.equal(h.notifications[0]!.level, 'info')
  assert.equal(sessionOf(child).subscriptions, 1)
  assert.equal(h.timers.size, 1)
  assert.equal([...h.timers.values()][0]!.ms, 1000)
  h.start()
  h.tick()
  h.registry.emit()
  assert.equal(h.observations().length, 1, 'unchanged state is not replayed')
  assert.equal(sessionOf(child).subscriptions, 1)
  assert.equal(h.timers.size, 1)
  h.shutdown()
})

test('root lookup requires exact native id and file through ownSession; missing ownership never guesses', async () => {
  const h = observationHarness()
  h.registry.remove('root-ref')
  const sameIdWrongFile = h.registry.add('wrong-file', 'main', undefined, new PublicSession('root-session', 'elsewhere.jsonl'))
  const sameFileWrongId = h.registry.add('wrong-id', 'main', undefined, new PublicSession('another-session', 'root.jsonl'))
  h.registry.add('leak-1', 'sub', sameIdWrongFile.id)
  h.registry.add('leak-2', 'sub', sameFileWrongId.id)
  h.start()
  h.tick()
  assert.equal(h.observations().length, 0)
  assert.equal((await h.execute('identity')).code, 'CAPABILITY_DISABLED')
  h.registry.refs.set('root-ref', h.root)
  h.registry.add('owned', 'sub', 'root-ref')
  assert.deepEqual(h.observations().map(value => value.id), ['owned'])
  h.shutdown()
})

test('only kind=sub descendants of this registry root are observed, with nested and advisor isolation', () => {
  const h = observationHarness()
  const direct = h.registry.add('direct', 'sub', 'root-ref')
  const nested = h.registry.add('nested', 'sub', 'direct')
  const otherRoot = h.registry.add('other-root', 'main')
  const unrelated = h.registry.add('unrelated', 'sub', otherRoot.id)
  const advisor = h.registry.add('advisor', 'advisor', 'root-ref')
  const advisorChild = h.registry.add('advisor-child', 'sub', advisor.id)
  h.registry.add('orphan', 'sub', 'missing-parent')
  h.start()
  assert.deepEqual(h.observations().map(value => value.id), ['direct', 'nested'])
  for (const ref of [unrelated, advisor, advisorChild]) assert.equal(sessionOf(ref).subscriptions, 0)
  h.ctx.sessionManager = sessionOf(direct).sessionManager
  h.start()
  const latest = h.observations().at(-1)!
  assert.equal(latest.id, nested.id)
  assert.equal(latest.rootSessionId, sessionOf(direct).id)
  assert.equal(sessionOf(direct).callbacks.size, 0, 'a root is not observed as its own child')
  assert.equal(sessionOf(nested).callbacks.size, 1)
  h.shutdown()
})

test('inherited child factories coexist with the root observer and use only their own notification contexts', () => {
  const h = observationHarness()
  const child = sessionOf(h.registry.add('child', 'sub', 'root-ref'))
  const nested = sessionOf(h.registry.add('nested', 'sub', 'child'))
  h.start()
  const rootEpoch = h.observations()[0]!.observationEpoch
  const inherited = h.bindInherited(child)
  inherited.start()
  assert.equal(child.callbacks.size, 1, 'inherited factory must not dispose the parent observer')
  assert.equal(nested.callbacks.size, 2, 'both root and direct parent observe their own descendant')
  assert.equal(h.registry.listeners.size, 2)
  const childPayload = JSON.parse(inherited.notifications[0]!.slice(SUBAGENT_OBSERVATION_PREFIX.length)) as SubagentObservationPayload
  assert.equal(childPayload.rootSessionId, child.id)
  assert.equal(childPayload.id, 'nested')
  child.emit('running')
  assert.equal(h.observations().at(-1)!.id, 'child')
  assert.equal(h.observations().at(-1)!.observationEpoch, rootEpoch)
  nested.emit('running')
  assert.equal(h.observations().at(-1)!.rootSessionId, h.rootSession.id)
  inherited.shutdown()
  assert.equal(child.callbacks.size, 1)
  assert.equal(nested.callbacks.size, 1)
  assert.equal(h.registry.listeners.size, 1)
  assert.equal(inherited.timers.size, 0)
  const sameRoot = h.bindInherited(h.rootSession)
  sameRoot.start()
  assert.equal(h.timers.size, 0, 'same exact root replaces only its prior observer')
  assert.equal(h.registry.listeners.size, 1)
  assert.equal(child.callbacks.size, 1)
  sameRoot.shutdown()
  h.shutdown()
})

test('publication sequence is global across children, root reattach, inherited factories and source reload', () => {
  const h = observationHarness()
  const ref = h.registry.add('child', 'sub', 'root-ref')
  h.registry.add('nested', 'sub', 'child')
  const original = sessionOf(ref)
  h.start()
  assert.deepEqual(h.observations().map(value => value.observationSequence), [1, 2])
  h.tick()
  assert.deepEqual(h.observations().map(value => value.observationSequence), [1, 2], 'deduped reads do not consume publication order')
  const inherited = h.bindInherited(original)
  inherited.start()
  const inheritedPayload = JSON.parse(inherited.notifications[0]!.slice(SUBAGENT_OBSERVATION_PREFIX.length)) as SubagentObservationPayload
  assert.equal(inheritedPayload.observationSequence, 3)
  original.emit('running')
  assert.equal(h.observations().at(-1)!.observationSequence, 4)
  ref.session = new PublicSession('replacement', ref.sessionFile)
  h.tick()
  const attachment = h.observations().at(-1)!
  assert.equal(attachment.activityVersion, 1)
  assert.equal(attachment.observationSequence, 5)
  h.rootSession.file = 'reattached-root.jsonl'
  h.tick()
  assert.deepEqual(h.observations().slice(-2).map(value => value.observationSequence), [6, 7])
  const oldEpoch = h.observations().at(-1)!.observationEpoch
  h.replaceExtension()
  for (const callback of original.staleCallbacks) callback('running')
  for (const callback of h.staleTimers) callback()
  h.start()
  assert.deepEqual(h.observations().slice(-2).map(value => value.observationSequence), [8, 9])
  assert.notEqual(h.observations().at(-1)!.observationEpoch, oldEpoch)
  assert.equal(h.observations().at(-1)!.activityVersion, 1, 'per-attachment version resets but global source order does not')
  h.replaceExtension()
  h.start()
  assert.deepEqual(h.observations().slice(-2).map(value => value.observationSequence), [10, 11])
  inherited.shutdown()
  h.shutdown()
})

test('run-state callback activity is authoritative and pending async polls are deduplicated', () => {
  const h = observationHarness()
  const child = sessionOf(h.registry.add('child', 'sub', 'root-ref'))
  h.start()
  child.emit('running')
  child.pending = true
  child.emit('idle')
  // During prompt unwind isStreaming can still be true after authoritative idle.
  child.isStreaming = true
  h.tick()
  assert.deepEqual(h.observations().map(value => [value.activity, value.pendingAsync, value.activityVersion]), [
    ['idle', false, 1], ['running', false, 2], ['idle', true, 3],
  ])
  child.pending = false
  h.tick()
  const latest = h.observations().at(-1)!
  assert.equal(latest.activity, 'idle')
  assert.equal(latest.pendingAsync, false)
  assert.equal(latest.activityVersion, 4)
  assert.equal(new Set(h.observations().map(value => value.observationId)).size, 1)
  h.shutdown()
})

test('bounded read-only reconciliation catches silent attach, detach, and pending async changes', () => {
  const h = observationHarness()
  const ref = h.registry.add('parked', 'sub', 'root-ref', null)
  h.start()
  assert.equal(h.observations()[0]!.activity, 'unavailable')
  const live = new PublicSession('live-session', ref.sessionFile)
  live.isStreaming = true
  ref.session = live // Public attachSession intentionally emits no registry event.
  h.tick()
  assert.equal(live.callbacks.size, 1)
  const attachment = h.observations().at(-1)!
  assert.equal(attachment.activity, 'running')
  assert.notEqual(attachment.observationId, h.observations()[0]!.observationId)
  live.pending = true
  h.tick()
  assert.equal(h.observations().at(-1)!.pendingAsync, true)
  ref.session = null // Public detachSession also emits no registry event.
  live.staleCallbacks[0]!('idle')
  assert.equal(h.observations().at(-1)!.activity, 'running', 'stale detach callback cannot publish')
  h.tick()
  assert.equal(live.callbacks.size, 0)
  const detached = h.observations().at(-1)!
  assert.equal(detached.activity, 'unavailable')
  assert.equal(detached.pendingAsync, false)
  assert.equal(detached.removed, undefined, 'parked ref still belongs to the root')
  const count = h.observations().length
  live.staleCallbacks[0]!('running')
  h.tick()
  assert.equal(h.observations().length, count)
  h.shutdown()
})

test('replacement validates captured ref/session/file on every callback and starts fresh local generations', () => {
  const h = observationHarness()
  const originalRef = h.registry.add('child', 'sub', 'root-ref')
  const original = sessionOf(originalRef)
  h.start()
  const first = h.observations()[0]!
  const replacement = new PublicSession('replacement', 'replacement.jsonl')
  originalRef.session = replacement
  originalRef.sessionFile = replacement.file
  original.staleCallbacks[0]!('running')
  assert.equal(h.observations().length, 1)
  h.tick()
  assert.equal(original.callbacks.size, 0)
  const attached = h.observations().at(-1)!
  assert.notEqual(attached.observationId, first.observationId)
  assert.equal(attached.observationEpoch, first.observationEpoch)
  assert.equal(attached.activityVersion, 1)
  replacement.file = 'moved.jsonl'
  replacement.staleCallbacks[0]!('running')
  assert.equal(h.observations().at(-1)!.sessionFile, 'replacement.jsonl')
  h.tick()
  assert.equal(h.observations().at(-1)!.sessionFile, 'moved.jsonl')
  originalRef.sessionFile = 'new-ref-file.jsonl'
  const beforeRefFileChange = h.observations().length
  replacement.staleCallbacks.at(-1)!('running')
  assert.equal(h.observations().length, beforeRefFileChange)
  h.tick()
  const oldRefObservation = h.observations().at(-1)!
  const newRef = h.registry.add('child', 'sub', 'root-ref')
  const removal = h.observations().at(-2)!
  assert.equal(removal.removed, true)
  assert.equal(removal.activity, 'unavailable')
  assert.equal(removal.observationId, oldRefObservation.observationId)
  assert.equal(removal.activityVersion, oldRefObservation.activityVersion + 1)
  assert.equal(h.observations().at(-1)!.activityVersion, 1)
  assert.equal(sessionOf(newRef).callbacks.size, 1)
  const count = h.observations().length
  for (const callback of original.staleCallbacks) callback('running')
  for (const callback of replacement.staleCallbacks) callback('running')
  assert.equal(h.observations().length, count)
  h.shutdown()
})

test('reparent and silent removal emit unavailable removal records, never stale state', () => {
  const h = observationHarness()
  const childRef = h.registry.add('child', 'sub', 'root-ref')
  const child = sessionOf(childRef)
  const nestedRef = h.registry.add('nested', 'sub', 'child')
  const nested = sessionOf(nestedRef)
  h.start()
  childRef.parentId = 'another-root'
  child.staleCallbacks[0]!('running')
  nested.staleCallbacks[0]!('running')
  assert.equal(h.observations().length, 2)
  h.tick()
  assert.deepEqual(h.observations().slice(2).map(value => [value.id, value.activity, value.removed]), [
    ['child', 'unavailable', true], ['nested', 'unavailable', true],
  ])
  assert.equal(child.callbacks.size, 0)
  assert.equal(nested.callbacks.size, 0)
  const added = sessionOf(h.registry.add('silent-remove', 'sub', 'root-ref'))
  h.registry.remove('silent-remove', true)
  added.staleCallbacks[0]!('running')
  h.tick()
  assert.equal(h.observations().at(-1)!.removed, true)
  assert.equal(added.callbacks.size, 0)
  h.shutdown()
})

test('root identity/ref replacement invalidates callbacks and creates a new epoch without old-root traffic', () => {
  const h = observationHarness()
  const child = sessionOf(h.registry.add('child', 'sub', 'root-ref'))
  h.start()
  const old = h.observations()[0]!
  h.rootSession.file = 'new-root.jsonl'
  child.staleCallbacks[0]!('running')
  assert.equal(h.observations().length, 1)
  h.tick()
  const changed = h.observations().at(-1)!
  assert.equal(changed.rootSessionFile, 'new-root.jsonl')
  assert.notEqual(changed.observationEpoch, old.observationEpoch)
  h.registry.add('root-ref', 'main', undefined, h.rootSession)
  const latest = h.observations().at(-1)!
  assert.notEqual(latest.observationEpoch, changed.observationEpoch)
  assert.equal(child.callbacks.size, 1)
  const beforeMissingRoot = h.observations().length
  h.registry.remove('root-ref', true)
  for (const callback of child.staleCallbacks) callback('running')
  h.tick()
  assert.equal(h.observations().length, beforeMissingRoot)
  assert.equal(child.callbacks.size, 0)
  h.shutdown()
})

test('public API unavailability and nullable transcript paths are represented without native fallbacks', () => {
  const h = observationHarness()
  h.rootSession.file = null
  const child = new PublicSession('child', null)
  child.hasPendingAsyncWork = () => { throw new Error('unavailable') }
  h.registry.add('child-ref', 'sub', 'root-ref', child)
  h.start()
  assert.equal(h.observations()[0]!.rootSessionFile, null)
  assert.equal(h.observations()[0]!.sessionFile, null)
  assert.equal(h.observations()[0]!.activity, 'unavailable')
  child.hasPendingAsyncWork = () => false
  h.tick()
  assert.equal(h.observations().at(-1)!.activity, 'idle')
  h.shutdown()
})

test('shutdown and generated extension replacement dispose listeners/timer and fence every stale callback', () => {
  const h = observationHarness()
  const child = sessionOf(h.registry.add('child', 'sub', 'root-ref'))
  h.start()
  const initial = h.observations()[0]!
  h.replaceExtension()
  assert.equal(child.callbacks.size, 0)
  assert.equal(h.registry.listeners.size, 0)
  assert.equal(h.timers.size, 0)
  for (const callback of child.staleCallbacks) callback('running')
  for (const callback of h.registry.staleListeners) callback()
  for (const callback of h.staleTimers) callback()
  assert.equal(h.observations().length, 1)
  h.start()
  assert.equal(child.callbacks.size, 1)
  assert.equal(h.registry.listeners.size, 1)
  assert.equal(h.timers.size, 1)
  assert.notEqual(h.observations().at(-1)!.observationEpoch, initial.observationEpoch)
  h.shutdown()
  h.start() // Old handlers are inert even if the host invokes them late.
  for (const callback of child.staleCallbacks) callback('running')
  for (const callback of h.registry.staleListeners) callback()
  for (const callback of h.staleTimers) callback()
  assert.equal(child.callbacks.size, 0)
  assert.equal(h.registry.listeners.size, 0)
  assert.equal(h.timers.size, 0)
  assert.equal(h.observations().length, 2)
})

test('registry instance replacement discards old registry listeners and callbacks', () => {
  const h = observationHarness()
  const child = sessionOf(h.registry.add('old-child', 'sub', 'root-ref'))
  h.start()
  const next = new PublicRegistry()
  next.refs.set(h.root.id, h.root)
  const newChild = sessionOf(next.add('new-child', 'sub', 'root-ref'))
  h.setRegistry(next)
  child.staleCallbacks[0]!('running')
  h.tick()
  assert.equal(h.registry.listeners.size, 0)
  assert.equal(child.callbacks.size, 0)
  assert.equal(next.listeners.size, 1)
  assert.equal(newChild.callbacks.size, 1)
  const count = h.observations().length
  for (const callback of h.registry.staleListeners) callback()
  assert.equal(h.observations().length, count)
  h.shutdown()
})

test('existing execute reconciles without a new refresh operation; reload releases and reattaches observers', async () => {
  const h = observationHarness()
  const child = sessionOf(h.registry.add('child', 'sub', 'root-ref'))
  assert.equal((await h.execute('identity')).success, true)
  assert.equal(child.callbacks.size, 1)
  const epoch = h.observations()[0]!.observationEpoch
  const response = await h.execute('reload', {
    reload: async () => {
      assert.equal(child.callbacks.size, 0)
      assert.equal(h.registry.listeners.size, 0)
      assert.equal(h.timers.size, 0)
      child.staleCallbacks[0]!('running')
      for (const callback of h.staleTimers) callback()
      assert.equal(h.observations().length, 1)
    },
  })
  assert.equal(response.success, true)
  assert.equal(child.callbacks.size, 1)
  assert.equal(h.timers.size, 1)
  assert.notEqual(h.observations().at(-1)!.observationEpoch, epoch)
  assert.equal((await h.execute('refreshSubagents')).code, 'CAPABILITY_DISABLED')
  h.shutdown()
})
