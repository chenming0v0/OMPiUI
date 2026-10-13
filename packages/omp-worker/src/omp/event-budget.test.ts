import assert from "node:assert/strict";
import test from "node:test";
import { EventSnapshotBuffer } from "./event-snapshot-buffer.js";
import { projectStateImages, projectToolUpdate } from "./event-payload.js";
import { sessionTreePage } from "../runtime/session-tree.js";
import type { JsonObject } from "@ompiui/protocol";

test("large cumulative snapshots coalesce without serializing each update", () => {
  const emitted: unknown[] = [];
  const buffer = new EventSnapshotBuffer(value => emitted.push(value));
  const event = { text: "x".repeat(2 * 1024 * 1024), toJSON() { throw new Error("must not serialize") } };
  for (let i = 0; i < 1000; i++) buffer.push("session", "message", event);
  assert.equal(emitted.length, 0);
  buffer.flush();
  assert.deepEqual(emitted, [event]);
});

test("tool snapshots keep a bounded UTF-8 suffix and preserve final results", () => {
  const text = "中文🙂".repeat(100_000);
  const event: JsonObject = { type: "tool_execution_update", args: { secret: true }, partialResult: { content: [{ type: "text", text }] } };
  const result = projectToolUpdate(event);
  const tail = (((result.partialResult as JsonObject).content as JsonObject[])[0]!.text as string);
  assert.ok(Buffer.byteLength(tail) <= 256 * 1024);
  assert.ok(text.endsWith(tail));
  assert.equal(result.args, undefined);
  assert.equal((((event.partialResult as JsonObject).content as JsonObject[])[0]!.text), text);
  const final: JsonObject = { ...event, type: "tool_execution_end" };
  assert.equal(projectToolUpdate(final), final);
});

test("state projection does not mutate or repeat large images", () => {
  const source: JsonObject = { images: [{ type: "image", mimeType: "image/png", data: "A".repeat(1024 * 1024) }] };
  const projected = projectStateImages(source);
  assert.ok(Buffer.byteLength(JSON.stringify(projected)) < 1024);
  assert.equal(String((source.images as JsonObject[])[0]!.data).length, 1024 * 1024);
  assert.equal((projected.images as JsonObject[])[0]!.dataOmitted, true);
});

test("tree pages are byte bounded and restore every node with labels", () => {
  const entries: JsonObject[] = Array.from({ length: 800 }, (_, i) => ({
    id: String(i), parentId: i ? String(i - 1) : null, type: "message",
    message: { role: "user", content: "中文".repeat(1000) },
  }));
  entries.push({ id: "label", type: "label", targetId: "1", label: "marked" });
  const head = { sdkVersion: "test", revision: 1, epoch: "test", header: { id: "s" }, leafId: "799", entryCount: entries.length };
  let cursor: string | undefined;
  const nodes: JsonObject[] = [];
  do {
    const page = sessionTreePage(entries, head, { cursor, limit: 200, maxBytes: 8192 });
    assert.ok(Buffer.byteLength(JSON.stringify(page)) <= 8192);
    nodes.unshift(...page.items as JsonObject[]);
    cursor = page.hasMore ? page.beforeCursor as string : undefined;
  } while (cursor);
  assert.equal(nodes.length, entries.length);
  assert.equal(nodes[1]!.label, "marked");
});
