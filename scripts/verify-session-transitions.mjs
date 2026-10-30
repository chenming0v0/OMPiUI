import assert from 'node:assert/strict'
import { readFileSync, statSync } from 'node:fs'
import { setTimeout as delay } from 'node:timers/promises'
import { OmpRpcSession } from '../packages/omp-worker/src/omp/omp-session.ts'
import { detectOmpVersion } from '../packages/omp-worker/src/omp/omp-version.ts'
import { createTransitionFixture, nativeEntries, messageText, testImage } from './session-transition-fixture.mjs'

const historyOnly = process.argv.includes('--history-only')
const localIsolation = process.argv.includes('--local-isolation')
const requireSourceAttribution = process.argv.includes('--require-source-attribution')
if (process.argv.slice(2).some(arg => !['--history-only', '--local-isolation', '--require-source-attribution'].includes(arg)) || (historyOnly && (localIsolation || requireSourceAttribution)) || (localIsolation && requireSourceAttribution)) throw new Error('Usage: verify-session-transitions.mjs [--history-only | --local-isolation | --require-source-attribution]')
const fixture = await createTransitionFixture()
const evidence = { root: fixture.root, ompVersion: await detectOmpVersion(), provider: 'deterministic loopback only', checks: [], extensionError: null }
let session
const snapshot = file => ({ bytes: readFileSync(file), mtime: statSync(file).mtimeMs })
const unchanged = (file, before) => { assert.deepEqual(readFileSync(file), before.bytes); assert.equal(statSync(file).mtimeMs, before.mtime) }
try {
  session = await OmpRpcSession.open(fixture.cwd)
  const rawErrors = [], sessionErrors = [], diagnostics = []
  session.onPiEvent(event => { if (event.type === 'extension_error') sessionErrors.push(event) })
  session.onExtensionDiagnostic(event => diagnostics.push(event))
  // Inspect the actual native wire, before OMPiUI adds its consumer epoch.
  session.client.on('frame', frame => { if (frame.type === 'extension_error') rawErrors.push(frame) })
  async function send(text, images) { await session.sendUserMessage(text, images); await session.waitForIdle() }
  await send('first question')
  await send('image question', [testImage])
  await send('third question')
  const id = session.getSessionId(), file = session.getSessionFile()
  const entries = nativeEntries(file)
  const imageUser = entries.find(entry => entry.message?.role === 'user' && messageText(entry) === 'image question')
  const tip = entries.filter(entry => entry.type === 'message').at(-1)
  const firstAssistant = entries.find(entry => entry.message?.role === 'assistant')
  assert.ok(imageUser && tip && firstAssistant)
  const storedImage = imageUser.message.content.find(block => block.type === 'image')
  assert.ok(storedImage?.data, 'native persisted image missing')
  const stable = snapshot(file)
  await session.getState(); await session.getTree(); await session.getBranchPage(undefined, 100, 1024 * 1024); await session.getEntriesPage(undefined, 100, 1024 * 1024)
  unchanged(file, stable)
  evidence.checks.push('read-only state/tree/branch/entries preserve bytes and mtime')

  await assert.rejects(session.navigateTree('missing-entry'))
  unchanged(file, stable)
  fixture.setControl({ cancel: 'session_before_tree' })
  assert.equal((await session.navigateTree(imageUser.id)).cancelled, true)
  unchanged(file, stable)
  assert.equal(session.getSessionId(), id)
  fixture.setControl({})
  const undo = await session.navigateTree(imageUser.id)
  assert.equal(undo.cancelled, false)
  assert.equal(undo.editorText, 'image question')
  assert.equal(undo.editorImages?.[0]?.data, storedImage.data)
  assert.equal(undo.leafId, imageUser.parentId)
  assert.equal(session.getSessionId(), id); assert.equal(session.getSessionFile(), file)
  assert.ok(nativeEntries(file).some(entry => entry.id === tip.id))
  evidence.checks.push('invalid/cancelled navigation preserves source; user Undo restores native text/image and parent context')

  await send('alternate after Undo')
  const alternate = nativeEntries(file).filter(entry => entry.type === 'message').at(-1)
  const alternateUser = nativeEntries(file).find(entry => entry.message?.role === 'user' && messageText(entry) === 'alternate after Undo')
  assert.equal(alternateUser.parentId, imageUser.parentId)
  assert.equal(session.getSessionId(), id); assert.equal(session.getSessionFile(), file)
  const alternateContext = fixture.requests.at(-1).messages.filter(message => message.role === 'user').map(message => typeof message.content === 'string' ? message.content : message.content.filter(block => block.type === 'text').map(block => block.text).join('\n'))
  assert.ok(alternateContext.some(text => text.endsWith('first question')))
  assert.ok(!alternateContext.includes('image question')); assert.ok(!alternateContext.includes('third question'))
  evidence.checks.push('Undo then new send creates a sibling in the same id/file and uses only parent context')

  await session.navigateTree(tip.id)
  assert.equal((await session.getState()).head.leafId, tip.id)
  await session.navigateTree(alternate.id)
  assert.equal((await session.getState()).head.leafId, alternate.id)
  await session.navigateTree(firstAssistant.id)
  assert.equal(session.getSessionId(), id); assert.equal(session.getSessionFile(), file)
  await session.navigateTree(tip.id)
  const tree = await session.getTree()
  const ids = []; const stack = [...tree]
  while (stack.length) { const node = stack.pop(); ids.push(node.entry.id); stack.push(...node.children) }
  assert.ok(ids.includes(tip.id) && ids.includes(alternate.id))
  evidence.checks.push('switch between both native child branches; both remain in the same tree')

  let source = snapshot(file)
  fixture.setControl({ cancel: 'session_before_branch' })
  assert.equal((await session.fork(imageUser.id, 'before')).cancelled, true)
  unchanged(file, source)
  fixture.setControl({})
  const beforeFork = await session.fork(imageUser.id, 'before')
  assert.notEqual(beforeFork.targetSessionId, id); assert.notEqual(beforeFork.targetSessionFile, file)
  assert.equal(beforeFork.selectedText, 'image question')
  assert.equal(beforeFork.selectedImages?.[0]?.data, storedImage.data)
  unchanged(file, source)
  await send('continue before fork', beforeFork.selectedImages)
  const forkFile = session.getSessionFile()
  assert.ok(!nativeEntries(forkFile).some(entry => messageText(entry) === 'third question'))
  await session.switchSession(file)
  assert.equal(session.getSessionId(), id)
  source = snapshot(file)
  const atFork = await session.fork(imageUser.id, 'at')
  assert.notEqual(atFork.targetSessionId, id); assert.notEqual(atFork.targetSessionFile, file)
  unchanged(file, source)
  await send('continue inclusive fork')
  assert.ok(nativeEntries(session.getSessionFile()).some(entry => entry.message?.role === 'user' && messageText(entry) === 'image question'))
  assert.ok(!nativeEntries(session.getSessionFile()).some(entry => messageText(entry) === 'third question'))
  evidence.checks.push('before/at Fork use new id/file, preserve source, exclude/include selected image message respectively')

  await session.switchSession(file)
  await session.manageGoal({ op: 'create', objective: 'source paused goal' })
  await session.manageGoal({ op: 'pause' })
  const goal = (await session.getState()).goal
  assert.equal(goal.objective, 'source paused goal')
  fixture.setControl({ cancel: 'session_before_switch' })
  const cancelled = await session.newSession()
  assert.equal(cancelled.cancelled, true)
  assert.equal((await session.getState()).goal.objective, 'source paused goal')
  fixture.setControl({})
  if (!historyOnly) {
    await session.sendUserMessage('/isolation-late-error')
    await delay(150)
  }
  const replaced = await session.newSession()
  assert.equal(replaced.cancelled, false)
  assert.notEqual(session.getSessionId(), id)
  assert.equal((await session.getState()).goal, null)
  assert.deepEqual((await session.getState()).subagents, [])
  if (!historyOnly) {
    fixture.setControl({ release: true })
    for (let attempt = 0; attempt < 100 && !rawErrors.length; attempt++) await delay(50)
    assert.ok(rawErrors.length, 'Native delayed extension error was not observed')
    const oldError = rawErrors.at(-1)
    await delay(100) // Drain the normal pi.event buffer before checking absence.
    assert.equal(sessionErrors.length, 0, 'Unattributed extension error entered a session stream')
    assert.deepEqual(diagnostics.at(-1), oldError, 'Native error was not retained in host diagnostics')
    evidence.extensionError = { sourceSessionId: id, currentSessionId: session.getSessionId(), rawFrame: oldError, hasSourceIdentity: typeof oldError.sessionId === 'string' || typeof oldError.sourceSessionId === 'string', sessionErrorCount: sessionErrors.length, diagnosticCount: diagnostics.length }
    evidence.checks.push('real delayed callback error remains visible in host diagnostics and never enters a session stream')
  }
  // Host isolation does not recover the source identity still missing upstream.
  evidence.checks.push('cancelled new preserves source goal; committed new clears it and restores source goal on switch back')
  await session.switchSession(file)
  assert.equal((await session.getState()).goal.objective, 'source paused goal')
  evidence.status = historyOnly ? 'HISTORY_PASS_ISOLATION_NOT_RUN' : requireSourceAttribution
    ? 'LOCAL_ISOLATION_PASS_SOURCE_ATTRIBUTION_NOT_VERIFIED' : 'HISTORY_AND_HOST_ISOLATION_PASS'
  fixture.save('evidence.json', evidence)
  fixture.save('provider-requests.json', fixture.requests)
  console.info(JSON.stringify(evidence, null, 2))
  if (requireSourceAttribution) {
    console.error(evidence.extensionError.hasSourceIdentity
      ? 'ADDITIONAL CHECK UNVERIFIED: source fields appeared; precise routing requires separate verification. Host isolation passed.'
      : 'ADDITIONAL CHECK UNAVAILABLE: official source attribution is missing. Host isolation passed; this is not target-session pollution.')
    process.exitCode = 2
  } else if (!historyOnly) {
    console.info('PASS: history and host-error isolation verified for the agreed #361 scope. Precise source attribution is not established.')
  }
} catch (error) {
  evidence.status = 'FAILED'; evidence.error = String(error)
  fixture.save('evidence.json', evidence)
  console.error(error); console.error(`Evidence retained at ${fixture.root}`)
  process.exitCode = 1
} finally {
  await session?.dispose()
  await fixture.close()
}
