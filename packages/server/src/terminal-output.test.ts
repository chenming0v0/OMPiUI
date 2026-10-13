import assert from "node:assert/strict";
import test from "node:test";
import { splitTerminalOutput } from "./terminal-output.ts";

test("terminal output uses actual JSON bytes while preserving unicode and character cursors", () => {
  for (const text of ["x".repeat(32768), "中文😀".repeat(10000), "\0\n\t\"\\".repeat(10000), "\ud800".repeat(10000)]) {
    const chunks = splitTerminalOutput(text);
    assert.equal(chunks.join(""), text);
    for (const chunk of chunks) {
      assert.ok(Buffer.byteLength(JSON.stringify({ type: "output", cursor: Number.MAX_SAFE_INTEGER, data: chunk })) <= 32768);
    }
  }
  assert.equal(splitTerminalOutput("x".repeat(32768)).length, 2);
});
