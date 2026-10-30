import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { createSubagentCompatFixture, entries, journalStamps, sha256 } from './subagent-compat-fixture.mjs'
import { deriveTaskOutcome } from '../packages/app/src/omp/taskOutcome.ts'

// Run only after the coordinator's observation/ambiguous-evidence changes are
// ready: node --import tsx scripts/verify-subagent-compat.mjs [--runtime-dir DIR].
// This starts a local MODEL TEST FIXTURE, not a dev server. GUI preview is separate.
const args = process.argv.slice(2)
if (args.includes('--help')) {
  console.info('node --import tsx scripts/verify-subagent-compat.mjs [--runtime-dir DIR] [--merge-only]\n--merge-only isolates task/yield + the one native merge when diagnosing observer prerequisites.\nRuns real managed rpc-ui OMP 18.12.6 task, structured yield, IRC warm reuse and one native Git branch conflict, against a local deterministic provider. No GUI state injection, downloads or merge retry. Evidence is retained under the printed isolated root. Launch GUI only with preview_start isolated-subagent-compat.')
  process.exit(0)
}
const mergeOnly = args.includes('--merge-only')
const options = args.filter(arg => arg !== '--merge-only')
if (options.length && (options.length !== 2 || options[0] !== '--runtime-dir')) throw new Error('Usage: [--runtime-dir DIR] [--merge-only]')
const fixture = await createSubagentCompatFixture(options[1])
const { OmpRpcSession } = await import('../packages/omp-worker/src/omp/omp-session.ts')
const sessions = [], frames = [], parentEvents = [], observations = [], checks = []
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const report = { fixture: path.join(fixture.root, 'subagent-compat-fixture.json'), runtime: fixture.runtime, checks, status: 'RUNNING', GUI: 'Not asserted by CLI; use the regular preview server and deliberate GUI commands' }
console.info(`SUBAGENT_COMPAT_FIXTURE ${fixture.root}`)
function providerRecords() { return entries(fixture.providerEvidence) }
async function until(label, predicate, ms = 35000) {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) { const result = await predicate(); if (result) return result; await sleep(50) }
  throw new Error(`Timed out: ${label}; provider=${JSON.stringify(fixture.requests.slice(-5))}`)
}
async function open(cwd, scenario) {
  const session = await OmpRpcSession.open(cwd)
  sessions.push(session)
  session.onCrash(error => { throw error })
  session.onPiEvent(event => parentEvents.push({ scenario, time: Date.now(), event }))
  session.onSubagentFrame(frame => {
    frames.push({ scenario, time: Date.now(), frame })
    if (frame.kind === 'observation') observations.push({ scenario, time: Date.now(), ...frame.payload })
  })
  return session
}
const run = async session => (await session.getState()).subagents?.find(item => item.id === 'OrderingChild')
try {
  // Structured yield is intentionally separate from the historical native
  // async-prose race: don't alter that producer's completion semantics.
  const structured = await open(fixture.structuredCwd, 'structured')
  await structured.prompt('COMPAT_YIELD_SPAWN')
  await structured.waitForIdle()
  const structuredEnd = await until('real structured task result', () => parentEvents.find(item => item.scenario === 'structured' && item.event.type === 'tool_execution_end' && item.event.toolName === 'task'))
  assert.equal(structuredEnd.event.result.details.results[0].exitCode, 0)
  assert.ok(frames.some(item => item.scenario === 'structured' && item.frame.kind === 'event' && item.frame.payload.event?.type === 'tool_execution_end' && item.frame.payload.event.toolName === 'yield'), 'Native child really executes yield')
  checks.push({ name: 'structured native task/yield', passed: true })

  let ordering, first
  if (!mergeOnly) {
  ordering = await open(fixture.orderingCwd, 'ordering')
  await ordering.prompt('COMPAT_ORDER_SPAWN')
  await until('initial native child complete', () => frames.some(item => item.scenario === 'ordering' && item.frame.kind === 'lifecycle' && item.frame.payload.id === 'OrderingChild' && item.frame.payload.status === 'completed'))
  await ordering.waitForIdle()
  first = await run(ordering)
  assert.ok(first.sessionFile)
  await ordering.prompt('COMPAT_WAKE_ONE')
  await until('old real native bash gate', () => entries(fixture.evidence).some(item => item.kind === 'native-bash-gate-start' && item.gate === 'old'))
  await until('old response with pending async', () => fixture.requests.some(item => item.child && /COMPAT_WAKE_ONE/.test(item.lastUser)) && frames.some(item => item.scenario === 'ordering' && JSON.stringify(item.frame).includes('REAL_OLD_TURN_WITH_PENDING_ASYNC')))
  // Pending child async work is deliberate: wait for the parent's turn, not
  // global quiescence (which would deadlock the gate before the second wake).
  await until('parent wake-one turn ended', async () => (await ordering.getState()).isStreaming === false)
  await ordering.prompt('COMPAT_WAKE_TWO')
  await until('new child provider held', () => providerRecords().some(item => item.kind === 'provider-gate-held' && item.gate === 'new'))
  const current = await until('same-owner restart observed running', async () => { const value = await run(ordering); return value?.isFollowUp && value.activity === 'running' ? value : undefined })
  assert.notEqual(current.runId, first.runId)
  assert.equal(current.sessionFile, first.sessionFile, 'Warm reuse keeps the original native child journal')
  assert.equal(current.parentToolCallId, first.parentToolCallId)
  const newStart = frames.findLastIndex(item => item.scenario === 'ordering' && item.frame.kind === 'lifecycle' && item.frame.payload.status === 'started')
  fixture.release('old')
  await until('old gate really exited', () => entries(fixture.evidence).some(item => item.kind === 'native-bash-gate-exit' && item.gate === 'old'))
  await until('old identityless terminal retained as unassigned', () => frames.slice(newStart + 1).some(item => item.scenario === 'ordering' && item.frame.kind === 'unassigned' && item.frame.payload.evidence?.status === 'completed'))
  const afterOld = await run(ordering)
  assert.equal(afterOld.runId, current.runId)
  assert.equal(afterOld.status, 'running', 'Old identityless terminal cannot complete the current same-owner run')
  assert.equal(afterOld.activity, 'running')
  assert.ok(afterOld.unassignedTerminals?.length, 'Preserve ambiguous native evidence, not a silently dropped terminal')
  assert.ok(observations.some(item => item.scenario === 'ordering' && item.activity === 'running'))
  fixture.release('new')
  await until('new real child reply', () => frames.some(item => item.scenario === 'ordering' && JSON.stringify(item.frame).includes('REAL_NEW_REPLY_AFTER_OLD_TERMINAL')))
  const idle = await until('native live session observer idle', async () => { const value = await run(ordering); return value?.activity === 'idle' && value.pendingAsync === false ? value : undefined })
  assert.notEqual(idle.status, 'completed', 'Activity is not authoritative task completion or merge success')
  assert.ok(observations.some(item => item.scenario === 'ordering' && item.activity === 'idle' && !item.pendingAsync))
  const disk = readFileSync(first.sessionFile, 'utf8')
  for (const marker of ['REAL_INITIAL_CHILD_REPLY', 'REAL_OLD_TURN_WITH_PENDING_ASYNC', 'REAL_NEW_REPLY_AFTER_OLD_TERMINAL']) assert.ok(disk.includes(marker), `Original native journal contains ${marker}`)
  checks.push({ name: 'real IRC warm reuse; late terminal ambiguous; observer running/idle; new reply', passed: true, first, current, afterOld, idle, childJournal: first.sessionFile })
  await ordering.waitForIdle()
  }

  const merge = await open(fixture.mergeCwd, 'merge')
  await merge.prompt('COMPAT_MERGE_SPAWN')
  await until('native isolated child write and controlled parent divergence', () => providerRecords().some(item => item.kind === 'parent-diverged') && providerRecords().some(item => item.kind === 'provider-gate-held' && item.gate === 'merge'))
  fixture.release('merge')
  await merge.waitForIdle()
  const mergeEnd = await until('native parent task result after one merge', () => parentEvents.find(item => item.scenario === 'merge' && item.event.type === 'tool_execution_end' && item.event.toolName === 'task'))
  const result = mergeEnd.event.result.details.results.find(item => item.id === 'MergeChild')
  assert.equal(result.exitCode, 0, 'Child execution succeeded even though its parent merge conflicted')
  assert.equal(result.aborted, false)
  for (const key of ['mergeError', 'changesApplied', 'mergeOutcome']) assert.equal(Object.hasOwn(result, key), false, `OMP 18.12.6 lacks authoritative ${key}`)
  const nativeState = await merge.getState(), parentEntries = entries(nativeState.sessionFile)
  const persistedResult = parentEntries.find(item => item.message?.role === 'toolResult' && item.message.toolName === 'task').message.details.results.find(item => item.id === 'MergeChild')
  assert.deepEqual(persistedResult, result, 'Native parent disk and public task result agree')
  // Read the real Git index/recovery state; never retry the native cherry-pick.
  const unmerged = fixture.git(fixture.mergeCwd, ['ls-files', '-u'])
  assert.ok(fixture.git(fixture.mergeCwd, ['branch', '--list']).includes(result.branchName), 'Native recovery branch is retained')
  assert.equal(fixture.git(fixture.mergeCwd, ['show', 'HEAD:conflict.txt']), 'parent\n')
  assert.equal(fixture.git(fixture.mergeCwd, ['show', `${result.branchName}:conflict.txt`]), 'child\n')
  // Native libgit may roll back the conflicted index. The three-argument
  // merge-tree is a read-only conflict calculation, NOT a cherry-pick/merge
  // retry; it writes no recovery refs, worktree or index.
  const conflictProof = fixture.git(fixture.mergeCwd, ['merge-tree', result.branchBaseSha, 'HEAD', result.branchName])
  assert.ok(conflictProof.includes('changed in both') && conflictProof.includes('conflict.txt') && conflictProof.includes('<<<<<<<'), 'Preserved real branches have an actual same-line Git conflict')
  const nativeSummary = mergeEnd.event.result.content.filter(item => item.type === 'text').map(item => item.text).join('\n')
  assert.ok(nativeSummary.includes('Branch merge failed:'), 'Actual native TaskTool attempted its one merge and reported failure; summary is diagnostic evidence only')
  const projection = deriveTaskOutcome(result, mergeEnd.event.result.details)
  assert.equal(projection.executionStatus, 'completed')
  assert.equal(projection.mergeStatus, 'unconfirmed')
  assert.equal(projection.presentationStatus, 'unknown')
  checks.push({ name: 'actual native branch conflict: exit0 and absent merge projection stay UI unconfirmed', passed: true, parentJournal: nativeState.sessionFile, result, projection, unmerged, conflictProof, nativeSummary, indexNote: 'Native libgit can roll back its conflicted index; retained branch blobs and read-only merge-tree prove the conflict. No merge is retried.' })

  // Quiescent browsing-equivalent reads: no prompts, runtime creation or writes.
  // GUI refresh must additionally verify the regular server diagnostics; this
  // CLI hash check never claims to have exercised a browser refresh.
  await sleep(1500)
  const before = journalStamps(path.join(fixture.agent, 'sessions')), requestCount = fixture.requests.length
  const agentStarts = parentEvents.filter(item => item.event.type === 'agent_start').length
  for (const session of sessions) await session.getState()
  if (ordering) await ordering.getSubagentMessages({ sessionFile: first.sessionFile, fromByte: 0 })
  await sleep(1500)
  const after = journalStamps(path.join(fixture.agent, 'sessions'))
  assert.deepEqual(after, before, 'Quiescent read/snapshot must not mutate native journals')
  assert.equal(fixture.requests.length, requestCount, 'Quiescent reads do not request a model turn')
  assert.equal(parentEvents.filter(item => item.event.type === 'agent_start').length, agentStarts, 'Quiescent reads do not prompt native agents')
  assert.equal(sessions.length, mergeOnly ? 2 : 3, 'Only deliberate scenario opens create runtimes')
  checks.push({ name: 'quiescent read/snapshot integrity (not browser refresh)', passed: true, before, after, requestCount, agentStarts, deliberateRuntimeOpenCount: sessions.length, GUIProcedure: 'Before/after regular page reload: compare native JSONL stamps, provider-request count, session.attached and worker.request.started commands session.open/prompt/sendUserMessage; no new session/prompt action.' })
  for (const item of fixture.historical) assert.equal(sha256(readFileSync(item.file)), item.sha256, 'Historical evidence unchanged')
  assert.deepEqual(fixture.errors, [])
  assert.equal(sha256(readFileSync(fixture.nativeBin)), fixture.nativeBinarySha256, 'Official runtime binary unchanged')
  report.status = 'PASS'
  console.info(`PASS: ${checks.map(check => check.name).join('; ')}`)
} catch (error) {
  report.status = 'FAIL'; report.error = String(error); throw error
} finally {
  fixture.save('verification.json', { ...report, frames, observations, parentEvents, providerRequests: fixture.requests, providerErrors: fixture.errors })
  // Release any held local provider before shutting down managed native sessions.
  for (const gate of ['old', 'new', 'merge']) fixture.release(gate)
  for (const session of sessions) await session.dispose()
  await fixture.close()
  console.info(`Evidence: ${path.join(fixture.root, 'verification.json')}`)
}
