import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, writeFile, appendFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { JsonObject } from "@ompiui/protocol";
import { MainMessageStream } from "./main-message-stream.js";
import { getPreviewSettings, setPreviewSettings } from "./preview-settings.js";
import { readSubagentPreview } from "./subagent-preview.js";
import { scanJsonl } from "./jsonl-reader.js";
import { buildSessionTreeFromEntries } from "../runtime/session-tree.js";
import {
  entriesPageFromEntries,
  imageAttachmentFromEntry,
} from "../runtime/pagination.js";
import { SubagentMessageStream } from "./subagent-message-stream.js";

test("main text and tool string arguments use lossless bounded deltas", () => {
  const events: JsonObject[] = [];
  const stream = new MainMessageStream((event) => events.push(event));
  let text = "";
  let restored = "";
  for (let index = 0; index < 100; index++) {
    text += "x".repeat(500);
    stream.push(
      {
        type: "message_update",
        message: {
          role: "assistant",
          content: [
            { type: "text", text },
            {
              type: "toolCall",
              id: "write",
              name: "write",
              arguments: { content: text },
            },
          ],
        },
      },
      { id: "message", revision: index + 1 },
    );
  }
  for (const event of events.filter((event) => event.field === "text")) {
    assert.equal(event.offset, restored.length);
    restored += event.delta;
  }
  assert.equal(restored, text);
  assert.equal(
    events
      .filter((event) => event.argument === "content")
      .reduce((size, event) => size + String(event.delta).length, 0),
    text.length,
  );
  assert.ok(Buffer.byteLength(JSON.stringify(events)) < 200000);
  assert.equal(events.at(-1)?.complete, true);
});

test("JSONL scans preserve entries on append and reinitialize on replacement", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "ompiui-jsonl-audit-"));
  assert.ok(path.resolve(root).startsWith(path.resolve(tmpdir()) + path.sep));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = path.join(root, "session.jsonl");
  await writeFile(file, '{"type":"session","id":"original","cwd":"."}\n');
  const entries: JsonObject[] = [];
  const reset = () => {
    entries.length = 0;
  };
  let position = await scanJsonl(
    file,
    undefined,
    (entry) => entries.push(entry),
    reset,
  );
  const first = entries[0];
  await appendFile(
    file,
    '{"type":"message","id":"second","message":{"role":"assistant","content":"中文😀"}}\n',
  );
  position = await scanJsonl(
    file,
    position,
    (entry) => entries.push(entry),
    reset,
  );
  assert.equal(entries[0], first);
  assert.equal(entries.length, 2);
  assert.equal(
    await scanJsonl(file, position, (entry) => entries.push(entry), reset),
    position,
  );
  await writeFile(file, '{"type":"session","id":"replacement","cwd":"."}\n');
  await scanJsonl(file, position, (entry) => entries.push(entry), reset);
  assert.equal(entries.length, 1);
  assert.equal(entries[0]?.id, "replacement");
});

test("thinking is disabled by default, persisted and filtered without changing the source", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "ompiui-preview-audit-"));
  assert.ok(path.resolve(root).startsWith(path.resolve(tmpdir()) + path.sep));
  const previous = process.env.OMPIUI_DATA_DIR;
  process.env.OMPIUI_DATA_DIR = root;
  t.after(async () => {
    if (previous === undefined) delete process.env.OMPIUI_DATA_DIR;
    else process.env.OMPIUI_DATA_DIR = previous;
    await rm(root, { recursive: true, force: true });
  });
  assert.equal(getPreviewSettings().subagentThinking, false);
  const file = path.join(root, "child.jsonl");
  const source =
    JSON.stringify({
      type: "message",
      message: {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "private reasoning" },
          { type: "text", text: "answer" },
        ],
      },
    }) + "\n";
  await writeFile(file, source);
  let page = await readSubagentPreview(file, 0);
  assert.equal(JSON.stringify(page).includes("private reasoning"), false);
  assert.equal(page.nextByte, Buffer.byteLength(source));
  await setPreviewSettings(true);
  page = await readSubagentPreview(file, 0);
  assert.ok(JSON.stringify(page).includes("private reasoning"));
  assert.equal(
    JSON.parse(await readFile(path.join(root, "preview-settings.json"), "utf8"))
      .subagentThinking,
    true,
  );
  await setPreviewSettings(false);
  const frames: JsonObject[] = [];
  const stream = new SubagentMessageStream((frame) => frames.push(frame));
  stream.push({
    kind: "event",
    payload: {
      id: "child",
      event: {
        type: "message_start",
        message: {
          role: "assistant",
          content: [{ type: "thinking", thinking: "never send" }],
        },
      },
    },
  });
  assert.equal(JSON.stringify(frames).includes("never send"), false);
  assert.equal(await readFile(file, "utf8"), source);
});

test("large images become references and deep trees serialize without nested recursion", () => {
  const image = {
    type: "image",
    mimeType: "image/png",
    data: "A".repeat(300000),
  };
  const entry: JsonObject = {
    id: "photo",
    type: "message",
    message: { role: "user", content: [image] },
  };
  const head = {
    sdkVersion: "test",
    revision: 1,
    header: { id: "session" },
    leafId: "photo",
    entryCount: 1,
    epoch: "test",
  };
  const page = entriesPageFromEntries(
    head,
    [entry],
    { limit: 100, maxBytes: 4096 },
    (entry) => entry,
  );
  assert.ok(Buffer.byteLength(JSON.stringify(page)) < 4096);
  assert.equal(imageAttachmentFromEntry(entry, 0).hasMore, true);
  assert.equal(image.data.length, 300000);
  const entries = Array.from({ length: 10000 }, (_, index) => ({
    id: String(index),
    parentId: index ? String(index - 1) : null,
    type: "message",
    message: {
      role: "user",
      content: [{ type: "text", text: "x".repeat(10000) }],
    },
  }));
  const tree = buildSessionTreeFromEntries(entries, true);
  assert.equal(tree.length, 10000);
  assert.ok(Buffer.byteLength(JSON.stringify(tree)) < 8 * 1024 * 1024);
  assert.ok(tree.every((node) => node.children.length === 0));
});
