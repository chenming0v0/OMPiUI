import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// All state is native OMP state. The only fake component is an OpenAI-compatible
// loopback model; it emits real task/write/bash/yield calls. No proxy, controller
// replacement, replay into the app, or merge retry is used.
export const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
export const SUBAGENT_COMPAT_AUTH_TOKEN = 'isolated-subagent-compat'
export const commands = {
  spawn: '/subagent-compat-spawn', wakeOne: '/subagent-compat-wake-one',
  wakeTwo: '/subagent-compat-wake-two', releaseOld: '/subagent-compat-release-old',
  releaseNew: '/subagent-compat-release-new', merge: '/subagent-compat-merge',
  releaseMerge: '/subagent-compat-release-merge', structured: '/subagent-compat-structured',
}
export const sha256 = value => createHash('sha256').update(value).digest('hex')
export const entries = file => readFileSync(file, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line))
export function journalStamps(root) {
  if (!existsSync(root)) return []
  return readdirSync(root, { withFileTypes: true }).flatMap(item => {
    const file = path.join(root, item.name)
    return item.isDirectory() ? journalStamps(file) : item.name.endsWith('.jsonl') ? [{ file, sha256: sha256(readFileSync(file)), size: statSync(file).size, mtimeMs: statSync(file).mtimeMs }] : []
  }).sort((a, b) => a.file.localeCompare(b.file))
}
export function releaseCompatGate(root, gate) {
  if (!['old', 'new', 'merge'].includes(gate)) throw new Error('Gate must be old, new or merge')
  const file = path.join(path.resolve(root), 'control.json')
  const previous = JSON.parse(readFileSync(file, 'utf8'))
  writeFileSync(file, JSON.stringify({ ...previous, [gate]: true }, null, 2) + '\n')
  return { gate, root: path.resolve(root) }
}
const text = message => typeof message?.content === 'string' ? message.content : (message?.content ?? []).filter(part => part.type === 'text').map(part => part.text).join('\n')
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

export async function createSubagentCompatFixture(runtimeDir = path.join(repoRoot, '.slim/issue-repair-native-runtime')) {
  process.env.OMPI_OMP_RUNTIME_DIR = path.resolve(runtimeDir)
  for (const key of ['OMPI_OMP_BIN', 'OMPI_BUN_BIN', 'PI_NATIVES_DIR']) delete process.env[key]
  const { resolveInstalledOmpRuntime, installedOmpExecutable } = await import('../packages/omp-worker/src/omp/omp-runtime.ts')
  const runtime = resolveInstalledOmpRuntime()
  assert.equal(runtime?.version, '18.12.6', 'Use the existing official OMP 18.12.6 runtime; this fixture never installs one')
  const nativeBin = installedOmpExecutable(runtime, 'omp')
  const base = path.join(repoRoot, '.slim/subagent-compat-acceptance')
  mkdirSync(base, { recursive: true })
  const root = mkdtempSync(path.join(base, 'run-'))
  const agent = path.join(root, 'agent'), orderingCwd = path.join(root, 'ordering'), mergeCwd = path.join(root, 'merge'), structuredCwd = path.join(root, 'structured')
  for (const [key, dir] of Object.entries({ HOME: 'home', USERPROFILE: 'home', LOCALAPPDATA: 'local', APPDATA: 'roaming', XDG_CONFIG_HOME: 'config', XDG_DATA_HOME: 'data', XDG_STATE_HOME: 'state', XDG_CACHE_HOME: 'cache', TEMP: 'tmp', TMP: 'tmp', TMPDIR: 'tmp', PI_CODING_AGENT_DIR: 'agent', OMPIUI_DATA_DIR: 'webui', OMP_WORKTREE_DIR: 'worktrees' })) {
    process.env[key] = path.join(root, dir); mkdirSync(process.env[key], { recursive: true })
  }
  for (const key of Object.keys(process.env)) if (/(API_KEY|ACCESS_TOKEN|AUTH_TOKEN|SECRET|PASSWORD)$/i.test(key)) delete process.env[key]
  for (const key of ['OMP_PROFILE', 'PI_PROFILE', 'OMP_AGENT_DIR', 'PI_CODING_AGENT_SESSION_DIR', 'PI_CONFIG_FILES', 'PI_CONFIG_DIR', 'OMPIUI_OMP_SESSION_DIRS']) delete process.env[key]
  process.env.OMPI_OMP_BIN = nativeBin
  process.env.OMPI_BUN_BIN = installedOmpExecutable(runtime, 'bun')
  process.env.PI_NATIVES_DIR = path.join(runtime.root, '.omp/natives')
  process.env.PI_NATIVE_VARIANT = 'baseline'
  process.env.OMPIUI_DRIVER = 'omp'
  process.env.OMPIUI_DIAGNOSTICS = '1'
  process.env.OMPIUI_DIAGNOSTIC_LEVEL = 'debug'
  const nativeVersion = execFileSync(nativeBin, ['--version'], { encoding: 'utf8', timeout: 15000 }).trim()
  assert.match(nativeVersion, /18\.12\.6/, 'Selected native executable must really be OMP 18.12.6')
  const control = path.join(root, 'control.json'), evidence = path.join(root, 'native-evidence.jsonl'), providerEvidence = path.join(root, 'provider-evidence.jsonl')
  writeFileSync(control, JSON.stringify({ old: false, new: false, merge: false }) + '\n')
  const git = (cwd, args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', timeout: 15000 })
  for (const cwd of [orderingCwd, mergeCwd, structuredCwd]) {
    mkdirSync(path.join(cwd, '.omp'), { recursive: true })
    git(cwd, ['init', '-b', 'fixture'])
    git(cwd, ['config', 'user.name', 'Isolated fixture'])
    git(cwd, ['config', 'user.email', 'fixture@localhost'])
    git(cwd, ['config', 'core.autocrlf', 'false'])
    writeFileSync(path.join(cwd, '.gitignore'), '.omp/\n')
    writeFileSync(path.join(cwd, 'conflict.txt'), 'base\n')
    git(cwd, ['add', '.gitignore', 'conflict.txt']); git(cwd, ['commit', '-m', 'Isolated fixture baseline'])
  }
  writeFileSync(path.join(orderingCwd, '.omp/config.yml'), 'task:\n  structured: false\nasync:\n  enabled: true\n')
  writeFileSync(path.join(mergeCwd, '.omp/config.yml'), 'task:\n  structured: true\n  isolation:\n    enabled: true\n    apply: true\n    merge: branch\nasync:\n  enabled: false\nisolation:\n  backend: rcopy\n')
  writeFileSync(path.join(structuredCwd, '.omp/config.yml'), 'task:\n  structured: true\nasync:\n  enabled: false\n')
  const runner = path.join(root, 'gate.cjs')
  writeFileSync(runner, `const fs=require('node:fs');const gate=process.argv[2];const control=${JSON.stringify(control)};const evidence=${JSON.stringify(evidence)};fs.appendFileSync(evidence,JSON.stringify({kind:'native-bash-gate-start',gate,pid:process.pid,time:Date.now()})+'\\n');const start=Date.now();const timer=setInterval(()=>{if(JSON.parse(fs.readFileSync(control))[gate]){clearInterval(timer);fs.appendFileSync(evidence,JSON.stringify({kind:'native-bash-gate-exit',gate,pid:process.pid,time:Date.now()})+'\\n');console.log('REAL_OLD_ASYNC_EXIT');}else if(Date.now()-start>600000){clearInterval(timer);process.exitCode=1;}},25);\n`)
  const requests = [], errors = [], nativeFrames = []
  let stopping = false
  const record = value => appendFileSync(providerEvidence, JSON.stringify({ time: Date.now(), ...value }) + '\n')
  async function gate(name, response) {
    record({ kind: 'provider-gate-held', gate: name })
    const deadline = Date.now() + 600000
    while (!JSON.parse(readFileSync(control, 'utf8'))[name]) {
      if (stopping || response.destroyed) throw new Error(`Provider gate ${name} closed`)
      assert.ok(Date.now() < deadline, `Provider gate ${name} timed out; release explicitly`)
      await sleep(25)
    }
    record({ kind: 'provider-gate-released', gate: name })
  }
  const provider = createServer(async (request, response) => {
    try {
      if (request.method !== 'POST' || request.url !== '/v1/chat/completions') { response.writeHead(404); response.end(); return }
      let body = ''; for await (const chunk of request) body += chunk
      const input = JSON.parse(body), messages = input.messages ?? [], tools = (input.tools ?? []).map(tool => tool.function?.name)
      const users = messages.filter(message => message.role === 'user').map(text), lastUser = users.at(-1) ?? '', allUsers = users.join('\n')
      const n = requests.length + 1
      const child = !tools.includes('task') && /COMPAT_CHILD_(ORDER|MERGE|YIELD)/.test(allUsers)
      const log = { n, child, tools, lastUser: lastUser.slice(-1500) }
      requests.push(log); record({ kind: 'provider-request', ...log })
      const call = (name, args, id) => ({ tool_calls: [{ index: 0, id, type: 'function', function: { name, arguments: JSON.stringify(args) } }] })
      const called = id => messages.some(message => (message.tool_calls ?? []).some(tool => tool.id === id))
      let delta = { content: 'Native fixture acknowledgement' }
      if (!tools.length) delta = { content: '<title>Exercise native subagent compatibility</title>' }
      else if (child && /COMPAT_CHILD_MERGE/.test(allUsers)) {
        if (!called('compat-merge-write')) delta = call('write', { path: 'conflict.txt', content: 'child\n' }, 'compat-merge-write')
        else {
          // The actual native child has already changed its isolated checkout.
          // Diverge the parent once, before allowing native yield and its one merge.
          if (!JSON.parse(readFileSync(control)).parentDiverged) {
            writeFileSync(path.join(mergeCwd, 'conflict.txt'), 'parent\n')
            git(mergeCwd, ['add', 'conflict.txt']); git(mergeCwd, ['commit', '-m', 'Controlled parent divergence'])
            const previous = JSON.parse(readFileSync(control)); writeFileSync(control, JSON.stringify({ ...previous, parentDiverged: true }) + '\n')
            record({ kind: 'parent-diverged', cwd: mergeCwd, head: git(mergeCwd, ['rev-parse', 'HEAD']).trim() })
          }
          await gate('merge', response)
          assert.ok(tools.includes('yield'), 'Merge child must use real structured yield')
          delta = call('yield', { data: 'REAL_MERGE_CHILD_EXIT_ZERO' }, 'compat-merge-yield')
        }
      } else if (child && /COMPAT_CHILD_YIELD/.test(allUsers)) {
        assert.ok(tools.includes('yield')); delta = call('yield', { data: 'REAL_STRUCTURED_YIELD' }, 'compat-structured-yield')
      } else if (child) {
        if (/COMPAT_WAKE_TWO/.test(lastUser)) {
          await gate('new', response); delta = { content: 'REAL_NEW_REPLY_AFTER_OLD_TERMINAL' }
        } else if (/COMPAT_WAKE_ONE/.test(lastUser)) {
          delta = !called('compat-old-async') ? call('bash', { command: `node "${runner.replaceAll('\\', '/')}" old`, async: true, timeout: 610 }, 'compat-old-async') : { content: 'REAL_OLD_TURN_WITH_PENDING_ASYNC' }
        } else delta = { content: /async-result|REAL_OLD_ASYNC_EXIT|Background job/.test(lastUser) ? 'REAL_OLD_ASYNC_FOLLOWUP' : 'REAL_INITIAL_CHILD_REPLY' }
      } else {
        const marker = [...allUsers.matchAll(/COMPAT_(ORDER_SPAWN|WAKE_ONE|WAKE_TWO|MERGE_SPAWN|YIELD_SPAWN)/g)].at(-1)?.[1]
        const id = `compat-parent-${marker}`
        if (marker && !called(id)) {
          if (marker.startsWith('WAKE')) delta = call('write', { path: 'agent://OrderingChild', content: `COMPAT_${marker}` }, id)
          else {
            const merge = marker === 'MERGE_SPAWN', structured = marker === 'YIELD_SPAWN'
            delta = call('task', { i: 'Exercising native compatibility', context: 'Isolated deterministic native compatibility acceptance. Do not retry any merge.', tasks: [{ name: merge ? 'MergeChild' : structured ? 'YieldChild' : 'OrderingChild', agent: 'task', task: `COMPAT_CHILD_${merge ? 'MERGE' : structured ? 'YIELD' : 'ORDER'}. Return the requested fixture result.`, ...(merge ? { isolated: true } : {}) }] }, id)
          }
        } else delta = { content: `REAL_PARENT_REPLY_${marker ?? 'IDLE'}` }
      }
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      const chunk = (part, finish = null) => ({ id: `compat-${n}`, object: 'chat.completion.chunk', created: 1, model: 'offline', choices: [{ index: 0, delta: part, finish_reason: finish }], ...(finish ? { usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } } : {}) })
      response.write(`data: ${JSON.stringify(chunk({ role: 'assistant', ...delta }))}\n\n`)
      response.write(`data: ${JSON.stringify(chunk({}, delta.tool_calls ? 'tool_calls' : 'stop'))}\n\n`)
      response.end('data: [DONE]\n\n')
    } catch (error) {
      if (!stopping) { errors.push(String(error)); record({ kind: 'provider-error', error: String(error) }) }
      if (!response.headersSent) response.writeHead(500)
      response.end(String(error))
    }
  })
  await new Promise(resolve => provider.listen(0, '127.0.0.1', resolve))
  writeFileSync(path.join(agent, 'models.yml'), `providers:\n  subagent-compat:\n    baseUrl: http://127.0.0.1:${provider.address().port}/v1\n    apiKey: sk-isolated-loopback\n    api: openai-completions\n    models:\n      - id: offline\n        name: Native subagent compatibility fixture\n        reasoning: false\n        input: [text]\n        contextWindow: 128000\n        maxTokens: 4096\n        cost: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0}\n`)
  writeFileSync(path.join(agent, 'config.yml'), 'modelRoles:\n  default: subagent-compat/offline\n  task: subagent-compat/offline\n  smol: subagent-compat/offline\ntitle:\n  enabled: false\ntask:\n  batch: true\n  maxConcurrency: 2\n  maxRecursionDepth: 1\n  completionProbe: false\n  maxRuntimeMs: 600000\nasync:\n  enabled: false\nlaunch:\n  enabled: false\nautoResume: false\n')
  mkdirSync(path.join(agent, 'extensions'))
  writeFileSync(path.join(agent, 'extensions/subagent-compat.js'), `import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
const evidence=${JSON.stringify(evidence)}, control=${JSON.stringify(control)};
export default function(pi) {
  const record=(kind,payload,ctx)=>appendFileSync(evidence,JSON.stringify({time:Date.now(),kind,sessionId:ctx?.sessionManager.getSessionId(),payload})+'\\n');
  for(const kind of ['session_start','agent_start','agent_end','tool_execution_end']) pi.on(kind,(event,ctx)=>record(kind,event,ctx));
  for(const kind of ['lifecycle','progress','event']) pi.events.on('task:subagent:'+kind,payload=>record('subagent_'+kind,payload));
  const markers={spawn:'COMPAT_ORDER_SPAWN','wake-one':'COMPAT_WAKE_ONE','wake-two':'COMPAT_WAKE_TWO',merge:'COMPAT_MERGE_SPAWN',structured:'COMPAT_YIELD_SPAWN'};
  for(const [suffix,marker] of Object.entries(markers)) pi.registerCommand('subagent-compat-'+suffix,{description:'Isolated acceptance: real native '+suffix,handler:async()=>pi.sendUserMessage(marker)});
  for(const gate of ['old','new','merge']) pi.registerCommand('subagent-compat-release-'+gate,{description:'Isolated acceptance: release '+gate+' gate only; no model turn',handler:async()=>{const flags=JSON.parse(readFileSync(control));writeFileSync(control,JSON.stringify({...flags,[gate]:true})+'\\n');record('gate-release',{gate});}});
}
`)
  const historicalPaths = [path.join(repoRoot, '.slim/issue-retry-373-1/.probe373/run2/native-ordering-evidence.json'), path.join(repoRoot, '.slim/issue-retry-374-1/.tmp/issue-374-retry-evidence.json')]
  const historical = historicalPaths.filter(existsSync).map(file => { const bytes = readFileSync(file), value = JSON.parse(bytes); return { file, sha256: sha256(bytes), version: value.version ?? value.runtime?.omp, status: value.status, note: 'Read-only reference; never replayed into GUI or modified' } })
  const manifest = { root, agent, orderingCwd, mergeCwd, structuredCwd, control, evidence, providerEvidence, nativeBin, nativeVersion, runtime, nativeBinarySha256: sha256(readFileSync(nativeBin)), providerUrl: `http://127.0.0.1:${provider.address().port}/v1`, commands, historical, diagnostics: { directory: path.join(root, 'webui/logs/diagnostics'), level: 'debug', refreshMustNotAdd: ['session.attached', 'worker.request.started command=session.open', 'worker.request.started command=prompt', 'worker.request.started command=sendUserMessage'] }, authToken: SUBAGENT_COMPAT_AUTH_TOKEN, url: 'http://127.0.0.1:8800/?token=' + SUBAGENT_COMPAT_AUTH_TOKEN, limitations: ['Native 18.12.6 has no wake attempt identity: provider gates control timing, not producer metadata.', 'Ordering scenario intentionally uses native prose completion + async work; structured yield has a separate real task test.', 'Merge conflict output is evidence only; absent merge fields must stay unconfirmed, never parsed into authority.', 'Each scenario runs once per fresh session/repo; gates are one-shot and merge is never retried.'] }
  const save = (name, value) => writeFileSync(path.join(root, name), JSON.stringify(value, null, 2) + '\n')
  save('subagent-compat-fixture.json', manifest)
  return { ...manifest, requests, errors, nativeFrames, save, git, release(gate) { return releaseCompatGate(root, gate) }, async close() { stopping = true; for (const gate of ['old', 'new', 'merge']) releaseCompatGate(root, gate); provider.closeAllConnections(); await new Promise(resolve => provider.close(resolve)) } }
}
