import assert from "node:assert/strict"
import { test } from "node:test"
import { registryFromResources, requireResourceList } from "./resource-registry.js"

const native = { tools: [], activeTools: [], commands: [] }

test("missing resource discovery cannot be reported as an authoritative empty list", () => {
  assert.throws(() => requireResourceList({}, "skills"), /unavailable/)
  assert.throws(() => requireResourceList({ resourceErrors: { prompts: "Native discovery failed" } }, "prompts"), /Native discovery failed/)
  const unknown = registryFromResources(native, "18.3.1")
  assert.equal(unknown.extensions, null)
  assert.equal(unknown.eventHandlers, null)
  assert.match(String(unknown.resourceErrors?.extensions), /unavailable/)
  assert.deepEqual(registryFromResources({ ...native, extensions: [], eventHandlers: [] }, "18.3.1").eventHandlers, [])
})

test("a malformed extension enumeration does not hide tools or falsely unregister handlers", () => {
  const result = registryFromResources({
    tools: [{ name: "loaded-tool", parameters: {} }], activeTools: ["loaded-tool"], commands: [],
    extensions: [{ path: "/loaded.mjs", tools: null, commands: [], handlers: [] }],
    skillWarnings: [{ skillPath: "/bad/SKILL.md", message: "Invalid description" }],
  }, "18.3.1")
  assert.equal(result.extensions, null)
  assert.equal(result.eventHandlers, null)
  assert.equal(result.tools[0]?.name, "loaded-tool")
  assert.deepEqual(result.skillWarnings, [{ skillPath: "/bad/SKILL.md", message: "Invalid description" }])
})
