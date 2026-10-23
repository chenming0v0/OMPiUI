import assert from "node:assert/strict"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { test } from "node:test"
import type { TestContext } from "node:test"
import type { JsonObject } from "@ompiui/protocol"
import { OmpPackages } from "./omp-packages.js"
import { resolveOmpPackageRoot } from "./omp-native-script.js"

type PackageSnapshot = { packages: Array<{ source: string; scope: string; enabled: boolean; type: string; installedPath: string; version: string; shadowedBy?: string }>; marketplaces: Array<{ name: string; source: string }> }
type Resources = { extensions: Array<{ path: string; source: string; enabled: boolean }>; skills: Array<{ path: string }>; prompts: Array<{ path: string }>; commands: Array<{ path: string }>; warnings: string[] }

// Opt-in integration proof uses the installed native managers in a fresh child
// HOME/profile. No package downloads, user configuration, or live sessions.
function fixture(t: TestContext) {
  const officialRoot = resolveOmpPackageRoot()
  const root = mkdtempSync(path.join(tmpdir(), "ompiui-plugin-fixture-"))
  const keys = ["HOME", "USERPROFILE", "OMP_PROFILE", "PI_PROFILE", "PI_CODING_AGENT_DIR", "PI_CONFIG_FILES", "PI_CONFIG_DIR", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME", "XDG_CACHE_HOME", "OMPI_OMP_PACKAGE_ROOT"]
  const previous = Object.fromEntries(keys.map(key => [key, process.env[key]]))
  t.after(() => {
    for (const key of keys) {
      if (previous[key] === undefined) delete process.env[key]
      else process.env[key] = previous[key]
    }
    rmSync(root, { recursive: true, force: true })
  })
  const home = path.join(root, "home")
  const cwd = path.join(root, "project")
  const source = path.join(root, "local-plugin")
  const market = path.join(root, "market")
  for (const directory of [home, path.join(cwd, ".omp"), source, path.join(market, ".omp-plugin"), path.join(market, "plugins", "demo")]) mkdirSync(directory, { recursive: true })
  for (const key of keys) delete process.env[key]
  process.env.HOME = home
  process.env.USERPROFILE = home
  process.env.PI_CODING_AGENT_DIR = path.join(home, ".omp", "agent")
  process.env.OMPI_OMP_PACKAGE_ROOT = officialRoot
  const plugin = path.join(market, "plugins", "demo")
  for (const directory of [source, plugin]) {
    writeFileSync(path.join(directory, "package.json"), JSON.stringify({ name: "parity-fixture", version: "1.0.0", omp: { extensions: ["extension.ts"] } }))
    writeFileSync(path.join(directory, "extension.ts"), "throw new Error('Read-only package discovery must not execute extension code')\n")
    mkdirSync(path.join(directory, "skills", "demo"), { recursive: true })
    writeFileSync(path.join(directory, "skills", "demo", "SKILL.md"), "---\nname: demo\ndescription: Offline fixture skill\n---\nNative fixture skill\n")
    mkdirSync(path.join(directory, "commands"))
    writeFileSync(path.join(directory, "commands", "demo.md"), "Offline fixture command\n")
    mkdirSync(path.join(directory, "prompts"))
    writeFileSync(path.join(directory, "prompts", "demo.md"), "Offline fixture prompt\n")
  }
  const catalog = path.join(market, ".omp-plugin", "marketplace.json")
  const setVersion = (version: string) => {
    writeFileSync(catalog, JSON.stringify({ name: "fixture", owner: { name: "fixture" }, plugins: [{ name: "demo", source: "./plugins/demo", version }] }))
  }
  setVersion("1.0.0")
  return { root, home, cwd, source, market, catalog, setVersion, packages: new OmpPackages() }
}

const native = { skip: process.env.OMPIUI_TEST_NATIVE_OMP !== "1", timeout: 180_000 }

async function linkFixture(t: TestContext, f: { cwd: string; home: string; source: string; packages: OmpPackages }, progress: JsonObject[] = []) {
  try {
    return await f.packages.manage(f.cwd, "link", "link", f.source, false, event => progress.push(event)) as unknown as PackageSnapshot
  } catch (error) {
    if (process.platform !== "win32" || !/EPERM.*symlink|symlink.*EPERM/i.test(String(error))) throw error
    assert.deepEqual(progress.map(event => event.phase), ["started", "failed"])
    assert.match(String(progress[1]?.message), /EPERM.*symlink|symlink.*EPERM/i)
    assert.equal((await f.packages.list(f.cwd) as unknown as PackageSnapshot).packages.some(item => item.source === "parity-fixture"), false)
    const lock = path.join(f.home, ".omp", "plugins", "omp-plugins.lock.json")
    assert.equal(existsSync(lock) && !!JSON.parse(readFileSync(lock, "utf8")).plugins?.["parity-fixture"], false)
    assert.equal(existsSync(path.join(f.source, "extension.ts")), true)
    t.diagnostic("Official PluginManager.link rejects Windows directory symlinks without permission; native failure/config integrity verified. Link lifecycle unavailable in this environment.")
    return undefined
  }
}

test("native link lifecycle resolves real manifest resources without executing them", native, async t => {
  const f = fixture(t)
  const inspectedBeforeInstall = await f.packages.resolveSources(f.cwd, [f.source]) as unknown as Resources
  assert.equal(inspectedBeforeInstall.extensions[0]?.path, path.join(f.source, "extension.ts"))
  assert.equal(existsSync(path.join(f.home, ".omp", "plugins", "omp-plugins.lock.json")), false)
  assert.deepEqual((await f.packages.list(f.cwd) as unknown as PackageSnapshot).packages, [])
  const progress: JsonObject[] = []
  const linked = await linkFixture(t, f, progress)
  if (!linked) return
  assert.equal(linked.packages.find(item => item.source === "parity-fixture")?.type, "link")
  assert.deepEqual(progress.map(event => event.phase), ["started", "completed"])
  const lock = path.join(f.home, ".omp", "plugins", "omp-plugins.lock.json")
  const before = readFileSync(lock, "utf8")
  const resources = await f.packages.resolve(f.cwd) as unknown as Resources
  assert.equal(resources.extensions[0]?.path.endsWith("extension.ts"), true)
  assert.equal(resources.extensions[0]?.enabled, true)
  assert.equal(resources.skills[0]?.path.endsWith("SKILL.md"), true)
  assert.equal(resources.commands[0]?.path.endsWith("demo.md"), true)
  assert.equal(resources.prompts[0]?.path.endsWith("demo.md"), true)
  await f.packages.list(f.cwd)
  assert.equal(readFileSync(lock, "utf8"), before)
  await assert.rejects(f.packages.resolveSources(f.cwd, ["missing-plugin"]), /not installed/)
  assert.equal(readFileSync(lock, "utf8"), before)
  await assert.rejects(f.packages.installedPath(f.cwd, "parity-fixture", "project"), /not installed in project scope/)
  await assert.rejects(f.packages.manage(f.cwd, "project", "link", f.source, true), /user scope only/)
  const disabled = await f.packages.manage(f.cwd, "disable", "disable", "parity-fixture") as unknown as PackageSnapshot
  assert.equal(disabled.packages[0]?.enabled, false)
  assert.deepEqual((await f.packages.resolve(f.cwd) as unknown as Resources).extensions, [])
  const inspected = await f.packages.resolveSources(f.cwd, ["parity-fixture"]) as unknown as Resources
  assert.equal(inspected.extensions[0]?.enabled, false)
  const updatedDisabled = await f.packages.manage(f.cwd, "refresh-disabled", "update", "parity-fixture") as unknown as PackageSnapshot
  assert.equal(updatedDisabled.packages[0]?.enabled, false)
  assert.deepEqual((await f.packages.resolve(f.cwd) as unknown as Resources).extensions, [])
  await f.packages.manage(f.cwd, "enable", "enable", "parity-fixture")
  await f.packages.manage(f.cwd, "refresh-link", "update", "parity-fixture")
  assert.equal(existsSync(await f.packages.installedPath(f.cwd, "parity-fixture", "user") as string), true)
  const removed = await f.packages.manage(f.cwd, "remove", "remove", "parity-fixture") as unknown as PackageSnapshot
  assert.deepEqual(removed.packages, [])
  assert.equal(existsSync(path.join(f.source, "extension.ts")), true)
  await assert.rejects(f.packages.manage(f.cwd, "unknown", "remove", "parity-fixture"), /not installed/)
})

test("native marketplace install and upgrade preserve independent user and project scope", native, async t => {
  const f = fixture(t)
  const added = await f.packages.changeSource(f.cwd, f.market, "add") as unknown as PackageSnapshot
  assert.deepEqual(added.marketplaces.map(({ name, source }) => ({ name, source })), [{ name: "fixture", source: f.market }])
  await assert.rejects(f.packages.changeSource(f.cwd, f.market, "add", true), /not project-local/)
  await f.packages.manage(f.cwd, "user", "install", "demo@fixture")
  const project = await f.packages.manage(f.cwd, "project", "install", "demo@fixture", true) as unknown as PackageSnapshot
  assert.equal(project.packages.find(item => item.scope === "user")?.shadowedBy, "project")
  assert.equal(existsSync(path.join(f.cwd, ".omp", "plugins", "installed_plugins.json")), true)
  const active = await f.packages.resolve(f.cwd) as unknown as Resources
  const activeProjectPath = await f.packages.installedPath(f.cwd, "demo@fixture", "project") as string
  assert.equal(active.prompts.some(item => item.path === path.join(activeProjectPath, "prompts", "demo.md")), true)
  assert.equal(active.skills.some(item => item.path === path.join(activeProjectPath, "skills", "demo", "SKILL.md")), true)
  await f.packages.manage(f.cwd, "disable-project", "disable", "demo@fixture", true)
  const resolved = await f.packages.resolve(f.cwd) as unknown as Resources
  assert.equal(resolved.extensions[0]?.source, "demo@fixture")
  assert.equal(resolved.extensions[0]?.enabled, true)
  const userPath = await f.packages.installedPath(f.cwd, "demo@fixture", "user") as string
  const projectRegistry = path.join(f.cwd, ".omp", "plugins", "installed_plugins.json")
  const before = readFileSync(projectRegistry, "utf8")
  await f.packages.resolveSources(f.cwd, ["demo@fixture"], true)
  assert.equal(readFileSync(projectRegistry, "utf8"), before)
  assert.equal(existsSync(path.join(userPath, "extension.ts")), true)
  f.setVersion("2.0.0")
  const updates = await f.packages.checkUpdates(f.cwd) as unknown as Array<{ scope: string; from: string; to: string }>
  assert.deepEqual(updates.map(({ scope, from, to }) => ({ scope, from, to })).sort((a, b) => a.scope.localeCompare(b.scope)), [
    { scope: "project", from: "1.0.0", to: "2.0.0" }, { scope: "user", from: "1.0.0", to: "2.0.0" },
  ])
  const upgraded = await f.packages.manage(f.cwd, "upgrade-project", "update", "demo@fixture", true) as unknown as PackageSnapshot
  assert.equal(upgraded.packages.find(item => item.scope === "project")?.version, "2.0.0")
  assert.equal(upgraded.packages.find(item => item.scope === "project")?.enabled, false)
  assert.equal(upgraded.packages.find(item => item.scope === "user")?.version, "1.0.0")
  await f.packages.manage(f.cwd, "remove-project", "remove", "demo@fixture", true)
  assert.equal(existsSync(await f.packages.installedPath(f.cwd, "demo@fixture", "user") as string), true)
  await f.packages.manage(f.cwd, "remove-user", "remove", "demo@fixture")
  assert.deepEqual((await f.packages.list(f.cwd) as unknown as PackageSnapshot).packages, [])
  await f.packages.changeSource(f.cwd, "fixture", "remove")
  await assert.rejects(f.packages.changeSource(f.cwd, "fixture", "remove"), /not found/)
})

test("native bulk project update ignores read-only project links and reports an empty managed scope", native, async t => {
  const f = fixture(t)
  await assert.rejects(f.packages.manage(f.cwd, "empty-update", "update", undefined, true), /No managed plugins.*project scope/)
  await f.packages.changeSource(f.cwd, f.market, "add")
  await f.packages.manage(f.cwd, "user-install", "install", "demo@fixture")
  await f.packages.manage(f.cwd, "project-install", "install", "demo@fixture", true)
  const projectRoot = path.join(f.cwd, ".omp", "plugins")
  const link = path.join(projectRoot, "node_modules", "readonly-project-link")
  mkdirSync(link, { recursive: true })
  writeFileSync(path.join(link, "package.json"), JSON.stringify({ name: "readonly-project-link", version: "1.0.0", omp: {} }))
  writeFileSync(path.join(projectRoot, "package.json"), JSON.stringify({ dependencies: { "readonly-project-link": "file:./fixture" } }))
  const lock = path.join(projectRoot, "omp-plugins.lock.json")
  const config = JSON.parse(readFileSync(lock, "utf8"))
  config.plugins["readonly-project-link"] = { version: "1.0.0", enabled: true, enabledFeatures: null }
  writeFileSync(lock, JSON.stringify(config))
  await f.packages.manage(f.cwd, "disable-project", "disable", "demo@fixture", true)
  const dependencyBefore = readFileSync(path.join(projectRoot, "package.json"), "utf8")
  f.setVersion("2.0.0")
  const updated = await f.packages.manage(f.cwd, "bulk-project", "update", undefined, true) as unknown as PackageSnapshot
  assert.equal(updated.packages.find(item => item.source === "demo@fixture" && item.scope === "project")?.version, "2.0.0")
  assert.equal(updated.packages.find(item => item.source === "demo@fixture" && item.scope === "project")?.enabled, false)
  assert.equal(updated.packages.find(item => item.source === "demo@fixture" && item.scope === "user")?.version, "1.0.0")
  assert.equal(readFileSync(path.join(projectRoot, "package.json"), "utf8"), dependencyBefore)
  assert.equal(JSON.parse(readFileSync(lock, "utf8")).plugins["readonly-project-link"].version, "1.0.0")
  await assert.rejects(f.packages.manage(f.cwd, "readonly-update", "update", "readonly-project-link", true), /user scope only/)
})

test("selected marketplace update does not fetch an unrelated broken catalog", native, async t => {
  const f = fixture(t)
  await f.packages.changeSource(f.cwd, f.market, "add")
  await f.packages.manage(f.cwd, "install", "install", "demo@fixture")
  const unrelated = path.join(f.root, "unrelated", ".omp-plugin")
  mkdirSync(unrelated, { recursive: true })
  const catalog = path.join(unrelated, "marketplace.json")
  writeFileSync(catalog, JSON.stringify({ name: "unrelated", owner: { name: "fixture" }, plugins: [] }))
  await f.packages.changeSource(f.cwd, path.dirname(unrelated), "add")
  writeFileSync(catalog, "not a valid catalog")
  f.setVersion("2.0.0")
  const updated = await f.packages.manage(f.cwd, "update", "update", "demo@fixture") as unknown as PackageSnapshot
  assert.equal(updated.packages.find(item => item.source === "demo@fixture")?.version, "2.0.0")
  await assert.rejects(f.packages.checkUpdates(f.cwd), /JSON|catalog|Unexpected|parse/i)
})

test("portable MCP inspection does not create native launch data or execute servers", native, async t => {
  const f = fixture(t)
  writeFileSync(path.join(f.source, "plugin.json"), JSON.stringify({ $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json", name: "portable-fixture" }))
  writeFileSync(path.join(f.source, "mcp.json"), JSON.stringify({ $schema: "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json", mcpServers: { demo: { type: "stdio", command: "must-not-run-during-inspection" } } }))
  const resources = await f.packages.resolveSources(f.cwd, [f.source]) as unknown as { mcpServers: Array<{ path: string; name: string; enabled: boolean }> }
  assert.deepEqual(resources.mcpServers, [{ path: path.join(f.source, "mcp.json"), name: "portable-fixture:demo", enabled: true, scope: "user", source: f.source }])
  assert.equal(existsSync(path.join(f.home, ".omp", "plugins", "data")), false)
  assert.equal(existsSync(path.join(f.home, ".omp", "plugins", "omp-plugins.lock.json")), false)
})

test("native link updates preserve feature selection and project override resolution", native, async t => {
  const f = fixture(t)
  writeFileSync(path.join(f.source, "package.json"), JSON.stringify({ name: "parity-fixture", version: "1.0.0", omp: { extensions: ["extension.ts"], features: {
    defaults: { default: true, extensions: ["default-feature.ts"] }, selected: { extensions: ["selected-feature.ts"] },
  } } }))
  writeFileSync(path.join(f.source, "default-feature.ts"), "throw new Error('Inspection must not execute features')\n")
  writeFileSync(path.join(f.source, "selected-feature.ts"), "throw new Error('Inspection must not execute features')\n")
  if (!await linkFixture(t, f)) return
  const defaults = await f.packages.resolve(f.cwd) as unknown as Resources
  assert.deepEqual(defaults.extensions.map(item => path.basename(item.path)), ["extension.ts", "default-feature.ts"])
  const lock = path.join(f.home, ".omp", "plugins", "omp-plugins.lock.json")
  const config = JSON.parse(readFileSync(lock, "utf8"))
  config.plugins['parity-fixture'].enabledFeatures = ['selected']
  writeFileSync(lock, JSON.stringify(config))
  await f.packages.manage(f.cwd, "update", "update", "parity-fixture")
  const selected = await f.packages.resolve(f.cwd) as unknown as Resources
  assert.deepEqual(selected.extensions.map(item => path.basename(item.path)), ["extension.ts", "selected-feature.ts"])
  mkdirSync(path.join(f.cwd, ".omp"), { recursive: true })
  writeFileSync(path.join(f.cwd, ".omp", "plugin-overrides.json"), JSON.stringify({ disabled: ['parity-fixture'] }))
  assert.equal((await f.packages.list(f.cwd) as unknown as PackageSnapshot).packages[0]?.enabled, true)
  assert.deepEqual((await f.packages.resolve(f.cwd) as unknown as Resources).extensions, [])
  const inspected = await f.packages.resolveSources(f.cwd, ['parity-fixture']) as unknown as Resources
  assert.deepEqual(inspected.extensions.map(item => item.enabled), [false, false])
})
