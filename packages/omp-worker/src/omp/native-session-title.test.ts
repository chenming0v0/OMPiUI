import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { runInNewContext } from 'node:vm'
import { test, type TestContext } from 'node:test'
import { nativeSessionTitleSource, SESSION_TITLE_FAILURE_PREFIX, SESSION_TITLE_PREFIX } from './native-session-title.js'
import { defaultTitlePrompts, getTitleSettings, setTitleSettings, titleSettingsPath } from './title-settings.js'

function titleSettingsDirectory(t: TestContext) {
  const directory = mkdtempSync(path.join(tmpdir(), 'ompiui-title-settings-'))
  const previous = process.env.OMPIUI_DATA_DIR
  process.env.OMPIUI_DATA_DIR = directory
  t.after(() => {
    if (previous === undefined) delete process.env.OMPIUI_DATA_DIR
    else process.env.OMPIUI_DATA_DIR = previous
    rmSync(directory, { recursive: true, force: true })
  })
  return titleSettingsPath()
}

function fixture(options: { enabled?: boolean; kind?: string; generator?: string; icons?: string; settingsFile?: string } = {}) {
  const handlers = new Map<string, (event: any, ctx: any) => void>()
  const listeners = new Set<() => void>()
  const saved: Array<{ title: string; source: string; trigger?: string }> = []
  const notifications: string[] = []
  const calls: string[] = []
  const prompts: Array<{ kind: string; prompt: string | undefined }> = []
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
    async generateTitle(text: string, prompt?: string, _signal?: AbortSignal): Promise<string | null> { calls.push('tiny'); prompts.push({ kind: 'tiny', prompt }); return 'Generated title' },
    async runEphemeralTurn(args: { promptText: string; signal: AbortSignal }) { calls.push('fork'); prompts.push({ kind: 'fork', prompt: args.promptText }); return { replyText: '<title>Fork title</title>' } },
  }
  const ctx = { ui: { notify(message: string) { notifications.push(message) } } }
  const globals = {
    process: { env: { OMPIUI_AUTO_TITLE_ENABLED: options.enabled === false ? '0' : '1', OMPIUI_TITLE_SETTINGS_PATH: options.settingsFile } },
    nstReadFileSync: readFileSync,
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
  return { session, manager, calls, prompts, saved, notifications, controller, listeners, emit, user, reply, settle, resume: () => { controller.abort(); controller = new AbortController() }, replace: () => { id = 'replacement'; name = undefined; titleSource = undefined } }
}

test('auto title starts at the first non-thinking reply, using the official fork and auto persistence', async () => {
  const f = fixture()
  f.user(); f.reply('thinking_start')
  assert.deepEqual(f.calls, [])
  f.reply(); f.reply('toolcall_start')
  await f.settle()
  assert.deepEqual(f.calls, ['fork'])
  assert.deepEqual(f.prompts, [{ kind: 'fork', prompt: defaultTitlePrompts.forkPrompt }])
  assert.deepEqual(f.saved, [{ title: 'Fork title', source: 'auto', trigger: undefined }])
  assert.deepEqual(JSON.parse(f.notifications[0]!.slice(SESSION_TITLE_PREFIX.length)), { type: 'session_info_update', sessionId: 'native-session', title: 'Fork title' })
})

test('tiny setting and TITLE_SYSTEM override use the official title model instead of a fork', async () => {
  for (const override of [false, true]) {
    const f = fixture({ generator: override ? 'fork' : 'tiny' })
    if (override) f.session.titleSystemPrompt = 'Project title instructions'
    f.user(); f.reply(); await f.settle()
    assert.deepEqual(f.calls, ['tiny'])
    assert.deepEqual(f.prompts, [{ kind: 'tiny', prompt: override ? undefined : defaultTitlePrompts.tinyPrompt }])
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

test('a failed generation reports the generate stage through the private diagnostic prefix', async () => {
  const f = fixture({ generator: 'tiny' })
  f.session.generateTitle = async () => { throw new Error('provider quota exhausted') }
  f.user(); f.reply(); await f.settle()
  const diagnostic = f.notifications.find(message => message.startsWith(SESSION_TITLE_FAILURE_PREFIX))
  assert.ok(diagnostic)
  assert.deepEqual(JSON.parse(diagnostic.slice(SESSION_TITLE_FAILURE_PREFIX.length)), { stage: 'generate' })
  assert.ok(f.notifications.some(message => message.startsWith('Automatic session title failed: provider quota exhausted')))
  assert.deepEqual(f.saved, [])
})

test('a failed rename reports the apply stage through the private diagnostic prefix', async () => {
  const f = fixture()
  f.manager.setSessionName = async () => { throw new Error('session file is locked') }
  f.user(); f.reply(); await f.settle()
  const diagnostic = f.notifications.find(message => message.startsWith(SESSION_TITLE_FAILURE_PREFIX))
  assert.ok(diagnostic)
  assert.deepEqual(JSON.parse(diagnostic.slice(SESSION_TITLE_FAILURE_PREFIX.length)), { stage: 'apply' })
  assert.ok(f.notifications.some(message => message.includes("session file is locked")))
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

test('declined title retries once with the latest tiny prompt only after enough assistant context', async t => {
  const file = titleSettingsDirectory(t)
  await setTitleSettings('custom fork', 'first tiny', 'custom card')
  const f = fixture({ generator: 'tiny', settingsFile: file })
  f.session.generateTitle = async (_text, prompt) => { f.calls.push('tiny'); f.prompts.push({ kind: 'tiny', prompt }); return null }
  f.user(); f.reply(); await f.settle()
  await setTitleSettings('custom fork', 'retry tiny', 'custom card')
  const message = { role: 'assistant', content: Array(40).fill('context').join(' '), stopReason: 'stop' }
  f.session.agent.state.messages.push(message)
  f.emit('message_end', { message }); await f.settle()
  f.emit('message_end', { message }); await f.settle()
  assert.deepEqual(f.calls, ['tiny', 'tiny'])
  assert.deepEqual(f.prompts, [{ kind: 'tiny', prompt: 'first tiny' }, { kind: 'tiny', prompt: 'retry tiny' }])
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

test('title settings persist verbatim outside session directories, reload without mtime caching, and reset to defaults', async t => {
  const file = titleSettingsDirectory(t)
  const defaults = getTitleSettings().defaults
  assert.deepEqual(getTitleSettings(), { ...defaultTitlePrompts, defaults: defaultTitlePrompts })
  const first = await setTitleSettings(' first fork\n', 'first tiny', 'first card')
  assert.deepEqual(first, { forkPrompt: ' first fork\n', tinyPrompt: 'first tiny', cardPrompt: 'first card', defaults })
  assert.deepEqual(getTitleSettings(), first)
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { forkPrompt: first.forkPrompt, tinyPrompt: first.tinyPrompt, cardPrompt: first.cardPrompt })
  assert.deepEqual(readdirSync(path.dirname(file)), ['title-settings.json'])
  assert.equal(existsSync(path.join(path.dirname(file), 'sessions')), false)
  const timestamp = statSync(file)
  writeFileSync(file, JSON.stringify({ forkPrompt: 'second fork', tinyPrompt: 'second tiny', cardPrompt: 'second card' }))
  utimesSync(file, timestamp.atime, timestamp.mtime)
  assert.deepEqual(getTitleSettings(), { forkPrompt: 'second fork', tinyPrompt: 'second tiny', cardPrompt: 'second card', defaults })
  await assert.rejects(setTitleSettings('valid', ' \n ', 'valid'), /tinyPrompt must be a nonempty string/)
  assert.equal(getTitleSettings().tinyPrompt, 'second tiny')
  const reset = await setTitleSettings(defaults.forkPrompt, defaults.tinyPrompt, defaults.cardPrompt)
  assert.deepEqual(reset, { ...defaults, defaults })
  assert.deepEqual(getTitleSettings(), reset)
})

test('invalid saved settings fail both reads and native generation rather than silently using defaults', async t => {
  const file = titleSettingsDirectory(t)
  for (const content of ['invalid JSON', 'null', JSON.stringify({ forkPrompt: 'missing other prompts' }), JSON.stringify({ forkPrompt: 'valid', tinyPrompt: '', cardPrompt: 'valid' })]) {
    writeFileSync(file, content)
    assert.throws(() => getTitleSettings())
    const f = fixture({ settingsFile: file })
    f.user(); f.reply(); await f.settle()
    assert.deepEqual(f.calls, [])
    assert.deepEqual(f.saved, [])
    const diagnostic = f.notifications.find(message => message.startsWith(SESSION_TITLE_FAILURE_PREFIX))
    assert.ok(diagnostic)
    assert.deepEqual(JSON.parse(diagnostic.slice(SESSION_TITLE_FAILURE_PREFIX.length)), { stage: 'generate' })
  }
  const unreadable = fixture({ settingsFile: path.dirname(file) })
  unreadable.user(); unreadable.reply(); await unreadable.settle()
  assert.deepEqual(unreadable.calls, [])
  assert.ok(unreadable.notifications.some(message => message.startsWith(SESSION_TITLE_FAILURE_PREFIX)))
})

test('a running native host uses saved fork and card prompts, and a missing file uses defaults', async t => {
  const file = titleSettingsDirectory(t)
  const missing = fixture({ generator: 'tiny', settingsFile: file })
  missing.user(); missing.reply(); await missing.settle()
  assert.deepEqual(missing.prompts, [{ kind: 'tiny', prompt: defaultTitlePrompts.tinyPrompt }])
  await setTitleSettings('custom fork', 'custom tiny', 'custom card')
  const f = fixture({ icons: 'emoji', settingsFile: file })
  f.user(); f.reply(); await f.settle()
  assert.deepEqual(f.prompts, [{ kind: 'fork', prompt: 'custom fork' }, { kind: 'tiny', prompt: 'custom card' }])
  assert.equal(f.saved[0]?.title, '🏷️ TITLE: Fork title')
})

test('a title request keeps one settings snapshot through fallback and card, while replan hot reloads the next save', async t => {
  const file = titleSettingsDirectory(t)
  await setTitleSettings('first fork', 'first tiny', 'first card')
  const f = fixture({ icons: 'emoji', settingsFile: file })
  const pending = Promise.withResolvers<{ replyText: string }>()
  f.session.runEphemeralTurn = async args => { f.calls.push('fork'); f.prompts.push({ kind: 'fork', prompt: args.promptText }); return pending.promise }
  f.user(); f.reply()
  assert.deepEqual(f.prompts, [{ kind: 'fork', prompt: 'first fork' }])
  const messages = [...f.session.agent.state.messages]
  await setTitleSettings('second fork', 'second tiny', 'second card')
  assert.deepEqual(f.session.agent.state.messages, messages)
  assert.deepEqual(f.saved, [])
  pending.reject(new Error('fork failed'))
  await f.settle()
  assert.deepEqual(f.prompts, [
    { kind: 'fork', prompt: 'first fork' },
    { kind: 'tiny', prompt: 'first tiny' },
    { kind: 'tiny', prompt: 'first card' },
  ])
  f.emit('tool_result', { toolName: 'todo', input: { op: 'init' }, isError: false }); await f.settle()
  assert.deepEqual(f.prompts.slice(3), [{ kind: 'tiny', prompt: 'second tiny' }, { kind: 'tiny', prompt: 'second card' }])
  assert.equal(f.saved.at(-1)?.trigger, 'replan')
  await f.manager.setSessionName('Manual title', 'user')
  const count = f.calls.length
  await setTitleSettings('third fork', 'third tiny', 'third card')
  assert.equal(f.manager.getSessionName(), 'Manual title')
  assert.equal(f.calls.length, count)
})

test('saved non-default tiny supersedes TITLE_SYSTEM, and resetting tiny restores the official override', async t => {
  const file = titleSettingsDirectory(t)
  for (const generator of ['fork', 'tiny']) {
    await setTitleSettings('custom fork', 'custom tiny', 'custom card')
    const f = fixture({ generator, icons: 'emoji', settingsFile: file })
    f.session.titleSystemPrompt = 'Project title instructions'
    f.user(); f.reply(); await f.settle()
    assert.deepEqual(f.calls, ['tiny'])
    assert.deepEqual(f.prompts, [{ kind: 'tiny', prompt: 'custom tiny' }])
    await setTitleSettings('custom fork', defaultTitlePrompts.tinyPrompt, 'custom card')
    f.emit('tool_result', { toolName: 'todo', input: { op: 'init' }, isError: false }); await f.settle()
    assert.deepEqual(f.prompts.at(-1), { kind: 'tiny', prompt: undefined })
    assert.deepEqual(f.calls, ['tiny', 'tiny'])
  }
})
