import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { spawn, execFileSync } from 'node:child_process'
import { createServer } from 'node:http'
import { createConnection } from 'node:net'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, appendFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// node scripts/verify-tool-pty-contract.mjs
// Stage 0: one short-lived official rpc-ui process, a loopback SSE provider and
// a native IPC endpoint. Never uses an active session, real key, TUI or devserver.
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const runtime = path.join(repo, '.slim', 'issue-repair-native-runtime')
const manifest = JSON.parse(readFileSync(path.join(runtime, 'runtime.json'), 'utf8'))
const binary = path.join(runtime, 'bin', process.platform === 'win32' ? 'omp.exe' : 'omp')
const bun = path.join(runtime, 'bin', process.platform === 'win32' ? 'bun.exe' : 'bun')
const packageRoot = path.join(runtime, 'node_modules', '@oh-my-pi', 'pi-coding-agent')
const base = path.join(repo, '.slim', 'tool-pty-contract')
mkdirSync(base, { recursive: true })
const root = mkdtempSync(path.join(base, 'run-'))
const agent = path.join(root, 'agent'), cwd = path.join(root, 'workspace'), tmp = path.join(root, 'tmp')
for (const dir of [agent, cwd, tmp, path.join(agent, 'extensions')]) mkdirSync(dir)
const auditFile = path.join(root, 'audit.jsonl'), endpointFile = path.join(root, 'endpoint.txt'), nonceFile = path.join(root, 'nonce.txt')
writeFileSync(auditFile, ''); writeFileSync(nonceFile, '')
const audit = () => readFileSync(auditFile, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line))
const environment = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
  /^(PATH|SYSTEMROOT|WINDIR|COMSPEC|PATHEXT|PROCESSOR_ARCHITECTURE|NUMBER_OF_PROCESSORS|LANG|LC_ALL)$/i.test(key)).map(([key, value]) => [process.platform === 'win32' ? key.toUpperCase() : key, value]))
Object.assign(environment, { HOME: root, USERPROFILE: root, PI_CODING_AGENT_DIR: agent, TEMP: tmp, TMP: tmp, TMPDIR: tmp,
  XDG_CONFIG_HOME: path.join(root, 'xdg-config'), XDG_DATA_HOME: path.join(root, 'xdg-data'), XDG_STATE_HOME: path.join(root, 'xdg-state'), XDG_CACHE_HOME: path.join(root, 'xdg-cache'),
  TOOL_PTY_CONTRACT_CONFIG: path.join(root, 'probe.json'), NO_COLOR: '1' })
const shell = process.platform === 'win32' ? 'C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe' : '/bin/sh'
assert.ok(shell, 'This native bash/PTY probe requires a local shell')
writeFileSync(environment.TOOL_PTY_CONTRACT_CONFIG, JSON.stringify({ root, audit: auditFile, endpointFile, shell,
  toolProxy: path.join(packageRoot, 'src', 'extensibility', 'tool-proxy.ts'),
  natives: path.join(runtime, 'node_modules', '@oh-my-pi', 'pi-natives', 'native', 'index.js') }))
writeFileSync(path.join(agent, 'extensions', 'contract.mjs'), readFileSync(path.join(repo, 'scripts', 'tool-pty-contract-extension-fixture.mjs')))
const quote = text => `'${String(text).replaceAll("'", "'\\''")}'`
const commandFor = (nonce, mode, pty) => `${process.platform === 'win32' && pty ? '& ' : ''}${[process.execPath, path.join(repo, 'scripts', 'tool-pty-contract-child-fixture.mjs'), nonceFile, nonce, mode].map(quote).join(' ')}${process.platform === 'win32' && pty ? '; exit $LASTEXITCODE' : ''}`
let child, socket, provider, fatal
let sequence = 0, ready = false, stdout = '', ipcBuffer = ''
const frames = [], ipcFrames = [], pending = new Map(), jobs = new Map(), providerErrors = []
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
async function wait(check, description, timeout = 30000) {
  const deadline = Date.now() + timeout
  while (true) {
    if (fatal) throw fatal
    const value = check()
    if (value) return value
    assert.ok(Date.now() < deadline, `Timeout: ${description}; recent audit=${JSON.stringify(audit().slice(-5))}`)
    await delay(25)
  }
}
function rpc(type, data = {}) {
  const id = `contract-rpc-${++sequence}`
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`RPC timeout: ${type}`)) }, 30000)
    pending.set(id, { resolve, reject, timer })
    child.stdin.write(`${JSON.stringify({ id, type, ...data })}\n`)
  })
}
async function settled() { await wait(asyncCheck, 'runtime settled') }
// Async state polling has an explicit deadline rather than a truthy Promise predicate.
let asyncCheck = () => false
async function idle() {
  const deadline = Date.now() + 30000
  while (!(await rpc('get_state')).isSettled) {
    assert.ok(Date.now() < deadline, 'Runtime did not settle')
    await delay(50)
  }
}
async function runTool(name, mode, pty = false, timeout = 10) {
  const nonce = `${name}-${randomUUID()}`
  const id = `outer-${name}`
  jobs.set(name, { id, args: { command: commandFor(nonce, mode, pty), timeout, ...(pty ? { pty: true } : {}) }, dispatched: false })
  await rpc('prompt', { message: `CONTRACT_CASE=${name}` })
  return { nonce, id }
}
async function control(frame) {
  const offset = ipcFrames.length
  socket.write(`${JSON.stringify(frame)}\n`)
  return await wait(() => ipcFrames.slice(offset).find(item => item.type === 'ack' && item.operation === frame.type), `IPC ${frame.type}`)
}
function once(nonce) { assert.equal(readFileSync(nonceFile, 'utf8').split('\n').filter(line => line === nonce).length, 1, `${nonce}: actual command starts exactly once`) }
function resultFor(id) { return frames.find(frame => frame.type === 'tool_execution_end' && frame.toolCallId === id) }

const overall = setTimeout(() => { fatal = new Error('Overall contract deadline exceeded'); child?.kill(); socket?.destroy() }, 180000)
try {
  assert.equal(manifest.version, '18.12.6'); assert.equal(manifest.bunVersion, '1.3.14')
  assert.equal(JSON.parse(readFileSync(path.join(packageRoot, 'package.json'), 'utf8')).version, manifest.version)
  assert.equal(createHash('sha256').update(readFileSync(binary)).digest('hex'), manifest.binarySha256, 'pinned official binary hash')
  assert.equal(execFileSync(bun, ['--version'], { env: environment, cwd, encoding: 'utf8', timeout: 10000 }).trim(), manifest.bunVersion)
  assert.match(execFileSync(binary, ['--version'], { env: environment, cwd, encoding: 'utf8', timeout: 10000 }), /18\.12\.6/)
  provider = createServer(async (request, response) => {
    try {
      let body = ''; for await (const chunk of request) { body += chunk; assert.ok(body.length < 2000000, 'bounded fixture request') }
      const input = JSON.parse(body)
      appendFileSync(path.join(root, 'provider.jsonl'), `${JSON.stringify(input)}\n`)
      const user = input.messages.filter(message => message.role === 'user').at(-1)
      const marker = JSON.stringify(user?.content).match(/CONTRACT_CASE=([\w-]+)/)?.[1]
      const job = jobs.get(marker)
      let delta = { content: 'Isolated contract complete' }
      if (job && !job.dispatched) {
        const tool = input.tools?.find(tool => tool.function?.name === 'bash')
        assert.ok(tool, 'model receives real bash wire schema after late registration')
        job.schema = tool.function.parameters; job.description = tool.function.description
        job.dispatched = true
        delta = { tool_calls: [{ index: 0, id: job.id, type: 'function', function: { name: 'bash', arguments: JSON.stringify(job.args) } }] }
      }
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      const chunk = (part, finish_reason = null) => ({ id: 'tool-pty-contract', object: 'chat.completion.chunk', created: 1, model: 'offline',
        choices: [{ index: 0, delta: part, finish_reason }], ...(finish_reason ? { usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } } : {}) })
      response.write(`data: ${JSON.stringify(chunk({ role: 'assistant', ...delta }))}\n\n`)
      response.write(`data: ${JSON.stringify(chunk({}, delta.tool_calls ? 'tool_calls' : 'stop'))}\n\n`)
      response.end('data: [DONE]\n\n')
    } catch (error) { providerErrors.push(error); response.writeHead(500); response.end(String(error)) }
  })
  await new Promise(resolve => provider.listen(0, '127.0.0.1', resolve))
  writeFileSync(path.join(agent, 'models.yml'), `providers:\n  contract-fixture:\n    baseUrl: http://127.0.0.1:${provider.address().port}/v1\n    apiKey: sk-offline-contract\n    api: openai-completions\n    models:\n      - id: offline\n        name: Offline contract\n        reasoning: false\n        input: [text]\n        contextWindow: 128000\n        maxTokens: 4096\n        cost: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0}\n`)
  writeFileSync(path.join(agent, 'config.yml'), `modelRoles:\n  default: contract-fixture/offline\ntitle:\n  enabled: false\nasync:\n  enabled: false\nlaunch:\n  enabled: false\nbash:\n  autoBackground:\n    enabled: false\nshell:\n  path: ${JSON.stringify(shell)}\nautoResume: false\n`)
  child = spawn(binary, ['--mode', 'rpc-ui', '--no-ui', '--extension', path.join(agent, 'extensions', 'contract.mjs')], { cwd, env: environment, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
  child.on('error', error => { fatal = error })
  child.on('exit', (code, signal) => { if (!cleanup) fatal = new Error(`Official rpc-ui exited ${code}/${signal}`) })
  child.stderr.on('data', chunk => appendFileSync(path.join(root, 'stderr.log'), chunk))
  child.stdout.on('data', chunk => {
    appendFileSync(path.join(root, 'stdout.jsonl'), chunk)
    stdout += chunk.toString()
    while (stdout.includes('\n')) {
      const index = stdout.indexOf('\n'), line = stdout.slice(0, index); stdout = stdout.slice(index + 1)
      if (!line.trim()) continue
      try {
        const frame = JSON.parse(line); frames.push(frame)
        if (frame.type === 'ready') ready = true
        if (frame.type === 'response' && pending.has(frame.id)) {
          const task = pending.get(frame.id); pending.delete(frame.id); clearTimeout(task.timer)
          if (frame.success === false) task.reject(new Error(JSON.stringify(frame)))
          else task.resolve(frame.data)
        }
      } catch (error) { fatal = new Error(`Invalid official RPC line: ${line.slice(0, 200)}`, { cause: error }) }
    }
  })
  await wait(() => ready, 'official ready after session_start')
  await wait(() => audit().some(item => item.type === 'registered'), 'session_start registration')
  assert.equal(audit().filter(item => item.type === 'registered').length, 1)
  const state = await rpc('get_state')
  assert.ok(state.dumpTools.some(tool => tool.name === 'bash'), 'late SDK registration completed before ready')
  const endpoint = readFileSync(endpointFile, 'utf8')
  if (process.platform !== 'win32') assert.equal(statSync(endpoint).mode & 0o777, 0o600)
  socket = createConnection(endpoint)
  socket.on('error', error => { if (!cleanup) fatal = error })
  socket.on('data', chunk => {
    ipcBuffer += chunk.toString()
    while (ipcBuffer.includes('\n')) {
      const index = ipcBuffer.indexOf('\n'); ipcFrames.push(JSON.parse(ipcBuffer.slice(0, index))); ipcBuffer = ipcBuffer.slice(index + 1)
    }
  })
  await new Promise(resolve => socket.once('connect', resolve))
  socket.write(`${JSON.stringify({ type: 'ping', token: '中文-IPC' })}\n`)
  await wait(() => ipcFrames.find(frame => frame.type === 'pong' && frame.token === '中文-IPC'), 'native IPC/Node net round trip')
  const normal = await runTool('normal', 'normal')
  await wait(() => resultFor(normal.id), 'ordinary native delegation'); await idle(); once(normal.nonce)
  const delegated = audit().find(item => item.type === 'delegate_result' && item.toolCallId === normal.id)
  assert.ok(delegated); assert.deepEqual(resultFor(normal.id).result, delegated.result)
  assert.ok(audit().some(item => item.type === 'result_identity' && item.toolCallId === normal.id && item.contentSame && item.detailsSame), 'official result object references preserved')
  assert.ok(JSON.stringify(delegated.result).includes('CONTRACT_NATIVE_RESULT'))
  console.info('PASS core: public session_start capture, lazy metadata, late SDK registration, native delegation/result identity and one launch')
  const interactive = await runTool('interactive', 'interactive', true)
  await wait(() => audit().find(item => item.type === 'pty_chunk' && item.toolCallId === interactive.id && item.chunk.includes('CONTRACT_READY')), 'real PTY ready')
  await control({ type: 'resize', toolCallId: interactive.id, cols: 101, rows: 37 })
  await control({ type: 'write', toolCallId: interactive.id, data: '中文输入\r' })
  await wait(() => resultFor(interactive.id), 'interactive PTY exit'); await idle(); once(interactive.nonce)
  const interactiveResult = audit().find(item => item.type === 'pty_result' && item.toolCallId === interactive.id)
  assert.ok(interactiveResult.output.includes('"stdinTTY":true')); assert.ok(interactiveResult.output.includes('"stdoutTTY":true'))
  assert.ok(interactiveResult.output.includes('中文输入')); assert.equal(interactiveResult.result.exitCode, 0)
  assert.equal(interactiveResult.result.cancelled, false); assert.equal(interactiveResult.result.timedOut, false)
  assert.ok(frames.some(frame => frame.type === 'tool_execution_update' && frame.toolCallId === interactive.id), 'real streaming updates stay on outer ID')
  console.info('PASS core: official PtySession.start once; real stdin/stdout TTY; native IPC + Node net; Chinese Enter/resize/live updates/exit')
  for (const [name, mode, timeout] of [['nonzero', 'nonzero', 10], ['timeout', 'hold', 1], ['cancel', 'hold', 10]]) {
    const tool = await runTool(name, mode, true, timeout)
    if (name === 'cancel') { await wait(() => audit().some(item => item.type === 'pty_chunk' && item.toolCallId === tool.id && item.chunk.includes('CONTRACT_READY')), 'cancel PTY ready'); await rpc('abort') }
    const item = await wait(() => audit().find(item => item.type === 'pty_result' && item.toolCallId === tool.id), `${name} native PTY result`)
    await idle(); once(tool.nonce)
    if (name === 'nonzero') assert.equal(item.result.exitCode, 7)
    if (name === 'timeout') assert.equal(item.result.timedOut, true)
    if (name === 'cancel') { assert.equal(item.result.cancelled, true); assert.equal(item.aborted, true) }
    console.info(`PASS PTY ${name}: ${JSON.stringify(item.result)}`)
  }
  const shape = schema => JSON.stringify(schema)
  assert.doesNotMatch(shape(jobs.get('normal').schema), /"async"|"name"/, 'explicit false is preserved in native wire schema')
  await rpc('prompt', { message: '/contract-disable' }); await idle()
  assert.equal((await rpc('get_state')).dumpTools.some(tool => tool.name === 'bash'), false, 'late replacement does not enable an inactive bash')
  await rpc('prompt', { message: '/contract-enable' }); await idle()
  await rpc('prompt', { message: '/contract-other' }); await idle()
  assert.ok(audit().some(item => item.type === 'other_registered'))
  const other = await runTool('other', 'normal')
  await wait(() => resultFor(other.id), 'other user override'); await idle()
  assert.ok(JSON.stringify(resultFor(other.id)).includes('OTHER_USER_RESULT'))
  assert.equal(readFileSync(nonceFile, 'utf8').split('\n').filter(line => line === other.nonce).length, 0, 'other user tool is not bypassed')
  console.info('PASS native explicit-false schema, inactive tools stay inactive, later user override remains authoritative')
  assert.deepEqual(providerErrors, [])
  assert.deepEqual(audit().filter(item => item.type === 'failure'), [])
  console.info('PASS stage 0 core contract (official 18.12.6 / Bun 1.3.14; isolated credentials/config/session/cwd/logs)')
} catch (error) {
  console.error(`FAIL tool-PTY contract: ${error.stack ?? error}`)
  if (existsSync(path.join(root, 'stderr.log'))) console.error(readFileSync(path.join(root, 'stderr.log'), 'utf8').slice(-6000))
  process.exitCode = 1
} finally {
  cleanup = true; clearTimeout(overall)
  socket?.destroy()
  if (child && child.exitCode === null) {
    child.stdin.end()
    await Promise.race([new Promise(resolve => child.once('exit', resolve)), delay(3000)])
    if (child.exitCode === null) { child.kill(); await Promise.race([new Promise(resolve => child.once('exit', resolve)), delay(3000)]) }
  }
  for (const task of pending.values()) { clearTimeout(task.timer); task.reject(new Error('Contract cleanup')) }
  provider?.closeAllConnections()
  if (provider) await new Promise(resolve => provider.close(resolve))
  assert.ok(root.startsWith(`${base}${path.sep}run-`))
  rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
}
var cleanup = false
