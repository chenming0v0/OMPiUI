/**
 * Cross-platform: start server with OMPIUI_DRIVER=omp
 * Windows cmd cannot parse `OMPIUI_DRIVER=omp npm run ...`
 */
import { spawn } from "node:child_process"
import { fileURLToPath } from "node:url"
import { dirname, join } from "node:path"

const root = join(dirname(fileURLToPath(import.meta.url)), "..")
const env = { ...process.env, OMPIUI_DRIVER: "omp" }

const child = spawn("npm", ["run", "dev", "-w", "@ompiui/server"], {
  cwd: root,
  env,
  stdio: "inherit",
  shell: true,
})

child.on("exit", code => {
  process.exit(code ?? 0)
})
