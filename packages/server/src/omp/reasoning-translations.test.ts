import assert from 'node:assert/strict'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test, type TestContext } from 'node:test'
import type { ReasoningTranslationIntent, ReasoningTranslationSnapshot } from '@ompiui/protocol'
import { nextReasoningFragment, ReasoningTranslations, translationIntent } from './reasoning-translations.ts'
import type { ReasoningSource } from './reasoning-source.ts'

type Call = { text: string; signal: AbortSignal; delta(text: string): Promise<void>; resolve(): void; reject(error: Error): void }
const intent = (entryId = 'block', patch: Partial<ReasoningTranslationIntent> = {}): ReasoningTranslationIntent => ({
  sessionId: 'session', entryId, blockIndex: 0, readerId: 'reader', model: 'provider/translator', budget: 8192, priority: 'reading', ...patch,
})

async function fixture(t: TestContext, concurrency = 5) {
  const directory = await mkdtemp(path.join(tmpdir(), 'ompiui-translations-'))
  let now = 1_800_000_000_000
  let sourceReads = 0
  const sources = new Map<string, ReasoningSource>()
  const calls: Call[] = []
  const snapshots = new Map<string, ReasoningTranslationSnapshot>()
  const waiters = new Set<() => void>()
  const wake = () => { for (const waiter of [...waiters]) waiter() }
  const wait = (predicate: () => boolean): Promise<void> => {
    if (predicate()) return Promise.resolve()
    return new Promise(resolve => { const check = () => { if (predicate()) { waiters.delete(check); resolve() } }; waiters.add(check) })
  }
  const sourceKey = (value: ReasoningTranslationIntent) => `${value.sessionId}/${value.entryId}`
  const make = () => new ReasoningTranslations({ directory, timers: false, now: () => now,
    readSource: async (value, aliases) => {
      sourceReads++
      const key = sourceKey(value)
      const mapped = Object.keys(aliases).find(id => aliases[id] === value.entryId)
      const source = sources.get(key) ?? (mapped ? sources.get(`${value.sessionId}/${mapped}`) : undefined)
      if (!source) throw new Error('not found')
      return { ...source, logicalEntryId: aliases[source.entryId] ?? source.logicalEntryId }
    },
    translate: async (input, signal, delta) => {
      await new Promise<void>((resolve, reject) => {
        calls.push({ text: input.text, signal, delta, resolve, reject })
        signal.addEventListener('abort', () => reject(new Error('shutdown')), { once: true })
        wake()
      })
    },
  })
  let service = make()
  await service.ready
  await service.setConfig({ concurrency })
  const set = (entryId: string, source: string, patch: Partial<ReasoningSource> = {}, sessionId = 'session') => {
    sources.set(`${sessionId}/${entryId}`, { sessionId, entryId, logicalEntryId: entryId, source,
      context: [{ role: 'user', text: 'preceding real user text' }], aliases: {}, ...patch })
  }
  const attach = async (value = intent()) => {
    const subscription = await service.subscribe(value, snapshot => { snapshots.set(`${value.sessionId}/${value.entryId}/${value.readerId}`, snapshot); wake() })
    return subscription
  }
  const snapshot = (value = intent()) => snapshots.get(`${value.sessionId}/${value.entryId}/${value.readerId}`)!
  const finish = async (index: number, translation = `translated:${calls[index]!.text}`) => {
    const call = calls[index]!
    // Capture the provider job promise to wait for atomic commit and scheduling, not just provider resolution.
    const jobs = Reflect.get(service, 'jobs') as Map<string, { running?: { controller: AbortController; promise: Promise<void> } }>
    const promise = [...jobs.values()].find(job => job.running?.controller.signal === call.signal)?.running?.promise
    assert.ok(promise)
    await call.delta(translation)
    call.resolve()
    await promise
  }
  const fail = async (index: number) => {
    const call = calls[index]!
    const jobs = Reflect.get(service, 'jobs') as Map<string, { running?: { controller: AbortController; promise: Promise<void> } }>
    const promise = [...jobs.values()].find(job => job.running?.controller.signal === call.signal)?.running?.promise
    call.reject(new Error('secret provider body must not escape'))
    await promise
  }
  const restart = async () => { await service.dispose(); service = make(); await service.ready }
  t.after(async () => { await service.dispose(); await rm(directory, { recursive: true, force: true }) })
  return { directory, calls, set, attach, snapshot, finish, fail, wait, restart,
    get service() { return service }, get sourceReads() { return sourceReads }, advance(ms: number) { now += ms },
    async stored() { return Promise.all((await readdir(path.join(directory, 'sessions'))).filter(file => file.endsWith('.json')).map(async file => JSON.parse(await readFile(path.join(directory, 'sessions', file), 'utf8')))) },
  }
}

test('stable UTF16 fragments fit 4KiB and never split a surrogate pair', () => {
  const source = 'a'.repeat(1023) + '😀' + '中'.repeat(1024)
  let offset = 0
  const fragments: string[] = []
  while (offset < source.length) {
    const fragment = nextReasoningFragment(source, offset)
    assert.ok(fragment.length <= 1024 && Buffer.byteLength(fragment) <= 4096)
    assert.ok(!/[\ud800-\udbff]$/.test(fragment)); fragments.push(fragment); offset += fragment.length
  }
  assert.equal(fragments.join(''), source)
})

test('intent validation rejects browser source/history/path and invalid block/model/budget', () => {
  assert.deepEqual(translationIntent({ ...intent() }), intent())
  for (const patch of [{ text: 'untrusted' }, { history: [] }, { filePath: 'official.jsonl' }, { renderKey: 'live' },
    { blockIndex: -1 }, { blockIndex: 1.1 }, { budget: 99 }, { readerId: '' }, { priority: 'all-history' }]) {
    assert.throws(() => translationIntent({ ...intent(), ...patch }), { code: 'INVALID_REQUEST' })
  }
})

test('two readers share one provider job, detach does not abort it, completed prefix survives restart', { timeout: 10_000 }, async t => {
  const f = await fixture(t)
  f.set('block', 'a'.repeat(1500))
  const a = await f.attach()
  const b = await f.attach(intent('block', { readerId: 'phone' }))
  assert.equal(f.calls.length, 1)
  await f.calls[0]!.delta('partial only')
  assert.equal(f.snapshot().partial?.translation, 'partial only')
  a.detach(); b.detach()
  assert.equal(f.calls[0]!.signal.aborted, false)
  await f.finish(0, '译一')
  assert.equal(f.calls.length, 1, 'no demand withdraws subsequent fragments')
  const stored = JSON.stringify(await f.stored())
  assert.ok(stored.includes('译一')); assert.ok(!stored.includes('"partial"'))
  await f.restart()
  await f.attach()
  assert.equal(f.calls[1]!.text, 'a'.repeat(476))
  assert.equal(f.snapshot().chunks[0]!.source.length, 1024)
  await f.finish(1)
  assert.equal(f.snapshot().status, 'complete')
})

test('automatic streaming tails buffer until 1024 units or the original block finishes', { timeout: 10_000 }, async t => {
  const f = await fixture(t, 1)
  f.set('block', 'tiny', { streaming: true })
  await f.attach(intent('block', { priority: 'visible' }))
  assert.equal(f.calls.length, 0)
  assert.equal(f.snapshot(intent('block', { priority: 'visible' })).status, 'queued')
  for (const source of ['tiny1', 'tiny12', 'tiny123']) {
    f.set('block', source, { streaming: true }); await f.service.refresh()
    assert.equal(f.calls.length, 0, 'polling tiny growth does not issue provider calls')
  }
  f.set('block', 'a'.repeat(1024) + 'tail', { streaming: true })
  await f.service.refresh(); assert.equal(f.calls.length, 1)
  assert.equal(f.calls[0]!.text, 'a'.repeat(1024))
  await f.finish(0); assert.equal(f.calls.length, 1)
  f.set('block', 'a'.repeat(1024) + 'tailgrow', { streaming: true })
  await f.service.refresh(); assert.equal(f.calls.length, 1)
  f.set('block', 'a'.repeat(1024) + 'tailgrow', { streaming: false })
  await f.service.refresh(); assert.equal(f.calls[1]!.text, 'tailgrow')
  await f.finish(1); assert.equal(f.snapshot().status, 'complete')
})

test('explicit short first fragment starts immediately; same nonce and subsequent tails remain buffered', { timeout: 10_000 }, async t => {
  const f = await fixture(t, 1)
  f.set('block', 'tiny', { streaming: true })
  const value = intent('block', { interactionId: 'expand-once' })
  await f.attach(value)
  assert.equal(f.calls[0]!.text, 'tiny')
  await f.finish(0)
  f.set('block', 'tiny' + 'short-tail', { streaming: true })
  await f.service.refresh(); await f.attach(value)
  assert.equal(f.calls.length, 1, 'reconnecting same interaction cannot overflow for another short tail')
  f.set('block', 'tiny' + 'a'.repeat(1024) + 'tail', { streaming: true })
  await f.service.refresh(); assert.equal(f.calls[1]!.text, 'a'.repeat(1024))
  await f.finish(1); assert.equal(f.calls.length, 2)
  f.set('block', 'tiny' + 'a'.repeat(1024) + 'tail', { streaming: false })
  await f.service.refresh(); assert.equal(f.calls[2]!.text, 'tail')
  await f.finish(2)
})

test('unused explicit grant can start the first short fragment after an initially empty live block grows', { timeout: 10_000 }, async t => {
  const f = await fixture(t, 1)
  f.set('block', '', { streaming: true })
  await f.attach(intent('block', { interactionId: 'expand-before-first-token' }))
  assert.equal(f.calls.length, 0)
  f.set('block', 'first', { streaming: true })
  await f.service.refresh(); assert.equal(f.calls[0]!.text, 'first')
  await f.finish(0)
  f.set('block', 'firstnext', { streaming: true })
  await f.service.refresh(); assert.equal(f.calls.length, 1)
})

test('append translates only new suffix, revision preserves unchanged committed prefix', { timeout: 10_000 }, async t => {
  const f = await fixture(t)
  f.set('block', 'a'.repeat(1024) + 'old-tail')
  await f.attach(); await f.finish(0); await f.finish(1)
  f.set('block', 'a'.repeat(1024) + 'old-tail' + 'new-tail')
  await f.service.refresh()
  assert.equal(f.calls[2]!.text, 'new-tail')
  await f.finish(2)
  f.set('block', 'a'.repeat(1024) + 'revised-tail')
  await f.service.refresh()
  assert.equal(f.snapshot().chunks.length, 1)
  assert.equal(f.calls[3]!.text, 'revised-tail')
  await f.finish(3)
  assert.equal(f.snapshot().chunks[0]!.translation, 'translated:' + 'a'.repeat(1024))
  assert.equal(f.snapshot().status, 'complete')
})

test('source revision does not cancel executing call and its stale result is discarded', { timeout: 10_000 }, async t => {
  const f = await fixture(t, 1)
  f.set('block', 'old')
  await f.attach()
  f.set('block', 'revised')
  await f.service.refresh()
  assert.equal(f.calls[0]!.signal.aborted, false)
  assert.equal(f.snapshot().partial, undefined)
  await f.finish(0)
  assert.equal(f.snapshot().chunks.length, 0)
  assert.equal(f.calls[1]!.text, 'revised')
  await f.finish(1)
})

test('quota 5 admits eight explicit first fragments immediately; later fragments respect quota', { timeout: 10_000 }, async t => {
  const f = await fixture(t, 5)
  for (let index = 0; index < 8; index++) {
    f.set(`block${index}`, 'a'.repeat(2048))
    await f.attach(intent(`block${index}`, { interactionId: `expand${index}` }))
  }
  assert.equal(f.calls.length, 8)
  for (let index = 0; index < 3; index++) { await f.finish(index); assert.equal(f.calls.length, 8) }
  await f.finish(3)
  assert.equal(f.calls.length, 9)
  assert.equal(f.calls.filter(call => call.signal.aborted).length, 0)
  await f.service.setConfig({ concurrency: 1 })
  assert.equal(f.calls.filter(call => call.signal.aborted).length, 0, 'lowering config never cancels calls')
})

test('quota 1 queues automatic work, nonce reconnect/growth cannot repeatedly overflow', { timeout: 10_000 }, async t => {
  const f = await fixture(t, 1)
  f.set('block', 'a'.repeat(2048)); f.set('other', 'other')
  const sub = await f.attach(intent('block', { interactionId: 'expansion' }))
  await f.attach(intent('other', { priority: 'visible' }))
  assert.equal(f.calls.length, 1)
  sub.detach()
  await f.attach(intent('block', { interactionId: 'expansion' }))
  await f.finish(0)
  assert.equal(f.calls.length, 2)
  assert.equal(f.calls[1]!.text, 'a'.repeat(1024), 'reading outranks visible')
  await f.finish(1)
  assert.equal(f.calls[2]!.text, 'other')
  f.set('block', 'a'.repeat(2048) + 'growth')
  await f.service.refresh()
  await f.attach(intent('block', { interactionId: 'expansion', readerId: 'reader' }))
  assert.equal(f.calls.length, 3, 'same nonce cannot overflow for new suffix')
  await f.finish(2)
  assert.equal(f.calls[3]!.text, 'growth')
})

test('reading > visible > prewarm with at most one executing prewarm', { timeout: 10_000 }, async t => {
  const f = await fixture(t, 1)
  for (const entry of ['hold', 'reading', 'visible', 'prewarm1', 'prewarm2']) f.set(entry, entry)
  await f.attach(intent('hold'))
  await f.attach(intent('prewarm1', { priority: 'prewarm' }))
  await f.attach(intent('visible', { priority: 'visible' }))
  await f.attach(intent('reading', { priority: 'reading' }))
  await f.attach(intent('prewarm2', { priority: 'prewarm' }))
  await f.finish(0); assert.equal(f.calls[1]!.text, 'reading')
  await f.finish(1); assert.equal(f.calls[2]!.text, 'visible')
  await f.finish(2); assert.equal(f.calls[3]!.text, 'prewarm1')
  await f.service.setConfig({ concurrency: 5 })
  assert.equal(f.calls.length, 4, 'second prewarm cannot execute even with spare quota')
  await f.finish(3); assert.equal(f.calls[4]!.text, 'prewarm2')
})

test('demanded model jobs coalesce readonly source refresh; no demand stops polling', { timeout: 10_000 }, async t => {
  const f = await fixture(t)
  f.set('block', 'reasoning')
  const a = await f.attach()
  const b = await f.attach(intent('block', { model: 'provider/other-model' }))
  assert.equal(f.calls.length, 2)
  const reads = f.sourceReads
  await f.service.refresh()
  assert.equal(f.sourceReads, reads + 1)
  a.detach(); b.detach()
  await f.service.refresh()
  assert.equal(f.sourceReads, reads + 1, 'background translation execution does not keep source demand alive')
  assert.ok(f.calls.every(call => !call.signal.aborted))
})

test('queued priority changes take effect without canceling an executing provider call', { timeout: 10_000 }, async t => {
  const f = await fixture(t, 1)
  f.set('hold', 'hold'); f.set('queued', 'queued')
  await f.attach(intent('hold', { priority: 'visible' }))
  const prewarm = await f.attach(intent('queued', { priority: 'prewarm' }))
  prewarm.detach()
  await f.attach(intent('queued', { priority: 'reading' }))
  assert.equal(f.calls[0]!.signal.aborted, false)
  await f.finish(0)
  assert.equal(f.calls[1]!.text, 'queued')
})

test('same-priority scheduler rotates sessions then devices', { timeout: 10_000 }, async t => {
  const f = await fixture(t, 1)
  f.set('hold', 'hold'); await f.attach(intent('hold'))
  f.set('a1', 'a1'); f.set('a2', 'a2'); f.set('b1', 'b1', {}, 'B'); f.set('b2', 'b2', {}, 'B')
  await f.attach(intent('a1', { readerId: 'desktop' }))
  await f.attach(intent('a2', { readerId: 'phone' }))
  await f.attach(intent('b1', { sessionId: 'B', readerId: 'desktop' }))
  await f.attach(intent('b2', { sessionId: 'B', readerId: 'phone' }))
  await f.finish(0); assert.equal(f.calls[1]!.text, 'b1')
  await f.finish(1); assert.equal(f.calls[2]!.text, 'a1')
  await f.finish(2); assert.equal(f.calls[3]!.text, 'b2')
  await f.finish(3); assert.equal(f.calls[4]!.text, 'a2')
})

test('failed partial is not persisted; restart reuses successful prefix and interrupts unfinished output', { timeout: 10_000 }, async t => {
  const f = await fixture(t)
  f.set('block', 'a'.repeat(1500)); await f.attach(); await f.finish(0)
  await f.calls[1]!.delta('DO_NOT_PERSIST')
  await f.fail(1)
  assert.equal(f.snapshot().status, 'failed'); assert.equal(f.snapshot().partial, undefined)
  assert.ok(!JSON.stringify(await f.stored()).includes('DO_NOT_PERSIST'))
  await f.restart(); await f.attach()
  assert.equal(f.calls[2]!.text.length, 476)
  await f.calls[2]!.delta('INTERRUPTED')
  await f.restart()
  assert.equal(f.calls[2]!.signal.aborted, true)
  assert.ok(!JSON.stringify(await f.stored()).includes('INTERRUPTED'))
  await f.attach(); assert.equal(f.calls[3]!.text.length, 476)
})

test('verified native/live aliases persist and retain cache identity/context through restart', { timeout: 10_000 }, async t => {
  const f = await fixture(t)
  f.set('live', 'reasoning'); await f.attach(intent('live')); await f.finish(0)
  f.set('live', 'reasoning', { entryId: 'native', aliases: { native: 'live' }, logicalEntryId: 'live' })
  await f.service.refresh()
  f.set('native', 'reasoning', { aliases: {} })
  await f.restart(); await f.attach(intent('native'))
  assert.equal(f.calls.length, 1)
  assert.equal(f.snapshot(intent('native')).blockId, 'live:0')
  assert.equal(f.snapshot(intent('native')).status, 'complete')
})

test('changed preceding text changes context hash; unchanged actual context reuses cache', { timeout: 10_000 }, async t => {
  const f = await fixture(t)
  f.set('block', 'reasoning'); await f.attach(); await f.finish(0)
  await f.service.refresh(); assert.equal(f.calls.length, 1)
  f.set('block', 'reasoning', { context: [{ role: 'assistant', text: 'changed preceding text' }] })
  await f.service.refresh(); assert.equal(f.calls.length, 2); assert.equal(f.snapshot().chunks.length, 0)
  await f.finish(1)
})

test('TTL is renewed only by explicit active reading leases, never jobs/cache/config', { timeout: 10_000 }, async t => {
  const f = await fixture(t)
  f.set('block', 'reasoning'); const sub = await f.attach(); await f.finish(0)
  assert.equal((await f.stored())[0].lastViewedAt, 0)
  await f.service.getConfig(); await f.service.refresh(); await f.service.heartbeat()
  assert.equal((await f.stored())[0].lastViewedAt, 0)
  await f.service.reading({ sessionId: 'session', readerId: 'reader', active: true })
  const viewed = (await f.stored())[0].lastViewedAt
  f.advance(30_000); await f.service.heartbeat()
  assert.ok((await f.stored())[0].lastViewedAt > viewed)
  f.advance(120_000); await f.service.heartbeat()
  const expired = (await f.stored())[0].lastViewedAt
  assert.equal(expired, viewed + 30_000)
  sub.detach(); f.advance(31 * 86_400_000); await f.service.cleanup()
  assert.deepEqual(await f.stored(), [])
})

test('TTL skips active execution and active read lease; configuration persists and validates range', { timeout: 10_000 }, async t => {
  const f = await fixture(t)
  f.set('block', 'reasoning'); const sub = await f.attach()
  sub.detach(); f.advance(31 * 86_400_000)
  await f.service.cleanup(); assert.equal((await f.stored()).length, 1)
  await f.finish(0)
  await f.service.reading({ sessionId: 'session', readerId: 'reader', active: true })
  await f.service.cleanup(); assert.equal((await f.stored()).length, 1)
  await f.service.setConfig({ concurrency: 32 }); await f.restart()
  assert.deepEqual(await f.service.getConfig(), { concurrency: 32 })
  for (const value of [0, 33, 1.5, '5']) await assert.rejects(f.service.setConfig({ concurrency: value }), { code: 'INVALID_REQUEST' })
})
