import { createServer } from 'node:http'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

// A deterministic loopback provider, not a real provider/account acceptance test.
// Native OMP still owns every message, branch, identity and journal write.
export const testImage = {
  type: 'image', mimeType: 'image/png',
  data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aD1sAAAAASUVORK5CYII=',
}

export async function createTransitionFixture() {
  // Some Windows hosts deny Bun SQLite writes beneath the OS temporary root.
  // Use a fresh ignored workspace directory, never an existing user session.
  const base = path.resolve('.slim', 'transition-acceptance')
  mkdirSync(base, { recursive: true })
  const root = mkdtempSync(path.join(base, 'run-'))
  const agent = path.join(root, 'agent'), cwd = path.join(root, 'workspace')
  const control = path.join(root, 'control.json')
  mkdirSync(agent); mkdirSync(cwd); mkdirSync(path.join(agent, 'extensions'))
  writeFileSync(control, '{}')
  const temp = path.join(root, 'tmp')
  mkdirSync(temp)
  process.env.TEMP = temp
  process.env.TMP = temp
  process.env.TMPDIR = temp
  process.env.HOME = root
  process.env.USERPROFILE = root
  process.env.PI_CODING_AGENT_DIR = agent
  process.env.OMPIUI_DATA_DIR = path.join(root, 'webui')
  for (const key of ['OMP_PROFILE', 'PI_PROFILE', 'PI_CODING_AGENT_SESSION_DIR', 'PI_CONFIG_FILES', 'OMP_AGENT_DIR', 'OMPIUI_OMP_SESSION_DIRS']) delete process.env[key]
  const requests = []
  const endpoint = createServer(async (request, response) => {
    try {
      let body = ''; for await (const chunk of request) body += chunk
      const input = JSON.parse(body)
      requests.push(input)
      writeFileSync(path.join(root, 'provider-requests.json'), JSON.stringify(requests, null, 2) + '\n')
      const users = input.messages.filter(message => message.role === 'user')
      const last = users.at(-1)
      const text = typeof last?.content === 'string' ? last.content : (last?.content ?? []).filter(block => block.type === 'text').map(block => block.text).join('\n')
      const chunk = delta => ({ id: `transition-${requests.length}`, object: 'chat.completion.chunk', created: 1, model: 'offline', choices: [{ index: 0, delta, finish_reason: null }] })
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.write(`data: ${JSON.stringify(chunk({ role: 'assistant', content: `Native reply: ${text}` }))}\n\n`)
      response.write(`data: ${JSON.stringify({ ...chunk({}), choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })}\n\n`)
      response.end('data: [DONE]\n\n')
    } catch (error) { response.writeHead(500); response.end(String(error)) }
  })
  await new Promise(resolve => endpoint.listen(0, '127.0.0.1', resolve))
  writeFileSync(path.join(agent, 'models.yml'), `providers:\n  transition-fixture:\n    baseUrl: http://127.0.0.1:${endpoint.address().port}/v1\n    apiKey: sk-offline-fixture\n    api: openai-completions\n    models:\n      - id: offline\n        name: Offline transition fixture\n        reasoning: false\n        input: [text, image]\n        contextWindow: 128000\n        maxTokens: 4096\n        cost: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0}\n`)
  writeFileSync(path.join(agent, 'config.yml'), 'modelRoles:\n  default: transition-fixture/offline\ntitle:\n  enabled: false\n')
  writeFileSync(path.join(agent, 'extensions', 'transition-checks.js'), `import { readFileSync } from 'node:fs';
const control = ${JSON.stringify(control)};
const flags = () => JSON.parse(readFileSync(control, 'utf8'));
export default function (pi) {
  for (const type of ['session_before_tree', 'session_before_branch', 'session_before_switch']) {
    pi.on(type, () => flags().cancel === type ? { cancel: true } : undefined);
  }
  pi.registerCommand('isolation-late-error', {
    description: 'Isolated acceptance: hold a native extension timer until explicitly released',
    handler: async (_text, ctx) => {
      ctx.setTimeout(async () => {
        while (!flags().release) await new Promise(resolve => setTimeout(resolve, 25));
        throw new Error('isolated extension callback error');
      }, 0);
    },
  });
}
`)
  return {
    root, agent, cwd, requests,
    setControl(value) { writeFileSync(control, JSON.stringify(value)) },
    save(name, value) { writeFileSync(path.join(root, name), JSON.stringify(value, null, 2) + '\n') },
    readControl() { return JSON.parse(readFileSync(control, 'utf8')) },
    async close() { endpoint.closeAllConnections(); await new Promise(resolve => endpoint.close(resolve)) },
  }
}

export function nativeEntries(file) {
  return readFileSync(file, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line))
}

export function messageText(entry) {
  const content = entry.message?.content
  return typeof content === 'string' ? content : (content ?? []).filter(block => block.type === 'text').map(block => block.text).join('\n')
}
