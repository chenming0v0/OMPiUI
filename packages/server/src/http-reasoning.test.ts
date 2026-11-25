import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test, type TestContext } from 'node:test'
import { createAppServer } from './http.ts'
import { HostRuntime } from './host/command-table.ts'
import { TERMINAL_SECRET_HEADER, terminalOwnerFromSecret } from './host/terminal-auth.ts'
import { ReasoningTranslations } from './omp/reasoning-translations.ts'

async function fixture(t: TestContext) {
  const directory = await mkdtemp(path.join(tmpdir(), 'ompiui-reasoning-http-'))
  let sourceReads = 0, sessionReads = 0, unavailable = false
  const signals: AbortSignal[] = []
  const service = new ReasoningTranslations({ directory, timers: false,
    readSource: async value => {
      sourceReads++
      if (unavailable) throw new Error('private path/body should not escape')
      return { sessionId: value.sessionId, entryId: value.entryId, logicalEntryId: value.entryId,
        source: 'actual thinking', context: [], aliases: {} }
    },
    translate: async (_input, signal) => {
      signals.push(signal)
      await new Promise<void>((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('shutdown')), { once: true }))
    },
  })
  const app = createAppServer({ authToken: 'test-token', reasoningTranslations: service })
  Reflect.set(app.sessionHost, 'sessionQuery', async () => { sessionReads++; return { head: { header: { id: 'session' } }, items: [], hasMore: false } })
  await new Promise<void>(resolve => app.server.listen(0, '127.0.0.1', resolve))
  const address = app.server.address()
  assert.ok(address && typeof address !== 'string')
  const origin = `http://127.0.0.1:${address.port}`
  const request = (route: string, body?: unknown, headers: Record<string, string> = { authorization: 'Bearer test-token' }, signal?: AbortSignal) => fetch(`${origin}/api/v1/pi/reasoning/${route}`, {
    method: body === undefined ? 'GET' : 'POST', headers: { 'content-type': 'application/json', ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), ...(signal ? { signal } : {}),
  })
  t.after(async () => { await app.dispose(); await rm(directory, { recursive: true, force: true }) })
  return { app, origin, request, signals, unavailable() { unavailable = true }, reads() { return { sourceReads, sessionReads } } }
}
const intent = { sessionId: 'session', entryId: 'thinking-entry', blockIndex: 0, readerId: 'reader', model: 'provider/translator', budget: 8192, priority: 'reading' }

test('both HTTP host execute paths propagate only server-derived private terminal owner and permit its header', { timeout: 10_000 }, async t => {
  const f = await fixture(t)
  const execute = HostRuntime.prototype.execute
  const owners: unknown[] = []
  HostRuntime.prototype.execute = async (_name, _params, options) => { owners.push(options?.terminalOwner); return {} }
  t.after(() => { HostRuntime.prototype.execute = execute })
  const secret = 'a'.repeat(64)
  const headers = { authorization: 'Bearer test-token', [TERMINAL_SECRET_HEADER]: secret, 'content-type': 'application/json' }
  const get = await fetch(`${f.origin}/api/v1/host/commands/command-id`, { headers })
  assert.equal(get.status, 200)
  assert.ok(get.headers.get('access-control-allow-headers')?.includes(TERMINAL_SECRET_HEADER))
  const post = await fetch(`${f.origin}/api/v1/host/commands/terminals.list`, { method: 'POST', headers, body: '{}' })
  assert.equal(post.status, 200)
  assert.deepEqual(owners, [terminalOwnerFromSecret(secret), terminalOwnerFromSecret(secret)])
  assert.ok(owners.every(owner => owner !== secret))
})

test('cold provider save/delete broadcast models.updated only on success, not reads or failed writes', { timeout: 10_000 }, async t => {
  const f = await fixture(t)
  const execute = HostRuntime.prototype.execute
  let fail = false
  HostRuntime.prototype.execute = async () => { if (fail) throw Object.assign(new Error('rejected'), { code: 'INVALID_REQUEST' }); return {} }
  const events: string[] = []
  const unsubscribe = f.app.eventHub.subscribe(event => {
    if (event.channel === 'models.updated') events.push(String((event.payload as { command: string }).command))
  })
  t.after(() => { HostRuntime.prototype.execute = execute; unsubscribe() })
  const command = (name: string) => fetch(`${f.origin}/api/v1/host/commands/${name}`, {
    method: 'POST', headers: { authorization: 'Bearer test-token', 'content-type': 'application/json' }, body: '{}',
  })
  assert.equal((await command('models.providers.save')).status, 200)
  assert.equal((await command('models.providers.delete')).status, 200)
  await command('models.providers.get')
  fail = true; assert.equal((await command('models.providers.save')).status, 400)
  assert.deepEqual(events, ['models.providers.save', 'models.providers.delete'])
})

test('reasoning endpoints are behind host authentication and allowed-origin gate', { timeout: 10_000 }, async t => {
  const f = await fixture(t)
  assert.equal((await f.request('config', undefined, {})).status, 401)
  assert.equal((await f.request('translate', intent, {})).status, 401)
  assert.equal((await f.request('reading', { sessionId: 'session', readerId: 'reader', active: true }, {})).status, 401)
  const denied = await f.request('translate', intent, { authorization: 'Bearer test-token', origin: 'https://untrusted.example' })
  assert.equal(denied.status, 403)
  assert.deepEqual(f.reads(), { sourceReads: 0, sessionReads: 0 })
})

test('HTTP accepts intent-only source, rejects raw text and conceals readonly source failures', { timeout: 10_000 }, async t => {
  const f = await fixture(t)
  const invalid = await f.request('translate', { ...intent, text: 'untrusted', history: [] })
  assert.equal(invalid.status, 400); assert.deepEqual(await invalid.json(), { error: true })
  assert.equal(f.reads().sourceReads, 0)
  f.unavailable()
  const failed = await f.request('translate', intent)
  assert.equal(failed.status, 400); assert.deepEqual(await failed.json(), { error: true })
})

test('snapshot stream stays subscribed and disconnect does not cancel shared provider job', { timeout: 10_000 }, async t => {
  const f = await fixture(t)
  const controller = new AbortController()
  const first = await f.request('translate', intent, undefined, controller.signal)
  assert.equal(first.headers.get('content-type'), 'application/x-ndjson')
  const reader = first.body!.getReader()
  const chunk = await reader.read()
  const frame = JSON.parse(new TextDecoder().decode(chunk.value).split('\n')[0]!)
  assert.equal(frame.snapshot.blockId, 'thinking-entry:0')
  assert.equal(frame.snapshot.source, 'actual thinking')
  assert.ok(['queued', 'running'].includes(frame.snapshot.status))
  controller.abort()
  assert.equal(f.signals[0]!.aborted, false)
  const secondController = new AbortController()
  const second = await f.request('translate', { ...intent, readerId: 'phone' }, undefined, secondController.signal)
  await second.body!.getReader().read()
  assert.equal(f.signals.length, 1)
  secondController.abort()
  await f.app.dispose()
  assert.equal(f.signals[0]!.aborted, true, 'only owned backend shutdown cancels provider')
})

test('configuration and foreground reading endpoint use effective backend settings and readonly validation', { timeout: 10_000 }, async t => {
  const f = await fixture(t)
  assert.deepEqual(await (await f.request('config')).json(), { concurrency: 5 })
  assert.deepEqual(await (await f.request('config', { concurrency: 1 })).json(), { concurrency: 1 })
  assert.deepEqual(await (await f.request('config')).json(), { concurrency: 1 })
  assert.equal((await f.request('config', { concurrency: 33 })).status, 400)
  const active = { sessionId: 'session', readerId: 'reader', active: true }
  assert.deepEqual(await (await f.request('reading', active)).json(), { ok: true })
  assert.deepEqual(await (await f.request('reading', { ...active, active: false })).json(), { ok: true })
  assert.deepEqual(f.reads(), { sourceReads: 0, sessionReads: 1 })
})
