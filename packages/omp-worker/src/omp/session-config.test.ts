import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { it } from "node:test"
import { isJsonObject, type JsonObject } from "@ompiui/protocol"
import { OmpCatalog } from "./omp-catalog.js"
import { sessionConfigFromBranch } from "./session-config.js"

it("restores the explicit default model instead of an auxiliary role or temporary fallback", () => {
  const branch: JsonObject[] = [
    { type: "model_change", model: "openai/gpt-primary" },
    { type: "thinking_level_change", thinkingLevel: "high" },
    { type: "model_change", role: "small", model: "openai/gpt-small" },
    { type: "message", message: { role: "assistant", provider: "other", model: "fallback" } },
  ]
  assert.deepEqual(sessionConfigFromBranch(branch), {
    model: { provider: "openai", id: "gpt-primary" }, thinkingLevel: "high",
  })
})

it("supports legacy model changes and assistant messages without explicit model metadata", () => {
  assert.deepEqual(sessionConfigFromBranch([
    { type: "message", message: { role: "assistant", provider: "openai", model: "legacy" } },
  ]), { model: { provider: "openai", id: "legacy" }, thinkingLevel: "off" })
  assert.deepEqual(sessionConfigFromBranch([
    { type: "model_change", provider: "custom", modelId: "org/model" },
    { type: "thinking_level_change", thinkingLevel: "max" },
  ]), { model: { provider: "custom", id: "org/model" }, thinkingLevel: "max" })
  assert.deepEqual(sessionConfigFromBranch([
    { type: "model_change", model: "custom/org/model" },
  ]), { model: { provider: "custom", id: "org/model" }, thinkingLevel: "off" })
})

it("disk preview and state.get restore configuration from the active branch, not abandoned siblings", async t => {
  const root = mkdtempSync(path.join(tmpdir(), "ompiui-config-preview-"))
  const previous = process.env.OMPIUI_DATA_DIR
  process.env.OMPIUI_DATA_DIR = root
  t.after(() => {
    if (previous === undefined) delete process.env.OMPIUI_DATA_DIR
    else process.env.OMPIUI_DATA_DIR = previous
    rmSync(root, { recursive: true, force: true })
  })
  const directory = path.join(root, "sessions", "project")
  mkdirSync(directory, { recursive: true })
  const file = path.join(directory, "session.jsonl")
  writeFileSync(file, [
    { type: "session", version: 3, id: "session-config", cwd: root },
    { type: "model_change", id: "model", parentId: null, model: "openai/correct" },
    { type: "thinking_level_change", id: "thinking", parentId: "model", thinkingLevel: "xhigh" },
    { type: "model_change", id: "abandoned-model", parentId: "thinking", model: "other/wrong" },
    { type: "thinking_level_change", id: "abandoned-thinking", parentId: "abandoned-model", thinkingLevel: "low" },
    { type: "message", id: "current", parentId: "thinking", message: { role: "user", content: "branch" } },
  ].map(entry => JSON.stringify(entry)).join("\n"))
  const catalog = new OmpCatalog()
  t.after(() => catalog.dispose())
  const preview = await catalog.previewSession(root, file)
  assert.ok(isJsonObject(preview) && isJsonObject(preview.state))
  assert.deepEqual(preview.state.model, { provider: "openai", id: "correct" })
  assert.equal(preview.state.thinkingLevel, "xhigh")
  const state = await catalog.readSession("session-config", "state.get")
  assert.ok(isJsonObject(state))
  assert.deepEqual(state.model, preview.state.model)
  assert.equal(state.thinkingLevel, preview.state.thinkingLevel)
  assert.equal(state.isStreaming, false)
})
