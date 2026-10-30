import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createTransitionFixture } from './session-transition-fixture.mjs'

export const RPC_STREAM_PAYLOAD_BYTES = 1152 * 1024
export const RPC_STREAM_AUTH_TOKEN = 'isolated-rpc-stream-367'
export const RPC_STREAM_COMMAND = '/rpc-stream-large'
export const RPC_STREAM_MARKER_COMMAND = '/rpc-stream-marker'
export const RPC_STREAM_MODES = ['stream', 'frame', 'drop']
export const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')

export function armRpcStream(root, cwd, mode) {
  if (!RPC_STREAM_MODES.includes(mode)) throw new Error('Mode must be stream, frame, or drop')
  root = path.resolve(root); cwd = path.resolve(cwd)
  if (!cwd.startsWith(root + path.sep)) throw new Error('Arm cwd must belong to this fixture root')
  const file = path.join(root, 'rpc-stream-control.json')
  const previous = JSON.parse(readFileSync(file, 'utf8'))
  if (previous.arm) throw new Error('Previous arm has not been consumed')
  const arm = { id: randomUUID(), mode, cwd, time: Date.now() }
  writeFileSync(file, JSON.stringify({ ...previous, arm }, null, 2) + '\n')
  return arm
}

export function readRpcStreamEvidence(root) {
  return readdirSync(root).filter(file => /^proxy-\d+\.jsonl$/.test(file)).flatMap(file => readFileSync(path.join(root, file), 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line)))
}

export async function createRpcStreamFixture(runtimeDir = path.join(repoRoot, '.slim/issue-repair-native-runtime')) {
  // Match tool-interaction-fixture's explicit official executable resolution.
  process.env.OMPI_OMP_RUNTIME_DIR = path.resolve(runtimeDir)
  for (const key of ['OMPI_OMP_BIN', 'OMPI_BUN_BIN', 'PI_NATIVES_DIR']) delete process.env[key]
  const { resolveInstalledOmpRuntime, installedOmpExecutable } = await import('../packages/omp-worker/src/omp/omp-runtime.ts')
  const runtime = resolveInstalledOmpRuntime()
  if (!runtime) throw new Error('Explicit official runtime is required')
  const nativeBin = installedOmpExecutable(runtime, 'omp')
  process.env.OMPI_BUN_BIN = installedOmpExecutable(runtime, 'bun')
  process.env.PI_NATIVES_DIR = path.join(runtime.root, 'node_modules', '@oh-my-pi', 'pi-natives')
  const fixture = await createTransitionFixture()
  // Keep the deterministic loopback provider; never use an account or paid key.
  for (const key of Object.keys(process.env)) if (/(API_KEY|ACCESS_TOKEN|AUTH_TOKEN|SECRET|PASSWORD)$/i.test(key)) delete process.env[key]
  for (const dir of ['local', 'roaming', 'config', 'cache', 'data', 'workspace-second']) mkdirSync(path.join(fixture.root, dir), { recursive: true })
  process.env.LOCALAPPDATA = path.join(fixture.root, 'local')
  process.env.APPDATA = path.join(fixture.root, 'roaming')
  process.env.XDG_CONFIG_HOME = path.join(fixture.root, 'config')
  process.env.XDG_CACHE_HOME = path.join(fixture.root, 'cache')
  process.env.XDG_DATA_HOME = path.join(fixture.root, 'data')
  writeFileSync(path.join(fixture.agent, 'config.yml'), `modelRoles:\n  default: transition-fixture/offline\ntitle:\n  enabled: false\nasync:\n  enabled: false\nlaunch:\n  enabled: false\nshellPath: ${JSON.stringify(process.platform === 'win32' ? 'C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe' : '/bin/sh')}\nautoResume: false\n`)
  // Public extension API only. Bounded 1.125 MiB content, no LLM turn.
  writeFileSync(path.join(fixture.agent, 'extensions', 'rpc-stream-checks.js'), `export default function (pi) {
  const emit = (ctx, tag, large) => {
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(tag)) throw new Error('RPC stream tag must be 1-64 ASCII letters, digits, underscore or dash');
    const prefix = 'RPC_STREAM_NATIVE ' + tag + ' ';
    const content = large ? prefix + 'x'.repeat(${RPC_STREAM_PAYLOAD_BYTES} - prefix.length) : prefix + 'continued';
    pi.sendMessage({ customType: 'rpc-stream-acceptance', content, display: true, details: { sessionId: ctx.sessionManager.getSessionId(), tag, payloadBytes: content.length } }, { triggerTurn: false });
  };
  pi.registerCommand('rpc-stream-large', { description: 'Acceptance only: bounded >1MiB native message, no model turn', handler: async (text, ctx) => emit(ctx, text.trim() || 'gui-large', true) });
  pi.registerCommand('rpc-stream-marker', { description: 'Acceptance only: small native continuation marker', handler: async (text, ctx) => emit(ctx, text.trim() || 'gui-marker', false) });
}
`)
  const control = path.join(fixture.root, 'rpc-stream-control.json')
  writeFileSync(control, JSON.stringify({ arm: null }) + '\n')
  process.env.OMPI_RPC_STREAM_NATIVE_BIN = nativeBin
  process.env.OMPI_RPC_STREAM_CONTROL = control
  process.env.OMPI_RPC_STREAM_EVIDENCE = fixture.root
  process.env.OMPI_OMP_BIN = path.join(repoRoot, 'scripts', 'rpc-stream-proxy.mjs')
  process.env.OMPIUI_DRIVER = 'omp'
  const manifest = { root: fixture.root, cwd: fixture.cwd, secondCwd: path.join(fixture.root, 'workspace-second'), control, runtime: { version: runtime.version, bunVersion: runtime.bunVersion }, nativeBin, nativeBinarySha256: sha256(readFileSync(nativeBin)), proxy: process.env.OMPI_OMP_BIN, payloadBytes: RPC_STREAM_PAYLOAD_BYTES, command: RPC_STREAM_COMMAND, markerCommand: RPC_STREAM_MARKER_COMMAND, authToken: RPC_STREAM_AUTH_TOKEN, url: `http://127.0.0.1:8799/?token=${RPC_STREAM_AUTH_TOKEN}` }
  fixture.save('rpc-stream-fixture.json', manifest)
  return { ...fixture, ...manifest, runtime, arm(cwd, mode) { return armRpcStream(fixture.root, cwd, mode) }, evidence() { return readRpcStreamEvidence(fixture.root) } }
}
