import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { OmpRpcSession } from '../packages/omp-worker/dist/omp/omp-session.js'
import { getOmpSettings, patchOmpSettings } from '../packages/omp-worker/dist/omp/omp-settings.js'

// 只在 CI 使用隔离配置与本机模拟 provider，验证官方 runtime 实际执行清理和压缩。
const root = mkdtempSync(path.join(tmpdir(), 'ompiui-context-'))
const envKeys = ['PI_CODING_AGENT_DIR', 'OMPIUI_DATA_DIR', 'OMP_PROFILE', 'PI_PROFILE', 'OMPIUI_AUTO_TITLE_ENABLED']
const previous = Object.fromEntries(envKeys.map(key => [key, process.env[key]]))
process.env.PI_CODING_AGENT_DIR = path.join(root, 'agent')
process.env.OMPIUI_DATA_DIR = path.join(root, 'ui')
process.env.OMPIUI_AUTO_TITLE_ENABLED = '0'
delete process.env.OMP_PROFILE
delete process.env.PI_PROFILE
const cwd = path.join(root, 'workspace')
mkdirSync(cwd, { recursive: true })
mkdirSync(process.env.PI_CODING_AGENT_DIR, { recursive: true })
const readPath = path.join(cwd, 'sample.txt')
writeFileSync(readPath, Array.from({ length: 100 }, (_, i) => `record ${i}: original implementation details for the context maintenance fixture`).join('\n'))
let stage = 'first-read'
let calls = 0
const requests = []
const provider = createServer(async (request, response) => {
  try {
    let text = ''
    for await (const chunk of request) text += chunk
    const body = JSON.parse(text)
    requests.push({ stage, body })
    const tool = stage !== 'compact' && calls++ === 0
    const delta = tool ? { role: 'assistant', tool_calls: [{ index: 0, id: `read-${stage}`, type: 'function', function: { name: 'read', arguments: JSON.stringify({ path: readPath }) } }] }
      : { role: 'assistant', content: stage === 'compact' ? 'Context summary: the sample file was read and updated. Continue the requested work using the latest file content.' : 'The file has been read.' }
    const frame = { id: `context-${requests.length}`, object: 'chat.completion.chunk', created: 1, model: 'offline', choices: [{ index: 0, delta, finish_reason: null }] }
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    response.write(`data: ${JSON.stringify(frame)}\n\n`)
    response.write(`data: ${JSON.stringify({ ...frame, choices: [{ index: 0, delta: {}, finish_reason: tool ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: stage === 'compact' ? 1200 : 45000, completion_tokens: 30, total_tokens: stage === 'compact' ? 1230 : 45030 } })}\n\n`)
    response.end('data: [DONE]\n\n')
  } catch (error) { response.writeHead(500); response.end(String(error)) }
})
await new Promise(resolve => provider.listen(0, '127.0.0.1', resolve))
const agent = process.env.PI_CODING_AGENT_DIR
writeFileSync(path.join(agent, 'models.yml'), JSON.stringify({ providers: { fixture: {
  baseUrl: `http://127.0.0.1:${provider.address().port}/v1`, apiKey: 'offline-fixture', api: 'openai-completions',
  models: [{ id: 'offline', name: 'Offline', reasoning: false, input: ['text'], contextWindow: 128000, maxTokens: 4096, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
} } }))
writeFileSync(path.join(agent, 'config.yml'), 'modelRoles:\n  default: fixture/offline\n  smol: fixture/offline\n  tiny: fixture/offline\ncompaction:\n  asyncEnabled: false\n  methodOrder: [soft]\n  keepRecentTokens: 1024\n')
let session
try {
  const settings = await getOmpSettings(cwd)
  assert.equal(settings.effective.compaction.supersedeReads, true)
  assert.equal(settings.effective.compaction.dropUseless, true)
  assert.equal(settings.effective.compaction.enabled, true)
  session = await OmpRpcSession.open(cwd)
  const file = session.getSessionFile()
  const id = session.getSessionId()
  await session.sendUserMessage('Read sample.txt and report what it contains.')
  await session.waitForIdle()
  const first = await session.getBranchPage(undefined, 100, 2 * 1024 * 1024)
  assert.match(JSON.stringify(first), /original implementation details/)
  stage = 'second-read'; calls = 0
  writeFileSync(readPath, 'The file is now updated.\n' + 'Keep the updated implementation with its verified behavior and current configuration.\n'.repeat(200))
  await session.sendUserMessage('Read sample.txt again; its contents have changed.')
  await session.waitForIdle()
  const state = await session.getState()
  assert.equal(state.contextMaintenance.supersedeReads, true)
  assert.ok(state.contextMaintenance.prunedResults >= 1, 'Official per-turn pruning must actually run below the summary threshold')
  const branch = await session.getBranchPage(undefined, 100, 2 * 1024 * 1024)
  const oldRead = branch.items.find(entry => entry.type === 'message' && entry.message?.toolCallId === 'read-first-read')
  assert.ok(oldRead?.message.prunedAt, 'GUI must carry the native pruning marker on the original result')
  assert.doesNotMatch(JSON.stringify(oldRead.message.content), /original implementation details/, 'GUI context content must replace the old same-ID result')
  // 官方保留 details.displayContent 供历史展示，真正送入模型的是已清理的 content。
  const persistedRead = readFileSync(file, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line)).find(entry => entry.id === oldRead.id)
  assert.deepEqual(oldRead.message.content, persistedRead.message.content, 'Official persisted context and GUI context must agree')
  await session.setAutoCompaction(false)
  assert.equal((await session.getState()).compaction.autoEnabled, false)
  await session.dispose(); session = undefined

  await patchOmpSettings(cwd, { 'compaction.thresholdTokens': 40000 })
  stage = 'compact'; calls = 0
  session = await OmpRpcSession.open(cwd, file)
  assert.equal(session.getSessionId(), id)
  const events = []
  session.onPiEvent(event => events.push(event))
  assert.equal((await session.getState()).contextMaintenance.thresholdTokens, 40000)
  await session.sendUserMessage('Continue with the updated file after automatic context maintenance.')
  await session.waitForIdle()
  const final = await session.getState()
  assert.ok(events.some(event => event.type === 'compaction_start' && event.reason === 'threshold'), 'Native threshold must trigger automatic compaction')
  assert.ok(events.some(event => event.type === 'compaction_end' && !event.errorMessage && !event.aborted), 'Automatic compaction must complete')
  assert.match(readFileSync(file, 'utf8'), /"type":"compaction"/)
  assert.equal(final.isSettled, true)
  assert.ok(requests.filter(request => request.stage === 'compact').length >= 2, 'Summary and continued conversation must both reach the provider')
  assert.ok(requests.filter(request => request.stage === 'compact').every(request =>
    !JSON.stringify(request.body.messages).includes('original implementation details')), 'Pruned original text must not return to the provider on continuation')
  console.info('PASS: native per-turn pruning, same-ID GUI history updates, native off state, 40k automatic summary, and continued same-file conversation')
} finally {
  await session?.dispose()
  provider.closeAllConnections()
  await new Promise(resolve => provider.close(resolve))
  for (const key of envKeys) {
    if (previous[key] === undefined) delete process.env[key]
    else process.env[key] = previous[key]
  }
  rmSync(root, { recursive: true, force: true })
}
