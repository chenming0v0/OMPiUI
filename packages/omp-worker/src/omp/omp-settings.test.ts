import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { test } from "node:test"
import type { TestContext } from "node:test"
import type { JsonObject } from "@ompiui/protocol"
import { getOmpSettings, patchOmpSettings } from "./omp-settings.js"
import { resolveOmpPackageRoot } from "./omp-native-script.js"

// Opt in to real installed public API integration; every config and HOME lives in a temporary fixture.
const integration = process.env.OMPI_OMP_SETTINGS_INTEGRATION === "1"

function fixture(t: TestContext) {
  const packageRoot = resolveOmpPackageRoot()
  const root = mkdtempSync(path.join(tmpdir(), "ompiui-official-settings-"))
  const agent = path.join(root, "agent")
  const workspace = path.join(root, "workspace")
  const keys = ["HOME", "USERPROFILE", "PI_CODING_AGENT_DIR", "OMP_PROFILE", "PI_PROFILE", "PI_CONFIG_FILES", "PI_CONFIG_DIR", "OMPI_OMP_PACKAGE_ROOT", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME", "XDG_CACHE_HOME"]
  const previous = Object.fromEntries(keys.map(key => [key, process.env[key]]))
  mkdirSync(agent, { recursive: true })
  mkdirSync(path.join(workspace, ".omp"), { recursive: true })
  for (const key of keys) delete process.env[key]
  process.env.HOME = root
  process.env.USERPROFILE = root
  process.env.PI_CODING_AGENT_DIR = agent
  process.env.OMPI_OMP_PACKAGE_ROOT = packageRoot
  t.after(() => {
    for (const key of keys) {
      if (previous[key] === undefined) delete process.env[key]
      else process.env[key] = previous[key]
    }
    rmSync(root, { recursive: true, force: true })
  })
  const config = path.join(agent, "config.yml")
  const project = path.join(workspace, ".omp", "config.yml")
  writeFileSync(config, "defaultThinkingLevel: low\nmodelRoles:\n  default: provider/old\n  task: provider/task\ncompaction:\n  enabled: false\n")
  writeFileSync(project, "defaultThinkingLevel: high\ncompaction:\n  enabled: true\n")
  return { workspace, config, project, agent }
}

test("official raw scopes and effective project precedence survive global patches and null resets", { skip: !integration }, async t => {
  const f = fixture(t)
  const before = await getOmpSettings(f.workspace) as JsonObject
  assert.equal((before.global as JsonObject).defaultThinkingLevel, "low")
  assert.equal((before.project as JsonObject).defaultThinkingLevel, "high")
  assert.equal((before.effective as JsonObject).defaultThinkingLevel, "high")
  const saved = await patchOmpSettings(f.workspace, {
    "modelRoles.default": "provider/new",
    defaultThinkingLevel: "medium",
    retry: { enabled: false },
    "skills.enableSkillCommands": false,
  }) as JsonObject
  assert.deepEqual((saved.global as JsonObject).modelRoles, { default: "provider/new", task: "provider/task" })
  assert.equal((saved.effective as JsonObject).defaultThinkingLevel, "high")
  assert.equal(((saved.global as JsonObject).retry as JsonObject).enabled, false)
  assert.equal(((saved.global as JsonObject).skills as JsonObject).enableSkillCommands, false)
  const reset = await patchOmpSettings(f.workspace, { defaultThinkingLevel: null, modelRoles: { default: null } }) as JsonObject
  assert.equal((reset.global as JsonObject).defaultThinkingLevel, undefined)
  assert.deepEqual((reset.global as JsonObject).modelRoles, { task: "provider/task" })
  assert.equal((reset.effective as JsonObject).defaultThinkingLevel, "high")
  assert.equal(readFileSync(f.project, "utf8"), "defaultThinkingLevel: high\ncompaction:\n  enabled: true\n")
})

test("invalid and unknown patches reject before any global bytes change", { skip: !integration }, async t => {
  const f = fixture(t)
  const original = readFileSync(f.config)
  for (const patch of [
    { defaultThinkingLevel: "invalid", "retry.enabled": false },
    { "retry.enabled": false, defaultProvider: "fake" },
    { "compaction.enabled": "false" },
    { 'retry.enabled': false, 'providers.maxInFlightRequests': [] },
    { 'retry.enabled': false, 'providers.maxInFlightRequests': 'invalid' },
    { 'providers.maxInFlightRequests': { invalid: 0 } },
    { modelRoles: { default: 42 } },
    { modelRoles: null, 'modelRoles.default': 'provider/conflict' },
    { 'retry.enabled': false, retry: { enabled: true } },
    JSON.parse('{"__proto__":{"polluted":true}}') as JsonObject,
  ]) {
    await assert.rejects(patchOmpSettings(f.workspace, patch), /Invalid|Unknown|must be|Cannot|Duplicate/)
    assert.deepEqual(readFileSync(f.config), original)
  }
})

test("writes preserve external sibling settings and exact pre-write backup bytes", { skip: !integration }, async t => {
  const f = fixture(t)
  const original = readFileSync(f.config)
  await patchOmpSettings(f.workspace, { "modelRoles.default": "provider/first" })
  assert.deepEqual(readFileSync(f.config + ".bak"), original)
  // Official Bun YAML serialization need not terminate with a newline; an external edit must add its own separator.
  const externalTheme = Buffer.concat([readFileSync(f.config), Buffer.from("\ntheme:\n  dark: external-dark\n  light: external-light\n")])
  writeFileSync(f.config, externalTheme)
  const saved = await patchOmpSettings(f.workspace, { "modelRoles.default": "provider/second", theme: { dark: "selected-dark" } }) as JsonObject
  assert.deepEqual(readFileSync(f.config + ".bak"), externalTheme)
  assert.deepEqual((saved.global as JsonObject).theme, { dark: "selected-dark", light: "external-light" })
  assert.equal(((saved.global as JsonObject).modelRoles as JsonObject).task, "provider/task")
  const externalNamespace = Buffer.concat([readFileSync(f.config), Buffer.from('\nextensionNamespace:\n  keep: original\n')])
  writeFileSync(f.config, externalNamespace)
  const unrelated = await patchOmpSettings(f.workspace, { defaultThinkingLevel: 'auto' }) as JsonObject
  assert.deepEqual(readFileSync(f.config + '.bak'), externalNamespace)
  assert.deepEqual((unrelated.global as JsonObject).extensionNamespace, { keep: 'original' })
  assert.equal((unrelated.global as JsonObject).defaultThinkingLevel, 'auto')
  const readback = await getOmpSettings(f.workspace) as JsonObject
  assert.deepEqual(readback.global, unrelated.global)
  assert.deepEqual((readback.global as JsonObject).theme, { dark: 'selected-dark', light: 'external-light' })
  assert.deepEqual((readback.global as JsonObject).modelRoles, { default: 'provider/second', task: 'provider/task' })
})

test("malformed official config fails loudly without modifying it", { skip: !integration }, async t => {
  const f = fixture(t)
  const malformed = "modelRoles: [unterminated\n"
  writeFileSync(f.config, malformed)
  await assert.rejects(getOmpSettings(f.workspace), /invalid|failed|parse|Invalid/i)
  await assert.rejects(patchOmpSettings(f.workspace, { "retry.enabled": false }), /invalid|failed|parse|Invalid/i)
  assert.equal(readFileSync(f.config, "utf8"), malformed)
})

test("malformed global setting groups cannot be silently overwritten by a leaf patch", { skip: !integration }, async t => {
  const f = fixture(t)
  const malformed = 'retry: false\nextensionNamespace:\n  keep: untouched\n'
  writeFileSync(f.config, malformed)
  await assert.rejects(getOmpSettings(f.workspace), /Invalid OMP settings group: retry/)
  await assert.rejects(patchOmpSettings(f.workspace, { 'retry.enabled': true }), /Invalid OMP settings group: retry/)
  assert.equal(readFileSync(f.config, 'utf8'), malformed)
})

test("a non-file backup destination rejects before changing the config or relocating the collision", { skip: !integration }, async t => {
  const f = fixture(t)
  const original = readFileSync(f.config)
  mkdirSync(f.config + '.bak')
  const marker = path.join(f.config + '.bak', 'keep.txt')
  writeFileSync(marker, 'unchanged')
  await assert.rejects(patchOmpSettings(f.workspace, { 'compaction.enabled': true }), /backup path is not a file/)
  assert.deepEqual(readFileSync(f.config), original)
  assert.equal(statSync(f.config + '.bak').isDirectory(), true)
  assert.equal(readFileSync(marker, 'utf8'), 'unchanged')
})
