import assert from 'node:assert/strict'
import { runInNewContext } from 'node:vm'
import { test } from 'node:test'
import { nativeSessionTitleSource, SESSION_TITLE_PREFIX } from './native-session-title.js'

function fixture(options: { enabled?: boolean; kind?: string; generator?: string; icons?: string } = {}) {
  const handlers = new Map<string, (event: any, ctx: any) => void>()
  const listeners = new Set<() => void>()
  const saved: Array<{ title: string; source: string; trigger?: string }> = []
  const notifications: string[] = []
  const calls: string[] = []
  let controller = new AbortController()
  let id = 'native-session'
  let name: string | undefined
  let revision = 0
  let titleSource: string | undefined
  const manager = {
    getSessionId: () => id, getSessionFile: () => `${id}.jsonl`, getSessionName: () => name,
    get titleRevision() { return revision }, get titleSource() { return titleSource },
    onSessionNameChanged(callback: () => void) { listeners.add(callback); return () => listeners.delete(callback) },
    async setSessionName(title: string, source: string, trigger?: string) {
      if (titleSource === 'user' && source === 'auto') return false
      name = title; titleSource = source; if (source === 'user') revision++
      saved.push({ title, source, trigger }); listeners.forEach(callback => callback()); return true
    },
  }
  const session = {
    sessionManager: manager, settings: {}, model: {}, titleSystemPrompt: undefined as string | undefined,
    get sessionName() { return name }, get titleGenerationSignal() { return controller.signal },
    agent: { state: { messages: [] as any[] } },
    async generateTitle(text: string, _prompt?: string, _signal?: AbortSignal): Promise<string | null> { calls.push('tiny'); return 'Generated title' },
    async runEphemeralTurn(_args: { promptText: string; signal: AbortSignal }) { calls.push('fork'); return { replyText: '<title>Fork title</title>' } },
  }
  const ctx = { ui: { notify(message: string) { notifications.push(message) } } }
  const globals = {
    process: { env: { OMPIUI_AUTO_TITLE_ENABLED: options.enabled === false ? '0' : '1' } },
    AbortController, AbortSignal,
    ownSession: () => session,
    pi: { getCommands: () => [{ name: 'rename' }], on: (type: string, handler: any) => handlers.set(type, handler), pi: { AgentRegistry: { global: () => ({ list: () => [{ session, kind: options.kind ?? 'main' }] }) } } },
    nstOperatorText: (message: any) => message.role === 'user' && message.attribution === 'user' ? message.content : undefined,
    nstContext: (messages: any[]) => messages.map(message => message.content ?? '').join(' '),
    nstWords: (message: any) => ['error', 'aborted'].includes(message.stopReason) ? 0 : message.content.split(/\s+/).length,
    nstGenerator: { get: () => options.generator ?? 'fork' }, nstIcons: { get: () => options.icons ?? 'boring' }, nstRefresh: { get: () => true },
    nstParseTitle: (reply: string) => reply.match(/<title>(.*?)<\/title>/)?.[1] ?? null,
    nstParseCard: () => ({ icon: '🏷️', code: 'TITLE' }), nstSplitCard: (title: string) => title.startsWith('🏷️') ? {} : undefined,
    nstFormatCard: (card: any, title: string) => `${card.icon} ${card.code}: ${title}`, nstKeepCard: (_current: string, title: string) => title,
    nstPrompt: { render: (prompt: string) => prompt },
  }
  runInNewContext(nativeSessionTitleSource, globals)
  const emit = (type: string, event: any = {}) => handlers.get(type)?.(event, ctx)
  const user = (text = 'Fix the session naming bug') => { const message = { role: 'user', attribution: 'user', content: text }; session.agent.state.messages.push(message); emit('message_end', { message }) }
  const reply = (kind = 'text_start') => emit('message_update', { assistantMessageEvent: { type: kind } })
  const settle = async () => { for (let i = 0; i < 20; i++) await Promise.resolve() }
  emit('session_start')
  return { session, manager, calls, saved, notifications, controller, listeners, emit, user, reply, settle, resume: () => { controller.abort(); controller = new AbortController() }, replace: () => { id = 'replacement'; name = undefined; titleSource = undefined } }
}

test('auto title starts at the first non-thinking reply, using the official fork and auto persistence', async () => {
  const f = fixture()
  f.user(); f.reply('thinking_start')
  assert.deepEqual(f.calls, [])
  f.reply(); f.reply('toolcall_start')
  await f.settle()
  assert.deepEqual(f.calls, ['fork'])
  assert.deepEqual(f.saved, [{ title: 'Fork title', source: 'auto', trigger: undefined }])
  assert.deepEqual(JSON.parse(f.notifications[0]!.slice(SESSION_TITLE_PREFIX.length)), { type: 'session_info_update', sessionId: 'native-session', title: 'Fork title' })
})

test('tiny setting and TITLE_SYSTEM override use the official title model instead of a fork', async () => {
  for (const override of [false, true]) {
    const f = fixture({ generator: override ? 'fork' : 'tiny' })
    if (override) f.session.titleSystemPrompt = 'Project title instructions'
    f.user(); f.reply(); await f.settle()
    assert.deepEqual(f.calls, ['tiny'])
    assert.equal(f.saved[0]?.source, 'auto')
  }
})

test('failed fork falls back to the official title model and adds the configured card', async () => {
  const f = fixture({ icons: 'emoji' })
  f.session.runEphemeralTurn = async () => { f.calls.push('fork'); throw new Error('fork failed') }
  f.user(); f.reply(); await f.settle()
  assert.deepEqual(f.calls, ['fork', 'tiny', 'tiny'])
  assert.equal(f.saved[0]?.title, '🏷️ TITLE: Generated title')
})

test('greetings, local commands, passive session starts, disabled titles and subagents do not generate titles', async () => {
  for (const options of [{}, { enabled: false }, { kind: 'sub' }]) {
    const f = fixture(options)
    for (const text of options.enabled === false || options.kind === 'sub' ? ['Fix title'] : ['hi', '/rename', '123']) { f.user(text); f.reply() }
    await f.settle()
    assert.deepEqual(f.calls, [])
    assert.deepEqual(f.saved, [])
  }
})

test('manual name and session replacement discard a late automatic result', async () => {
  for (const change of ['rename', 'replace', 'abort', 'shutdown']) {
    const f = fixture({ generator: 'tiny' })
    const pending = Promise.withResolvers<string | null>()
    f.session.generateTitle = () => pending.promise
    f.user(); f.reply()
    if (change === 'rename') await f.manager.setSessionName('User title', 'user')
    else if (change === 'replace') f.replace()
    else if (change === 'abort') f.controller.abort()
    else f.emit('session_shutdown')
    pending.resolve('Late title'); await f.settle()
    assert.equal(f.saved.some(record => record.source === 'auto'), false)
  }
})

test('declined title retries once from conversation only after enough assistant context', async () => {
  const f = fixture({ generator: 'tiny' })
  f.session.generateTitle = async () => { f.calls.push('tiny'); return null }
  f.user(); f.reply(); await f.settle()
  const message = { role: 'assistant', content: Array(40).fill('context').join(' '), stopReason: 'stop' }
  f.session.agent.state.messages.push(message)
  f.emit('message_end', { message }); await f.settle()
  f.emit('message_end', { message }); await f.settle()
  assert.deepEqual(f.calls, ['tiny', 'tiny'])
})

test('attachment-only requests wait for assistant context when using the text-only title model', async () => {
  const f = fixture({ generator: 'tiny' })
  f.user('fix [Image #1]'); f.reply(); await f.settle()
  assert.deepEqual(f.calls, [])
  const message = { role: 'assistant', content: Array(40).fill('described').join(' '), stopReason: 'stop' }
  f.session.agent.state.messages.push(message)
  f.emit('message_end', { message }); await f.settle()
  assert.deepEqual(f.calls, ['tiny'])
})

test('path-leading tasks are not mistaken for registered local commands', async () => {
  const f = fixture({ generator: 'tiny' })
  f.user('/api/login returns 500; fix the handler'); f.reply(); await f.settle()
  assert.deepEqual(f.calls, ['tiny'])
  assert.equal(f.saved[0]?.source, 'auto')
})

test('a cancelled old request does not erase the new prompt reply that began before its cleanup', async () => {
  const f = fixture({ generator: 'tiny' })
  const pending = Promise.withResolvers<string | null>()
  let calls = 0
  f.session.generateTitle = () => ++calls === 1 ? pending.promise : Promise.resolve('New prompt title')
  f.user('First task'); f.reply()
  f.resume()
  f.user('Second task'); f.reply()
  pending.resolve(null); await f.settle()
  assert.equal(calls, 2)
  assert.equal(f.saved[0]?.title, 'New prompt title')
})

test('successful todo replan refreshes generated titles but not manual titles', async () => {
  const f = fixture({ generator: 'tiny' })
  f.user(); f.reply(); await f.settle()
  f.emit('tool_result', { toolName: 'todo', input: { op: 'init' }, isError: false }); await f.settle()
  assert.equal(f.saved.at(-1)?.trigger, 'replan')
  await f.manager.setSessionName('Manual title', 'user')
  const count = f.calls.length
  f.emit('tool_result', { toolName: 'todo', input: { op: 'init' }, isError: false }); await f.settle()
  assert.equal(f.calls.length, count)
  f.emit('session_shutdown')
  assert.equal(f.listeners.size, 0)
})
