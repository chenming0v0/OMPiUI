import { readFileSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import path from 'node:path'
import { createTransitionFixture, testImage } from './session-transition-fixture.mjs'

// Explicit test runtime selection; never download or change user configuration.
const args = process.argv.slice(2)
if (args.length) {
  if (args.length !== 2 || args[0] !== '--runtime-dir') throw new Error('Usage: preview-session-transitions.mjs [--runtime-dir <path>]')
  process.env.OMPI_OMP_RUNTIME_DIR = path.resolve(args[1])
}
const { resolveInstalledOmpRuntime, installedOmpExecutable } = await import('../packages/omp-worker/src/omp/omp-runtime.ts')
const runtime = resolveInstalledOmpRuntime()
if (runtime) {
  process.env.OMPI_OMP_BIN ??= installedOmpExecutable(runtime, 'omp')
  process.env.OMPI_BUN_BIN ??= installedOmpExecutable(runtime, 'bun')
  // The compiled CLI may need its public native addon in an isolated HOME.
  process.env.PI_NATIVES_DIR ??= path.join(runtime.root, 'node_modules', '@oh-my-pi', 'pi-natives')
}
const fixture = await createTransitionFixture()
process.env.OMPIUI_DRIVER = 'omp'
const { OmpRpcSession } = await import('../packages/omp-worker/src/omp/omp-session.ts')
const session = await OmpRpcSession.open(fixture.cwd)
for (const [text, images] of [['GUI first question'], ['GUI image question', [testImage]], ['GUI third question']]) {
  await session.sendUserMessage(text, images)
  await session.waitForIdle()
}
const info = { root: fixture.root, cwd: fixture.cwd, sessionId: session.getSessionId(), sessionFile: session.getSessionFile(), sourceSha256: createHash('sha256').update(readFileSync(session.getSessionFile())).digest('hex') }
await session.dispose()
writeFileSync(path.join(fixture.root, 'gui-session.json'), JSON.stringify(info, null, 2))
const { startOmpiUiServer } = await import('../packages/server/src/start.ts')
const server = await startOmpiUiServer({ host: '127.0.0.1', port: 8796, authToken: 'isolated-transition-check', webRoot: path.resolve('packages/app/dist') })
console.info(`TRANSITION_GUI ${JSON.stringify(info)}`)
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, async () => {
  fixture.save('gui-provider-requests.json', fixture.requests)
  await server.stop(); await fixture.close()
  process.exit(0)
})
