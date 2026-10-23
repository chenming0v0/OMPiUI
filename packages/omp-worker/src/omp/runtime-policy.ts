import { createHash } from "node:crypto"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { managedSessionsRoot } from "./managed-sessions.js"
import { runtimeBridgeExtension } from "./runtime-bridge.js"
import { resolveOmpPackageRoot } from "./omp-native-script.js"

const RUNTIME_POLICY = "autoResume: false\ntask:\n  maxRecursionDepth: 1\n"


function writePolicyFile(file: string, contents: string): void {
  if (!existsSync(file) || readFileSync(file, "utf8") !== contents) {
    writeFileSync(file, contents, { mode: 0o600 })
  }
}

/** 最后加载的进程级配置与受管桥；不修改用户 CLI 设置。 */
export function runtimePolicyArgs(bin?: string, env: NodeJS.ProcessEnv = process.env): string[] {
  resolveOmpPackageRoot(bin, env)
  const bridgeSource = runtimeBridgeExtension()
  const directory = join(dirname(managedSessionsRoot()), "runtime-config")
  const file = join(directory, "runtime-policy.yml")
  // Content-addressed bridge files must not overwrite a running runtime's
  // extension path: native reload imports the same file again.
  const bridge = join(directory, `runtime-bridge-${createHash("sha256").update(bridgeSource).digest("hex").slice(0, 16)}.mjs`)
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  writePolicyFile(file, RUNTIME_POLICY)
  writePolicyFile(bridge, bridgeSource)
  // Explicit extensions are loaded even with --no-extensions; discovery stays
  // native. Modules are evaluated by the official loader, never the worker.
  return ["--config", file, "--extension", bridge]
}
