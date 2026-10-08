import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { test } from "node:test"
import { fileURLToPath } from "node:url"
import { adminConfigPath, defaultAdminConfig, loadAdminConfig, saveAdminConfig } from "./config.ts"

const workspace = fileURLToPath(new URL("../../../", import.meta.url))
const serverDir = resolve(workspace, "packages/server")
const configModule = new URL("./config.ts", import.meta.url).href

test("default server entry and cwd derive from the package, not the launching directory", () => {
  const unrelated = mkdtempSync(join(tmpdir(), "ompiui-admin-cwd-"))
  try {
    // Supported Node versions can strip this module's types directly. Import
    // it from three caller directories without mutating this process's cwd.
    for (const cwd of [workspace, join(workspace, "packages/admin"), unrelated]) {
      const result = spawnSync(process.execPath, [
        "--input-type=module", "-e",
        `import { defaultAdminConfig } from ${JSON.stringify(configModule)}; console.log(JSON.stringify(defaultAdminConfig({})))`,
      ], { cwd, encoding: "utf8", timeout: 10_000 })
      assert.equal(result.status, 0, result.stderr)
      const config = JSON.parse(result.stdout)
      assert.equal(config.serverCommand, process.execPath)
      assert.deepEqual(config.serverArgs, [join(serverDir, "dist/bundle-entry.js"), "web"])
      assert.equal(config.serverCwd, serverDir)
    }
  } finally {
    rmSync(unrelated, { recursive: true, force: true })
  }
})

test("stored command, arguments and cwd are preserved; entry env override keeps explicit cwd", () => {
  const root = mkdtempSync(join(tmpdir(), "ompiui-admin-config-"))
  const env = { OMPIUI_ADMIN_DATA_DIR: root }
  try {
    const configured = {
      ...defaultAdminConfig(env), serverCommand: "custom-node", serverArgs: ["custom.js", "--mode=test"], serverCwd: root,
    }
    saveAdminConfig(configured, env)
    assert.deepEqual(loadAdminConfig(env), configured)
    const overridden = loadAdminConfig({ ...env, OMPIUI_SERVER_ENTRY: join(root, "override.js") })
    assert.equal(overridden.serverCommand, process.execPath)
    assert.deepEqual(overridden.serverArgs, [join(root, "override.js"), "web"])
    assert.equal(overridden.serverCwd, root)

    writeFileSync(adminConfigPath(env), JSON.stringify({ serverCwd: "relative-custom-cwd" }))
    assert.equal(loadAdminConfig(env).serverCwd, resolve("relative-custom-cwd"))
    writeFileSync(adminConfigPath(env), "{}")
    assert.equal(loadAdminConfig(env).serverCwd, serverDir)
    writeFileSync(adminConfigPath(env), "invalid JSON")
    assert.equal(loadAdminConfig(env).serverCwd, serverDir)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("root and workspace npm admin forward --help and exit without starting a backend", () => {
  const root = mkdtempSync(join(tmpdir(), "ompiui-admin-help-"))
  try {
    const env = {
      ...process.env, OMPIUI_ADMIN_DATA_DIR: root, OMPIUI_DATA_DIR: root,
      // Any accidental backend spawn fails; successful help creates no state.
      OMPIUI_SERVER_ENTRY: join(root, "must-not-run.js"),
    }
    const npm = process.platform === "win32" ? "npm.cmd" : "npm"
    for (const cwd of [workspace, join(workspace, "packages/admin")]) {
      const result = spawnSync(npm, ["run", "admin", "--", "--help"], {
        cwd, env, encoding: "utf8", timeout: 15_000, shell: process.platform === "win32",
      })
      assert.equal(result.status, 0, `${result.error ?? ""}\n${result.stderr}`)
      assert.match(result.stdout, /Usage: ompiui-admin <command>/)
      assert.match(result.stdout, /--host <host>/)
      assert.doesNotMatch(result.stdout, /backend started|management UI:/)
      assert.deepEqual(readdirSync(root), [])
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
