import assert from "node:assert/strict";
import test from "node:test";
import { PI_COMMAND_SPECS, jsonByteSize, validateParams } from "./index.js";

test("bounded JSON measurement agrees with the wire encoding", () => {
  for (const value of [null, true, 3, ["中", "\uD800", "🙂", "\n", '"\\'], { nested: { a: "abc", missing: undefined }, n: Infinity }]) {
    const size = Buffer.byteLength(JSON.stringify(value));
    assert.equal(jsonByteSize(value, 10000), size);
    assert.equal(jsonByteSize(value, size - 1), size);
    assert.equal(jsonByteSize(value, 1), Math.min(size, 2));
  }
});

test("arbitrary JSON fields and nested disk read limits are bounded", () => {
  const schema = (name: string) => PI_COMMAND_SPECS.find(spec => spec.name === name)!.paramsSchema;
  const huge = { text: "x".repeat(9 * 1024 * 1024) };
  for (const [name, params] of [
    ["invokeTool", { name: "write", arguments: huge }],
    ["sendCustomMessage", { customType: "test", content: [{ type: "text", text: "ok" }], display: true, details: huge }],
    ["appendCustomEntry", { customType: "test", data: huge }],
    ["respondExtensionUi", { requestId: "test", response: huge }],
    ["settings.patch", { cwd: ".", patch: huge }],
    ["modelRuntime.refresh", { options: huge }],
    ["modelRoles.set", { roles: huge }],
    ["session.read", { sessionId: "s", query: "entries.get", params: { limit: 1000, maxBytes: 100 * 1024 * 1024 } }],
  ] as const) {
    assert.throws(() => validateParams(schema(name), params), { code: "INVALID_REQUEST" });
  }
  validateParams(schema("session.read"), { sessionId: "s", query: "entries.get", params: { limit: 200, maxBytes: 4 * 1024 * 1024 } });
  assert.throws(() => validateParams(schema("setSessionName"), { name: "中".repeat(342) }), { code: "INVALID_REQUEST" });
  assert.throws(() => validateParams(schema("setExtensionEditorState"), { text: "x".repeat(256 * 1024 + 1) }), { code: "INVALID_REQUEST" });
});
