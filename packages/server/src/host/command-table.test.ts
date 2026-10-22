import assert from "node:assert/strict"
import { test } from "node:test"
import { homedir, tmpdir } from "node:os"
import { mkdtempSync, realpathSync, rmSync } from "node:fs"
import path from "node:path"
import { WorkspaceStore } from "./workspace-store.ts"
import { HostRuntime } from "./command-table.ts"


test("execute rejects malformed params at the edge before reaching handlers", async () => {
  const runtime = new HostRuntime({} as never)
  await assert.rejects(
    runtime.execute("git.diff", { workspacePath: 42 } as never),
    (error: Error & { code?: string }) => error.code === "INVALID_REQUEST" && /workspacePath must be a string/.test(error.message),
  )
  await assert.rejects(
    runtime.execute("terminals.create", {} as never),
    (error: Error & { code?: string }) => error.code === "INVALID_REQUEST",
  )
})

test("implicit workspace uses the user home rather than executable or launch directory", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "ompiui-workspace-default-"))
  const previous = process.cwd()
  try {
    process.chdir(directory)
    const runtime = new HostRuntime({ store: new WorkspaceStore() } as never)
    const implicit = await runtime.execute("workspaces.open", {}) as { workspace: { path: string } }
    const explicit = await runtime.execute("workspaces.open", { rootPath: directory }) as { workspace: { path: string } }
    assert.equal(implicit.workspace.path, realpathSync.native(homedir()))
    assert.equal(explicit.workspace.path, realpathSync.native(directory))
  } finally {
    process.chdir(previous)
    rmSync(directory, { recursive: true, force: true })
  }
})
