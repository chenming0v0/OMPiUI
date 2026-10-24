import { createHash } from "node:crypto"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { managedSessionsRoot } from "./managed-sessions.js"
import { runtimeBridgeExtension } from "./runtime-bridge.js"

// Subagent recursion follows the user's native task.maxRecursionDepth setting;
// the managed runtime no longer pins a UI-specific depth override (#372).
export const RUNTIME_POLICY = "autoResume: false\n"

// Official OMP 18.3.1 excludes pty calls from bash.autoBackground, even when
// RPC falls back to the non-PTY executor. timeout: 0 then has no deadline.
// Use the public tool_call gate, not a process/agent timeout: reject before
// launch and let the model choose an explicit service or bounded PTY call.
export const SHELL_POLICY_EXTENSION = `export default function (pi) {
  pi.on("tool_call", event => {
    if (event.toolName !== "bash") return;
    const input = event.input;
    if (input.pty !== true || input.timeout !== 0 || input.async === true || input.name !== undefined) return;
    return {
      block: true,
      reason: "The managed RPC UI has no local interactive PTY: this foreground pty:true timeout:0 command was not started. Use OMPiUI's Native OMP terminal entry for terminal interaction. Named services remain available through bash name + ready.timeout and proc:// stdin; async:true non-interactive jobs are also available. No command or agent was stopped.",
    };
  });
}
`

function writePolicyFile(file: string, contents: string): void {
  if (!existsSync(file) || readFileSync(file, "utf8") !== contents) {
    writeFileSync(file, contents, { mode: 0o600 })
  }
}

/** 最后加载的进程级配置与工具调用限制；不修改用户 CLI 设置或正常 bash 行为。 */
// 桥扩展的 @oh-my-pi import 由官方宿主加载器解析，不需要 npm 源码树（#390）；
// 参数保留以兼容现有调用方。
export function runtimePolicyArgs(_bin?: string, _env: NodeJS.ProcessEnv = process.env): string[] {
  const bridgeSource = runtimeBridgeExtension()
  const directory = join(dirname(managedSessionsRoot()), "runtime-config")
  const file = join(directory, "runtime-policy.yml")
  const extension = join(directory, "shell-policy.mjs")
  // Content-addressed bridge files must not overwrite a running runtime's
  // extension path: native reload imports the same file again.
  const bridge = join(directory, `runtime-bridge-${createHash("sha256").update(bridgeSource).digest("hex").slice(0, 16)}.mjs`)
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  writePolicyFile(file, RUNTIME_POLICY)
  writePolicyFile(extension, SHELL_POLICY_EXTENSION)
  writePolicyFile(bridge, bridgeSource)
  // Explicit extensions are loaded even with --no-extensions; discovery stays
  // native. Modules are evaluated by the official loader, never the worker.
  return ["--config", file, "--extension", extension, "--extension", bridge]
}
