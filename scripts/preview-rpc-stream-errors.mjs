import path from 'node:path'
import { armRpcStream, createRpcStreamFixture, RPC_STREAM_AUTH_TOKEN, RPC_STREAM_COMMAND, RPC_STREAM_MARKER_COMMAND, repoRoot } from './rpc-stream-fixture.mjs'

const args = process.argv.slice(2)
if (args.includes('--help')) {
  console.info('Usage (server must be launched by preview_start): node --import tsx scripts/preview-rpc-stream-errors.mjs [--runtime-dir DIR]\nArm only (does not start any server): node --import tsx scripts/preview-rpc-stream-errors.mjs --arm FIXTURE_ROOT --cwd TARGET_CWD --mode stream|frame|drop\nGUI: first send /rpc-stream-large gui-normal and confirm native-group records with nativeChunkCount>0. Then arm and send /rpc-stream-large gui-stream or gui-frame. Send /rpc-stream-marker gui-continued after each fault. A second session uses printed secondCwd. Evidence: proxy-*.jsonl / rpc-stream-fixture.json. drop is optional and waits the real 30 seconds.')
} else if (args[0] === '--arm') {
  if (args.length !== 6 || args[2] !== '--cwd' || args[4] !== '--mode') throw new Error('Usage: --arm FIXTURE_ROOT --cwd TARGET_CWD --mode stream|frame|drop')
  console.info(`RPC_STREAM_ARM ${JSON.stringify(armRpcStream(args[1], args[3], args[5]))}`)
} else {
  if (args.length && (args.length !== 2 || args[0] !== '--runtime-dir')) throw new Error('Usage: [--runtime-dir DIR]')
  const fixture = await createRpcStreamFixture(args[1])
  const { startOmpiUiServer } = await import('../packages/server/src/start.ts')
  const port = Number(process.env.PORT ?? 8799)
  const url = `http://127.0.0.1:${port}/?token=${RPC_STREAM_AUTH_TOKEN}`
  const server = await startOmpiUiServer({ host: '127.0.0.1', port, authToken: RPC_STREAM_AUTH_TOKEN, webRoot: path.join(repoRoot, 'packages/app/dist') })
  console.info(`RPC_STREAM_GUI ${JSON.stringify({ root: fixture.root, cwd: fixture.cwd, secondCwd: fixture.secondCwd, url, authToken: RPC_STREAM_AUTH_TOKEN, control: fixture.control, command: RPC_STREAM_COMMAND, markerCommand: RPC_STREAM_MARKER_COMMAND, armFormat: { arm: { id: 'unique-string', mode: 'stream', cwd: fixture.cwd } }, evidence: 'proxy-*.jsonl; actual native-group records have nativeChunkCount/sessionId/payloadSha256; real GUI events must be collected through public WebSocket, not injected' })}`)
  let stopping = false
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, async () => {
    if (stopping) return; stopping = true
    await server.stop(); await fixture.close(); process.exit(0)
  })
}
