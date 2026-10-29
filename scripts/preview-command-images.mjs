import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { createTransitionFixture } from './session-transition-fixture.mjs'

// Explicit installed runtime only; never download or use a user's configuration.
const args = process.argv.slice(2)
if (args.length) {
  if (args.length !== 2 || args[0] !== '--runtime-dir') throw new Error('Usage: preview-command-images.mjs [--runtime-dir <path>]')
  process.env.OMPI_OMP_RUNTIME_DIR = path.resolve(args[1])
}
const { resolveInstalledOmpRuntime, installedOmpExecutable } = await import('../packages/omp-worker/src/omp/omp-runtime.ts')
const runtime = resolveInstalledOmpRuntime()
if (runtime) {
  process.env.OMPI_OMP_BIN ??= installedOmpExecutable(runtime, 'omp')
  process.env.OMPI_BUN_BIN ??= installedOmpExecutable(runtime, 'bun')
  process.env.PI_NATIVES_DIR ??= path.join(runtime.root, 'node_modules', '@oh-my-pi', 'pi-natives')
}
const fixture = await createTransitionFixture()
const commands = path.join(fixture.agent, 'commands')
mkdirSync(commands)
writeFileSync(path.join(commands, 'image-check.md'), '---\ndescription: Isolated image transport acceptance (not vision recognition)\n---\nDescribe native pictures $ARGUMENTS')
writeFileSync(path.join(fixture.cwd, 'note.txt'), 'NATIVE_FILE_REFERENCE_375\n')
writeFileSync(path.join(fixture.agent, 'extensions', 'command-image-checks.js'), `import { appendFileSync } from 'node:fs';
const log = ${JSON.stringify(path.join(fixture.root, 'native-inputs.jsonl'))};
export default function (pi) {
  pi.on('input', async (event) => {
    if (!event.text.startsWith('/ompiui-runtime ')) appendFileSync(log, JSON.stringify({ text: event.text, images: event.images, source: event.source }) + '\\n');
    if (event.text.includes('WAIT_ACCEPT')) await new Promise(resolve => setTimeout(resolve, 23000));
  });
  pi.registerCommand('draft-reject', {
    description: 'Isolated acceptance: reject after 23 seconds without invoking a model',
    handler: async () => {
      await new Promise(resolve => setTimeout(resolve, 23000));
      throw new Error('COMMAND_IMAGES_REJECTED_375');
    },
  });
}
`)
process.env.OMPIUI_DRIVER = 'omp'
const { OmpRpcSession } = await import('../packages/omp-worker/src/omp/omp-session.ts')
const session = await OmpRpcSession.open(fixture.cwd)
await session.sendUserMessage('Initialize isolated command images acceptance')
await session.waitForIdle()
const info = {
  root: fixture.root, cwd: fixture.cwd,
  sessionId: session.getSessionId(), sessionFile: session.getSessionFile(),
  ompVersion: runtime?.version ?? null,
  scope: 'command/image transport and current draft ownership; real vision is NOT tested',
}
await session.dispose()
fixture.save('gui-session.json', info)
const { startOmpiUiServer } = await import('../packages/server/src/start.ts')
const server = await startOmpiUiServer({ host: '127.0.0.1', port: 8797, authToken: 'isolated-command-images-check', webRoot: path.resolve('packages/app/dist') })
console.info(`COMMAND_IMAGES_GUI ${JSON.stringify(info)}`)
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, async () => {
  fixture.save('gui-provider-requests.json', fixture.requests)
  // Preserve fixture evidence; only stop this preview's own runtime/server.
  await server.stop(); await fixture.close()
  process.exit(0)
})
