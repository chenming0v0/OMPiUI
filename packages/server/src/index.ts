import { startOmpiUiServer } from "./start.ts"

void startOmpiUiServer().catch(error => {
  console.error(`[ompiui-server] failed to start: ${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
})
