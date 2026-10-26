import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { test } from "node:test"
import { homedir, tmpdir } from "node:os"
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmdirSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs"
import path from "node:path"
import { WorkspaceStore } from "./workspace-store.ts"
import { HostRuntime } from "./command-table.ts"
import { TerminalManager } from "./terminal-manager.ts"
import { WorkspaceWatcher } from "./workspace-watcher.ts"
import { EventHub } from "../event-hub.ts"
import { SessionHost } from "../omp/session-host.ts"
import { RuntimeSupervisor } from "../omp/supervisor.ts"


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

test("worktree removal protects descendant workspace and cwd shells without affecting a sibling or branch", { timeout: 45_000 }, async () => {
  const fixture = mkdtempSync(path.join(tmpdir(), "ompiui-worktree-shell-"))
  const root = path.join(fixture, "storage")
  const alias = path.join(fixture, "workspace")
  mkdirSync(root)
  symlinkSync(root, alias, process.platform === "win32" ? "junction" : "dir")
  const previousNativeModules = process.env.OMPIUI_NATIVE_MODULES
  const nativeModules = path.join(root, 'native-module-fixture')
  const ptyDirectory = path.join(nativeModules, '@lydell', `node-pty-${process.platform}-${process.arch}`, 'lib')
  mkdirSync(ptyDirectory, { recursive: true })
  // Stateful OS dependency fixture keeps permanent containment tests independent
  // of ConPTY handles; real owned-shell/native smoke is recorded separately.
  writeFileSync(path.join(ptyDirectory, 'index.js'), `
    let nextPid = 10000;
    exports.spawn = () => {
      const listeners = new Set(); let alive = true;
      const finish = () => { if (!alive) return; alive = false; for (const listener of listeners) listener({ exitCode: 0 }); };
      return { pid: ++nextPid, write: data => { if (data.trim() === 'exit') finish(); }, resize: () => {}, kill: finish,
        onData: () => ({ dispose() {} }), onExit: listener => { listeners.add(listener); return { dispose: () => listeners.delete(listener) }; } };
    };
  `)
  process.env.OMPIUI_NATIVE_MODULES = nativeModules
  const repo = path.join(root, "repo")
  const linked = path.join(alias, "linked")
  const sibling = path.join(root, "linked-other")
  mkdirSync(path.join(repo, "src"), { recursive: true })
  mkdirSync(sibling)
  const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, encoding: "utf8", windowsHide: true })
  git("init", "-b", "main")
  git("config", "user.name", "PiUI Test")
  git("config", "user.email", "ompiui@example.invalid")
  writeFileSync(path.join(repo, "src", "tracked.txt"), "base\n")
  git("add", "src/tracked.txt")
  git("commit", "-m", "fixture")
  const hub = new EventHub()
  const supervisor = new RuntimeSupervisor()
  const sessions = new SessionHost(supervisor, hub)
  const watcher = new WorkspaceWatcher(hub)
  const terminals = new TerminalManager()
  const runtime = new HostRuntime({ store: new WorkspaceStore(), watcher, sessions, terminals })
  const remove = () => runtime.execute("git.worktreeRemove", { workspacePath: repo, path: linked })
  const exit = async (workspacePath: string, id: string) => {
    const { promise, resolve } = Promise.withResolvers<void>()
    const attachment = terminals.attach(workspacePath, id, undefined, () => {}, () => resolve())
    attachment.activate()
    try {
      terminals.write(workspacePath, id, "exit\r")
      await promise
    } finally { attachment.detach() }
  }
  try {
    await runtime.execute("git.worktreeCreate", { workspacePath: repo, path: linked, branch: "keep-branch" })
    const descendant = path.join(root, "linked", "src")
    const first = await runtime.execute("terminals.create", { workspacePath: descendant }) as { id: string }
    await assert.rejects(remove(), { code: "WORKSPACE_BUSY" })
    assert.equal(existsSync(path.join(linked, ".git")), true)
    assert.equal(terminals.get(descendant, first.id).status, "running")
    await exit(descendant, first.id)

    const second = await runtime.execute("terminals.create", { workspacePath: root, cwd: "linked/src" }) as { id: string }
    await assert.rejects(remove(), { code: "WORKSPACE_BUSY" })
    assert.equal(existsSync(path.join(linked, "src", "tracked.txt")), true)
    assert.equal(terminals.get(root, second.id).status, "running")
    await exit(root, second.id)

    const unrelated = await runtime.execute("terminals.create", { workspacePath: sibling }) as { id: string }
    await remove()
    assert.equal(existsSync(linked), false)
    assert.match(git("show-ref", "--verify", "refs/heads/keep-branch"), /refs\/heads\/keep-branch/)
    assert.equal(terminals.get(sibling, unrelated.id).status, "running")
    await exit(sibling, unrelated.id)
  } finally {
    await terminals.shutdown()
    sessions.dispose()
    await watcher.dispose()
    await supervisor.dispose()
    if (previousNativeModules === undefined) delete process.env.OMPIUI_NATIVE_MODULES
    else process.env.OMPIUI_NATIVE_MODULES = previousNativeModules
    if (process.platform === "win32") rmdirSync(alias)
    else unlinkSync(alias)
    rmSync(fixture, { recursive: true, force: true })
  }
})
