import { createServer } from 'node:http'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import path from 'node:path'
import { createTransitionFixture } from './session-transition-fixture.mjs'

export async function createToolInteractionFixture(runtimeDir) {
  process.env.OMPI_OMP_RUNTIME_DIR = path.resolve(runtimeDir)
  for (const key of ['OMPI_OMP_BIN', 'OMPI_BUN_BIN', 'PI_NATIVES_DIR']) delete process.env[key]
  const { resolveInstalledOmpRuntime, installedOmpExecutable } = await import('../packages/omp-worker/src/omp/omp-runtime.ts')
  const runtime = resolveInstalledOmpRuntime()
  if (!runtime) throw new Error('Explicit official runtime is required')
  process.env.OMPI_OMP_BIN = installedOmpExecutable(runtime, 'omp')
  process.env.OMPI_BUN_BIN = installedOmpExecutable(runtime, 'bun')
  process.env.PI_NATIVES_DIR = path.join(runtime.root, 'node_modules', '@oh-my-pi', 'pi-natives')
  const fixture = await createTransitionFixture()
  await fixture.close()
  for (const key of Object.keys(process.env)) if (/(API_KEY|ACCESS_TOKEN|AUTH_TOKEN|SECRET|PASSWORD)$/i.test(key)) delete process.env[key]
  for (const dir of ['local', 'roaming']) mkdirSync(path.join(fixture.root, dir), { recursive: true })
  process.env.LOCALAPPDATA = path.join(fixture.root, 'local')
  process.env.APPDATA = path.join(fixture.root, 'roaming')
  process.env.XDG_CONFIG_HOME = path.join(fixture.root, 'config')
  process.env.XDG_CACHE_HOME = path.join(fixture.root, 'cache')
  process.env.XDG_DATA_HOME = path.join(fixture.root, 'data')
  const nonceFile = path.join(fixture.root, 'starts.jsonl')
  writeFileSync(nonceFile, '')
  const child = path.join(fixture.cwd, 'interactive.mjs')
  writeFileSync(child, `import { appendFileSync } from 'node:fs';
const [file, nonce, mode] = process.argv.slice(2);
appendFileSync(file, JSON.stringify({ nonce, pid: process.pid }) + '\\n');
console.log('PTY_READY ' + JSON.stringify({ nonce, stdinTTY: !!process.stdin.isTTY, stdoutTTY: !!process.stdout.isTTY, cols: process.stdout.columns, rows: process.stdout.rows }));
if (!process.stdin.isTTY || !process.stdout.isTTY) process.exit(42);
if (mode === 'nonzero') process.exit(7);
if (mode === 'interactive') {
  process.stdin.setRawMode(true); process.stdin.setEncoding('utf8'); process.stdin.resume();
  let text = '', arrows = 0;
  process.stdout.on('resize', () => console.log('PTY_RESIZE ' + JSON.stringify({ cols: process.stdout.columns, rows: process.stdout.rows })));
  console.log('请选择模板，然后输入中文答案并按 Enter');
  process.stdin.on('data', chunk => {
    if (chunk.includes('\\x03')) { console.log('PTY_CTRL_C'); process.exit(130); }
    for (const sequence of ['\\x1b[A', '\\x1b[B', '\\x1b[C', '\\x1b[D']) { if (chunk.includes(sequence)) { arrows++; chunk = chunk.replaceAll(sequence, ''); } }
    if (chunk.includes('\\r') || chunk.includes('\\n')) {
      text += chunk.replace(/[\\r\\n]/g, '');
      console.log('PTY_INPUT ' + JSON.stringify({ text, arrows, cols: process.stdout.columns, rows: process.stdout.rows }));
      process.stdin.setRawMode(false); process.stdin.pause(); process.exit(text.includes('确认中文') ? 0 : 9);
    }
    text += chunk;
  });
} else setInterval(() => {}, 1000);
`)
  const requests = [], results = []
  const quote = text => `'${String(text).replaceAll("'", "'\\''")}'`
  const provider = createServer(async (request, response) => {
    try {
      let text = ''; for await (const chunk of request) { text += chunk; if (text.length > 4 * 1024 * 1024) throw new Error('Fixture request too large') }
      const input = JSON.parse(text)
      requests.push(input); fixture.save('tool-provider-requests.json', requests)
      const messages = input.messages ?? []
      const lastUserIndex = messages.findLastIndex(message => message.role === 'user')
      const prompt = JSON.stringify(messages[lastUserIndex]?.content ?? '')
      const mode = /PTY\s+(interactive|nonzero|timeout|cancel)/i.exec(prompt)?.[1]?.toLowerCase()
      const toolResult = messages.slice(lastUserIndex + 1).find(message => message.role === 'tool')
      let delta = { content: 'Ready. Send PTY interactive, PTY nonzero, PTY timeout, or PTY cancel.' }
      if (mode && !toolResult) {
        const id = `pty-${randomUUID()}`, nonce = randomUUID()
        const command = `${process.platform === 'win32' ? '& ' : ''}${[process.execPath, child, nonceFile, nonce, mode].map(quote).join(' ')}${process.platform === 'win32' ? '; exit $LASTEXITCODE' : ''}`
        delta = { tool_calls: [{ index: 0, id, type: 'function', function: { name: 'bash', arguments: JSON.stringify({ command, pty: true, timeout: mode === 'timeout' ? 3 : 0 }) } }] }
      } else if (mode && toolResult) {
        results.push({ mode, toolResult }); fixture.save('tool-results.json', results)
        delta = { content: `MODEL_CONTINUED ${mode}: received original ${toolResult.tool_call_id}; ${typeof toolResult.content === 'string' ? toolResult.content : JSON.stringify(toolResult.content)}` }
      }
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      const frame = (data, finish_reason = null) => ({ id: 'tool-interaction-fixture', object: 'chat.completion.chunk', created: 1, model: 'offline', choices: [{ index: 0, delta: data, finish_reason }], ...(finish_reason ? { usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } } : {}) })
      response.write(`data: ${JSON.stringify(frame({ role: 'assistant', ...delta }))}\n\n`)
      response.write(`data: ${JSON.stringify(frame({}, delta.tool_calls ? 'tool_calls' : 'stop'))}\n\n`)
      response.end('data: [DONE]\n\n')
    } catch (error) { response.writeHead(500); response.end(String(error)) }
  })
  await new Promise(resolve => provider.listen(0, '127.0.0.1', resolve))
  writeFileSync(path.join(fixture.agent, 'models.yml'), `providers:\n  tool-fixture:\n    baseUrl: http://127.0.0.1:${provider.address().port}/v1\n    apiKey: offline-fixture\n    api: openai-completions\n    models:\n      - id: offline\n        name: Offline PTY fixture\n        reasoning: false\n        input: [text]\n        contextWindow: 128000\n        maxTokens: 4096\n        cost: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0}\n`)
  writeFileSync(path.join(fixture.agent, 'config.yml'), `modelRoles:\n  default: tool-fixture/offline\ntitle:\n  enabled: false\nasync:\n  enabled: false\nlaunch:\n  enabled: false\nshellPath: ${JSON.stringify(process.platform === 'win32' ? 'C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe' : '/bin/sh')}\nautoResume: false\n`)
  return { ...fixture, runtime, requests, results, nonceFile,
    starts() { return readFileSync(nonceFile, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line)) },
    async close() { provider.closeAllConnections(); await new Promise(resolve => provider.close(resolve)) },
  }
}
