import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { setTimeout as delay } from 'node:timers/promises'
import { pathToFileURL } from 'node:url'
import { createRpcStreamFixture, sha256, RPC_STREAM_PAYLOAD_BYTES, RPC_STREAM_COMMAND, RPC_STREAM_MARKER_COMMAND } from './rpc-stream-fixture.mjs'

async function wait(check, label, timeout = 30000) {
  const end = Date.now() + timeout
  while (Date.now() < end) { const result = check(); if (result) return result; await delay(25) }
  throw new Error(`Timeout: ${label}`)
}
function isError(event) { return event.type === 'rpc_stream_error' || event.type === 'rpc_frame_error' }
function capture(session) {
  const events = [], errors = [], protocolErrors = []
  session.onPiEvent((event, meta) => {
    if (isError(event)) errors.push({ sessionId: session.getSessionId(), event: structuredClone(event), meta: structuredClone(meta) })
    const details = event.message?.details
    events.push({ type: event.type, sessionId: session.getSessionId(), details, text: typeof event.message?.content === 'string' ? event.message.content.slice(0, 160) : null, contentBytes: typeof event.message?.content === 'string' ? Buffer.byteLength(event.message.content) : null, contentSha256: typeof event.message?.content === 'string' ? sha256(event.message.content) : null })
  })
  session.client.on('protocolError', (error, originalType, kind) => protocolErrors.push({ error, originalType, kind }))
  return { events, errors, protocolErrors }
}

export async function verifyRpcStreamErrors({ runtimeDir, drop = false } = {}) {
  const fixture = await createRpcStreamFixture(runtimeDir)
  const evidence = { root: fixture.root, runtime: { version: fixture.runtime.version, bunVersion: fixture.runtime.bunVersion }, nativeBin: fixture.nativeBin, nativeBinarySha256: fixture.nativeBinarySha256, provider: 'deterministic loopback, no user keys or paid requests', status: 'RUNNING', checks: [], scenarios: [] }
  let session, second
  try {
    const { OmpRpcSession } = await import('../packages/omp-worker/src/omp/omp-session.ts')
    const { detectOmpVersion } = await import('../packages/omp-worker/src/omp/omp-version.ts')
    evidence.ompVersion = await detectOmpVersion()
    assert.equal(evidence.ompVersion, fixture.runtime.version)
    const directVersion = spawnSync(fixture.nativeBin, ['--version'], { encoding: 'utf8', timeout: 30000 })
    const proxyVersion = spawnSync(process.execPath, [fixture.proxy, '--version'], { encoding: 'utf8', timeout: 30000 })
    assert.equal(proxyVersion.status, directVersion.status)
    assert.equal(proxyVersion.stdout, directVersion.stdout)
    assert.equal(proxyVersion.stderr, directVersion.stderr)
    evidence.checks.push('proxy --version stdout/stderr/exit match official binary exactly')
    session = await OmpRpcSession.open(fixture.cwd)
    second = await OmpRpcSession.open(fixture.secondCwd)
    const owner = capture(session), other = capture(second)
    for (const target of [session, second]) {
      const catalog = await target.client.request({ type: 'get_available_commands' })
      assert.equal(catalog.success, true)
      assert.ok(catalog.data.commands.some(command => command.name === 'rpc-stream-large'), 'Public extension command was not discovered')
    }
    evidence.sessionId = session.getSessionId(); evidence.secondSessionId = second.getSessionId()
    assert.notEqual(evidence.sessionId, evidence.secondSessionId)
    async function marker(target, observed, tag) {
      await target.sendUserMessage(`${RPC_STREAM_MARKER_COMMAND} ${tag}`)
      await wait(() => observed.events.find(event => event.type === 'message_end' && event.details?.tag === tag), `native marker ${tag}`)
      await target.waitForIdle()
    }
    async function large(target, observed, tag) {
      await target.sendUserMessage(`${RPC_STREAM_COMMAND} ${tag}`)
      const group = await wait(() => fixture.evidence().find(event => event.action === 'native-group' && event.tag === tag && event.originalType === 'message_end'), `actual official rpc_chunk group ${tag}`)
      assert.ok(group.nativeChunkCount > 1, 'No actual official chunks: FAIL, not synthetic acceptance')
      assert.ok(group.byteLength > 1024 * 1024)
      assert.equal(group.sessionId, target.getSessionId())
      assert.equal(group.customType, 'rpc-stream-acceptance')
      await target.waitForIdle()
      return group
    }
    // Mandatory native normal control before any arm. Exercise actual stdout backpressure too.
    session.client.setOutputPaused(true)
    const normalSend = session.sendUserMessage(`${RPC_STREAM_COMMAND} normal`)
    await delay(200); session.client.setOutputPaused(false); await normalSend
    const normal = await wait(() => fixture.evidence().find(event => event.action === 'native-group' && event.tag === 'normal' && event.originalType === 'message_end'), 'normal native chunks')
    assert.ok(normal.nativeChunkCount > 1 && normal.byteLength > 1024 * 1024, 'Native chunking did not occur; acceptance fails')
    const normalEvent = await wait(() => owner.events.find(event => event.type === 'message_end' && event.details?.tag === 'normal'), 'normal decoded native payload')
    assert.equal(normalEvent.contentBytes, RPC_STREAM_PAYLOAD_BYTES)
    const normalPrefix = 'RPC_STREAM_NATIVE normal '
    assert.equal(normalEvent.contentSha256, sha256(normalPrefix + 'x'.repeat(RPC_STREAM_PAYLOAD_BYTES - normalPrefix.length)))
    const normalChunks = fixture.evidence().filter(event => event.action === 'native-rpc-chunk' && event.chunkId === normal.chunkId && event.proxyPid === normal.proxyPid)
    assert.equal(normalChunks.length, normal.nativeChunkCount)
    assert.ok(normalChunks.every(event => event.wireSha256 === event.forwardedWireSha256 && event.mutation === null), 'Normal native wire bytes were changed')
    assert.equal(owner.errors.length, 0)
    assert.equal(normal.sessionId, evidence.sessionId)
    evidence.scenarios.push({ mode: 'normal', group: normal, decoded: normalEvent })
    evidence.checks.push('actual >1MiB official rpc_chunk normal control decodes unchanged, with pause/resume backpressure')

    for (const mode of ['stream', 'frame', ...(drop ? ['drop'] : [])]) {
      const arm = fixture.arm(fixture.cwd, mode)
      // Competing large frame from a different live session must NOT consume the arm.
      const secondTag = `second-while-${mode}-armed`
      const secondGroup = await large(second, other, secondTag)
      assert.equal(secondGroup.mode, 'normal')
      assert.equal(JSON.parse(readFileSync(fixture.control, 'utf8')).arm.id, arm.id)
      await wait(() => other.events.find(event => event.type === 'message_end' && event.details?.tag === secondTag), 'second session decoded normal frame')
      const before = owner.errors.length, protocolBefore = owner.protocolErrors.length, start = Date.now()
      const tag = `fault-${mode}`
      await large(session, owner, tag)
      const damaged = await wait(() => fixture.evidence().find(event => event.action === 'native-group' && event.armId === arm.id), `corrupted actual native group ${mode}`)
      assert.equal(damaged.sessionId, evidence.sessionId)
      assert.equal(damaged.mode, mode)
      assert.ok(damaged.nativeChunkCount > 1)
      const actual = await wait(() => owner.errors[before], `real ${mode} error event`, mode === 'drop' ? 35000 : 10000)
      const pattern = mode === 'stream' ? /length mismatch: got \d+ expected \d+/ : mode === 'frame' ? /not valid UTF-8 or JSON/ : /rpc chunk timed out/
      assert.match(actual.event.error, pattern)
      assert.equal(actual.event.type, mode === 'frame' ? 'rpc_frame_error' : 'rpc_stream_error')
      assert.equal(actual.event.source, 'OMP RPC')
      assert.equal(actual.event.originalType, 'rpc_chunk')
      assert.equal(actual.event.text, actual.event.error)
      assert.equal(actual.sessionId, evidence.sessionId)
      assert.equal(owner.protocolErrors[protocolBefore].error, actual.event.error)
      assert.equal(owner.protocolErrors[protocolBefore].kind, mode === 'frame' ? 'frame' : 'stream')
      if (mode === 'drop') assert.ok(Date.now() - start >= 30000, 'Must wait the unmodified real 30s timeout')
      const chunks = fixture.evidence().filter(event => event.action === 'native-rpc-chunk' && event.armId === arm.id)
      assert.equal(chunks.length, damaged.nativeChunkCount)
      if (mode === 'stream') assert.ok(chunks.every(event => event.mutation?.changed === event.byteLength + 1 && event.mutation?.action === 'byteLength+1'))
      if (mode === 'frame') assert.equal(chunks.filter(event => event.mutation).length, 1)
      await marker(session, owner, `continued-${mode}`)
      await marker(second, other, `second-continued-${mode}`)
      await delay(200)
      assert.equal(owner.errors.length, before + 1, 'Exactly one error per corrupted official group')
      assert.equal(owner.protocolErrors.length, protocolBefore + 1)
      assert.equal(other.errors.length, 0, 'Error leaked to second isolated session')
      assert.ok(!other.events.some(event => event.details?.tag === tag || event.details?.tag === `continued-${mode}`))
      assert.ok(!owner.events.some(event => event.details?.tag === secondTag))
      assert.equal(session.client.hasExited, false)
      evidence.scenarios.push({ mode, arm, group: damaged, mutationChunks: chunks, actualError: actual, protocolError: owner.protocolErrors[protocolBefore], elapsedMs: Date.now() - start })
    }
    evidence.checks.push('one real stream/frame error with exact type/source/error text; native messages continue; simultaneously live second session cannot consume arm or receive errors/messages')
    // Separate listener-only regression. This is NOT native wire-fault evidence.
    const budgetStart = owner.errors.length
    const windowBefore = session.protocolErrorWindowStart
    for (let index = 1; index <= 21; index++) session.client.emit('protocolError', `controlled-budget-${index}`, 'rpc_chunk', index % 2 ? 'frame' : 'stream')
    const allowance = Math.max(0, 20 - evidence.scenarios.filter(scenario => scenario.mode !== 'normal').length)
    await wait(() => owner.errors.length === budgetStart + allowance, 'shared frame/stream budget')
    const budget = owner.errors.slice(budgetStart)
    assert.equal(budget.length, allowance)
    assert.match(budget.at(-1).event.text, /further protocol errors suppressed for 60s/)
    session.protocolErrorWindowStart = Date.now() - 60001
    session.client.emit('protocolError', 'controlled-budget-new-window', 'rpc_chunk', 'stream')
    await wait(() => owner.errors.length === budgetStart + allowance + 1, 'budget restored after 60s window')
    assert.equal(owner.errors.at(-1).event.text, 'controlled-budget-new-window')
    assert.equal(other.errors.length, 0)
    evidence.controlledListenerBudget = { classification: 'controlled listener regression only; not actual native corruption evidence', priorNativeErrors: 20 - allowance, attempted: 21, delivered: budget.length, finalInWindow: budget.at(-1), restored: owner.errors.at(-1), windowBefore }
    evidence.nativeChunkCount = fixture.evidence().filter(event => event.action === 'native-rpc-chunk').length
    assert.ok(evidence.nativeChunkCount > 0)
    evidence.providerRequestCount = fixture.requests.length
    assert.equal(fixture.requests.length, 0, 'Public commands must not start a model turn')
    evidence.status = 'NATIVE_PASS_GUI_NOT_RUN'
    fixture.save('rpc-stream-acceptance.json', evidence)
    console.info(JSON.stringify({ status: evidence.status, root: fixture.root, sessionId: evidence.sessionId, secondSessionId: evidence.secondSessionId, nativeChunkCount: evidence.nativeChunkCount, scenarios: evidence.scenarios.map(({ mode, group, actualError }) => ({ mode, nativeChunkCount: group.nativeChunkCount, byteLength: group.byteLength, originalType: group.originalType, actualError })), controlledListenerBudget: { delivered: budget.length, restored: true }, providerRequestCount: fixture.requests.length }, null, 2))
    return evidence
  } catch (error) {
    evidence.status = 'FAILED'; evidence.error = String(error); evidence.wire = fixture.evidence()
    fixture.save('rpc-stream-acceptance.json', evidence)
    console.error(`RPC_STREAM_FAILURE ${fixture.root}`)
    throw error
  } finally {
    await second?.dispose(); await session?.dispose(); await fixture.close()
    const wire = fixture.evidence()
    fixture.save('rpc-stream-wire-summary.json', { nativeChunkCount: wire.filter(event => event.action === 'native-rpc-chunk').length, wire })
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2)
  if (args.includes('--help')) console.info('Usage: node --import tsx scripts/verify-rpc-stream-errors.mjs [--runtime-dir DIR] [--drop]\nNative direct acceptance only; does NOT start the app server. --drop waits the real 30s timeout.')
  else {
    let runtimeDir, drop = false
    for (let index = 0; index < args.length; index++) {
      if (args[index] === '--drop' && !drop) drop = true
      else if (args[index] === '--runtime-dir' && !runtimeDir && args[index + 1] && !args[index + 1].startsWith('--')) runtimeDir = args[++index]
      else throw new Error('Usage: verify-rpc-stream-errors.mjs [--runtime-dir DIR] [--drop]')
    }
    await verifyRpcStreamErrors({ runtimeDir, drop })
  }
}
