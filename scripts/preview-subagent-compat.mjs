import path from 'node:path'
import { commands, createSubagentCompatFixture, releaseCompatGate, repoRoot, SUBAGENT_COMPAT_AUTH_TOKEN } from './subagent-compat-fixture.mjs'

const args = process.argv.slice(2)
if (args.includes('--help')) {
  console.info('Launch only via preview_start configuration isolated-subagent-compat (port 8800).\nOptional: --runtime-dir DIR. Control only (no server): --release FIXTURE_ROOT --gate old|new|merge.\nUse printed orderingCwd in a regular GUI session: /subagent-compat-spawn; wait for initial idle; /subagent-compat-wake-one; wait for native-bash-gate-start old; /subagent-compat-wake-two; wait for provider-gate-held new; /subagent-compat-release-old; observe stale identityless terminal without completing the new run; /subagent-compat-release-new; inspect REAL_NEW_REPLY_AFTER_OLD_TERMINAL.\nUse printed structuredCwd for /subagent-compat-structured (real task/yield). Use a fresh session at mergeCwd for /subagent-compat-merge; wait for parent-diverged and provider-gate-held merge; /subagent-compat-release-merge. Native child exit0 has no merge fields: changes must be unconfirmed. Never retry or force merge.\nEvidence: subagent-compat-fixture.json, native-evidence.jsonl, provider-evidence.jsonl and native agent/sessions. GUI traffic goes through the regular server/RPC. Quiescent refresh must leave native JSONL hashes and provider request count unchanged; compare diagnostics worker.request.started commands session.open/prompt/sendUserMessage and session.attached events. Each reproduction is one-shot; start a fresh preview fixture to repeat.')
} else if (args[0] === '--release') {
  if (args.length !== 4 || args[2] !== '--gate') throw new Error('Usage: --release FIXTURE_ROOT --gate old|new|merge')
  console.info(JSON.stringify(releaseCompatGate(args[1], args[3])))
} else {
  if (args.length && (args.length !== 2 || args[0] !== '--runtime-dir')) throw new Error('Usage: [--runtime-dir DIR]')
  const fixture = await createSubagentCompatFixture(args[1])
  const { startOmpiUiServer } = await import('../packages/server/src/start.ts')
  const server = await startOmpiUiServer({ host: '127.0.0.1', port: 8800, authToken: SUBAGENT_COMPAT_AUTH_TOKEN, webRoot: path.join(repoRoot, 'packages/app/dist') })
  console.info(`SUBAGENT_COMPAT_GUI ${JSON.stringify({ ...fixture, requests: undefined, errors: undefined, nativeFrames: undefined, commands, procedure: 'Run --help for deliberate public GUI commands. No sessions or prompts are created by preview setup.' })}`)
  let stopping = false
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, async () => {
    if (stopping) return; stopping = true
    await fixture.close(); await server.stop(); process.exit(0)
  })
}
