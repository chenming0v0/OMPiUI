import path from 'node:path'
import { createToolInteractionFixture } from './tool-interaction-fixture.mjs'

const args = process.argv.slice(2)
const runtimeDir = args[0] === '--runtime-dir' ? args[1] : '.slim/issue-repair-native-runtime'
const fixture = await createToolInteractionFixture(runtimeDir)
process.env.OMPIUI_DRIVER = 'omp'
const { startOmpiUiServer } = await import('../packages/server/src/start.ts')
const server = await startOmpiUiServer({ host: '127.0.0.1', port: 8798, authToken: 'isolated-tool-interaction', webRoot: path.resolve('packages/app/dist') })
console.info(`TOOL_INTERACTION_GUI ${JSON.stringify({ root: fixture.root, cwd: fixture.cwd, url: 'http://127.0.0.1:8798/?token=isolated-tool-interaction' })}`)
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, async () => {
  await server.stop(); await fixture.close(); process.exit(0)
})
