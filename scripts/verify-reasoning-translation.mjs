import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { streamReasoningTranslation } from '../packages/omp-worker/dist/omp/reasoning-translation.js'

// 在 CI 的官方 OMP 版本矩阵中验证真实模型调用，只连接隔离的本机模拟供应商。
export async function verifyReasoningTranslation() {
  const root = mkdtempSync(path.join(tmpdir(), 'ompiui-translator-'))
  const keys = ['PI_CODING_AGENT_DIR', 'OMP_PROFILE', 'PI_PROFILE', 'OMPIUI_DRIVER']
  const previous = Object.fromEntries(keys.map(key => [key, process.env[key]]))
  const agent = path.join(root, 'agent')
  const sessions = path.join(agent, 'sessions')
  mkdirSync(sessions, { recursive: true })
  const sessionFile = path.join(sessions, 'existing.jsonl')
  writeFileSync(sessionFile, '{"type":"session","id":"existing-translator-fixture"}\n')
  const sessionBytes = readFileSync(sessionFile)
  const sessionMtime = statSync(sessionFile).mtimeMs
  let stage = 'success'
  const requests = []
  const provider = createServer(async (request, response) => {
    try {
      let raw = ''
      for await (const chunk of request) raw += chunk
      requests.push(JSON.parse(raw))
      const frame = delta => ({
        id: 'translator-fixture', object: 'chat.completion.chunk', created: 1, model: 'offline',
        choices: [{ index: 0, delta, finish_reason: null }],
      })
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.write(`data: ${JSON.stringify(frame({ role: 'assistant', content: '这是' }))}\n\n`)
      if (stage === 'abort') return
      response.write(`data: ${JSON.stringify(frame({ content: '中文译文' }))}\n\n`)
      response.write(`data: ${JSON.stringify({ ...frame({}), choices: [{ index: 0, delta: {}, finish_reason: stage === 'success' ? 'stop' : 'length' }] })}\n\n`)
      response.end('data: [DONE]\n\n')
    } catch {
      response.writeHead(500)
      response.end()
    }
  })
  await new Promise(resolve => provider.listen(0, '127.0.0.1', resolve))
  try {
    process.env.PI_CODING_AGENT_DIR = agent
    process.env.OMPIUI_DRIVER = 'omp'
    delete process.env.OMP_PROFILE
    delete process.env.PI_PROFILE
    writeFileSync(path.join(agent, 'config.yml'), 'modelRoles:\n  thinkingTranslator: translator-fixture/offline\n')
    writeFileSync(path.join(agent, 'models.yml'), JSON.stringify({ providers: { 'translator-fixture': {
      baseUrl: `http://127.0.0.1:${provider.address().port}/v1`, apiKey: 'offline-fixture', api: 'openai-completions',
      models: [{ id: 'offline', name: 'Offline', reasoning: false, input: ['text'], contextWindow: 16384, maxTokens: 4096,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
    } } }))
    const input = {
      model: 'translator-fixture/offline', text: 'Inspect the actual request and preserve existing history.', budget: 8192,
      history: Array.from({ length: 9 }, (_, index) => ({ role: index % 2 ? 'assistant' : 'user', text: `recent-${index}:` + '上下文'.repeat(500) })),
    }
    const deltas = []
    await streamReasoningTranslation(input, AbortSignal.timeout(30_000), async delta => { deltas.push(delta) })
    assert.equal(deltas.join(''), '这是中文译文')
    assert.equal(requests.length, 1)
    const user = requests[0].messages.find(message => message.role === 'user')
    const content = typeof user.content === 'string' ? user.content : user.content.map(part => part.text ?? '').join('')
    const payload = JSON.parse(content)
    assert.equal(payload.excerpt, input.text)
    assert.ok(payload.priorConversation.length > 0 && payload.priorConversation.length < input.history.length)
    assert.match(payload.priorConversation.at(-1).text, /^recent-8:/)
    assert.doesNotMatch(payload.priorConversation[0].text, /^recent-0:/)

    const count = requests.length
    await assert.rejects(streamReasoningTranslation({ ...input, model: 'translator-fixture/other' }, AbortSignal.timeout(30_000), async () => {}), /translator-not-configured/)
    assert.equal(requests.length, count)
    stage = 'failure'
    await assert.rejects(streamReasoningTranslation(input, AbortSignal.timeout(30_000), async () => {}), /translation-failed/)
    stage = 'abort'
    const controller = new AbortController()
    await assert.rejects(streamReasoningTranslation(input, controller.signal, async () => { controller.abort() }))
    assert.deepEqual(readFileSync(sessionFile), sessionBytes)
    assert.equal(statSync(sessionFile).mtimeMs, sessionMtime)
    console.info('PASS: native translator streaming, context budget, configured-role enforcement, failure, cancellation and unchanged session history')
  } finally {
    provider.closeAllConnections()
    await new Promise(resolve => provider.close(resolve))
    for (const key of keys) {
      if (previous[key] === undefined) delete process.env[key]
      else process.env[key] = previous[key]
    }
    try { rmSync(root, { recursive: true, force: true }) }
    catch (error) { console.warn(`WARN: translator fixture cleanup deferred: ${error.code}`) }
  }
}
