import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { test } from "node:test"
import type { JsonObject } from "@ompiui/protocol"
import { getOmpPreviewControls, getOmpPreviewSkills } from "./omp-preview-resources.js"
import { resolveOmpPackageRoot } from "./omp-native-script.js"

const integration = process.env.OMPI_OMP_SETTINGS_INTEGRATION === "1"

test("cold configuration and Skills use the official read-only loaders without modifying history or settings", { skip: !integration }, async t => {
  const packageRoot = resolveOmpPackageRoot()
  const root = mkdtempSync(path.join(tmpdir(), "ompiui-preview-resources-"))
  const agent = path.join(root, "agent")
  const workspace = path.join(root, "workspace")
  const keys = ["HOME", "USERPROFILE", "PI_CODING_AGENT_DIR", "OMP_PROFILE", "PI_PROFILE", "PI_CONFIG_FILES", "PI_CONFIG_DIR", "OMPI_OMP_PACKAGE_ROOT", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME", "XDG_CACHE_HOME"]
  const previous = Object.fromEntries(keys.map(key => [key, process.env[key]]))
  mkdirSync(agent, { recursive: true })
  mkdirSync(path.join(workspace, ".omp"), { recursive: true })
  const skillDir = path.join(workspace, "custom-skills", "preview-fixture")
  mkdirSync(skillDir, { recursive: true })
  writeFileSync(path.join(skillDir, "SKILL.md"), "---\nname: preview-fixture\ndescription: Read-only discovery fixture\n---\nNever execute during discovery.\n")
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
  const history = path.join(agent, "history.jsonl")
  writeFileSync(config, "compaction:\n  enabled: true\nretry:\n  enabled: false\ninterruptMode: immediate\n")
  writeFileSync(project, "compaction:\n  enabled: false\ninterruptMode: wait\nskills:\n  customDirectories:\n    - custom-skills\n")
  writeFileSync(history, '{"type":"session","id":"preview-fixture"}\n')
  const before = [config, project, history].map(file => ({ file, bytes: readFileSync(file), mtime: statSync(file).mtimeMs }))
  const controls = await getOmpPreviewControls(workspace)
  assert.equal(controls.source, "configuration")
  assert.equal(controls.interruptMode, "wait")
  assert.equal((controls.compaction as JsonObject).autoEnabled, false)
  assert.equal((controls.retry as JsonObject).autoEnabled, false)
  // Configured modes must not impersonate the managed runtime's per-process all policy.
  assert.equal(controls.queue, undefined)
  const skills = await getOmpPreviewSkills(workspace) as JsonObject[]
  assert.ok(skills.some(skill => skill.name === "preview-fixture"))
  for (const original of before) {
    assert.deepEqual(readFileSync(original.file), original.bytes)
    assert.equal(statSync(original.file).mtimeMs, original.mtime)
  }
  writeFileSync(project, readFileSync(project, "utf8") + "disabledExtensions:\n  - skill:preview-fixture\n")
  const disabled = await getOmpPreviewSkills(workspace) as JsonObject[]
  assert.ok(!disabled.some(skill => skill.name === "preview-fixture"))
  for (const original of before.filter(item => item.file !== project)) {
    assert.deepEqual(readFileSync(original.file), original.bytes)
    assert.equal(statSync(original.file).mtimeMs, original.mtime)
  }
  assert.ok(!readdirSync(agent).some(name => /\.db$|migrat|marker/.test(name)))
})
