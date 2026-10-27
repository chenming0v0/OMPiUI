import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdirSync, writeFileSync, appendFileSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'

assert.equal(process.platform, 'win32')
assert.equal(process.env.GITHUB_ACTIONS, 'true', 'This provider is only for disposable hosted Windows upgrade smoke')
assert.equal(process.env.RUNNER_ENVIRONMENT, 'github-hosted')
const root = resolve(process.env.SMOKE_ROOT)
assert.equal(root, resolve(process.env.RUNNER_TEMP, `ompiui-upgrade-${process.env.GITHUB_RUN_ID}`))
assert.ok(root.startsWith(resolve(process.env.RUNNER_TEMP) + sep))
const agent = join(root, 'agent')
const evidence = join(root, 'evidence')
mkdirSync(agent, { recursive: true })
mkdirSync(evidence, { recursive: true })
const marker = 'Persist this real GUI upgrade smoke conversation in the original project.'
// This is an explicitly owned, deterministic HTTP test provider, not a claim
// about a real vendor/model/account. It exists only to let official OMP write
// a real new conversation after the installer upgrade, without user credentials.
const server = createServer(async (request, response) => {
  try {
    if (request.method !== 'POST' || request.url !== '/v1/chat/completions') {
      response.writeHead(404).end()
      return
    }
    const chunks = []
    let size = 0
    for await (const chunk of request) {
      size += chunk.length
      if (size > 8 * 1024 * 1024) throw new Error('Unexpected oversized smoke prompt')
      chunks.push(chunk)
    }
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    const messages = JSON.stringify(body.messages)
    appendFileSync(join(evidence, 'local-provider-requests.jsonl'), JSON.stringify({
      at: new Date().toISOString(), model: body.model, messages: body.messages, stream: body.stream,
    }) + '\n')
    // /changelog may be a native command or, on older RPC paths, a prompt.
    // Respond deterministically to either; acceptance requires the plain
    // marker prompt and its actual persisted native user/assistant entries.
    const reply = messages.includes(marker)
      ? 'Owned disposable HTTP upgrade smoke provider received the real GUI persistence prompt.'
      : 'Owned disposable HTTP upgrade smoke provider received the preliminary command prompt.'
    if (!body.stream) {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ id: `upgrade-${Date.now()}`, object: 'chat.completion', created: Math.floor(Date.now() / 1000), model: 'echo', choices: [{ index: 0, message: { role: 'assistant', content: reply }, finish_reason: 'stop' }] }))
      return
    }
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    const id = `upgrade-${Date.now()}`
    const frame = (delta, finish_reason) => `data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model: 'echo', choices: [{ index: 0, delta, finish_reason }] })}\n\n`
    response.end(frame({ role: 'assistant', content: reply }, null) + frame({}, 'stop') + 'data: [DONE]\n\n')
  } catch (error) {
    appendFileSync(join(evidence, 'local-provider-errors.jsonl'), JSON.stringify({ at: new Date().toISOString(), error: error.message }) + '\n')
    response.writeHead(500).end(error.message)
  }
})
await new Promise(resolvePromise => server.listen(0, '127.0.0.1', resolvePromise))
const baseUrl = `http://127.0.0.1:${server.address().port}/v1`
const modelConfig = { providers: { 'upgrade-local': {
  baseUrl, api: 'openai-completions', apiKey: 'unused-local-smoke-sentinel',
  models: [{ id: 'echo', name: 'Owned disposable upgrade HTTP provider', reasoning: false, input: ['text'],
    contextWindow: 128000, maxTokens: 1024, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
} } }
const settings = { modelRoles: { default: 'upgrade-local/echo' } }
writeFileSync(join(agent, 'models.yml'), JSON.stringify(modelConfig, null, 2) + '\n')
writeFileSync(join(agent, 'config.yml'), JSON.stringify(settings, null, 2) + '\n')
writeFileSync(join(evidence, 'local-provider.json'), JSON.stringify({
  kind: 'deterministic owned local HTTP test provider, not a vendor model or account',
  pid: process.pid, baseUrl, modelConfig, settings, marker,
}, null, 2))
writeFileSync(join(root, 'provider-ready.json'), JSON.stringify({ pid: process.pid, baseUrl }))
console.log(`Owned upgrade HTTP provider ready at ${baseUrl}`)
