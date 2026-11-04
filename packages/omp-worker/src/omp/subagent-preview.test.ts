import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { isJsonObject, type JsonObject } from "@ompiui/protocol";
import { projectPreviewMessage, readSubagentPreview } from "./subagent-preview.js";
import { readSubagentSync } from "./subagent-sync.js";

async function fixture(t: { after: (fn: () => Promise<void>) => void }) {
  const root = await mkdtemp(path.join(tmpdir(), "ompiui-preview-budget-"));
  assert.ok(path.resolve(root).startsWith(path.resolve(tmpdir()) + path.sep));
  const previous = process.env.OMPIUI_DATA_DIR;
  process.env.OMPIUI_DATA_DIR = root;
  t.after(async () => {
    if (previous === undefined) delete process.env.OMPIUI_DATA_DIR;
    else process.env.OMPIUI_DATA_DIR = previous;
    await rm(root, { recursive: true, force: true });
  });
  return path.join(root, "child.jsonl");
}

function pageMessages(page: JsonObject): JsonObject[] {
  if (Array.isArray(page.messages)) {
    assert.ok(page.messages.every(isJsonObject));
    return page.messages;
  }
  assert.ok(Array.isArray(page.blocks));
  const messages: JsonObject[] = [];
  for (const block of page.blocks) {
    assert.ok(isJsonObject(block) && Array.isArray(block.messages));
    assert.equal(block.kind, "data");
    assert.ok(block.messages.every(isJsonObject));
    messages.push(...block.messages);
  }
  return messages;
}

const line = (message: JsonObject) => JSON.stringify({ type: "message", message }) + "\n";
const readers = [
  { name: "legacy", read: readSubagentPreview },
  {
    name: "sync",
    read: (file: string, cursor: number) => readSubagentSync(file, cursor, { version: 1, knownBlocks: [] }),
  },
];

for (const reader of readers) {
  test(`${reader.name} preview budgets encoded text and complete envelopes on first and later pages`, async (t) => {
    const file = await fixture(t);
    for (const unit of ["x", "中", "😀", "\u0001", '"\\', "\ud800"]) {
      const text = "visible:" + unit.repeat(128 * 1024);
      const source = line({ role: "assistant", content: text }).repeat(3) + line({ role: "assistant", content: "after" });
      await writeFile(file, source);
      let cursor = 0;
      let pages = 0;
      let truncated = false;
      const messages: JsonObject[] = [];
      for (;;) {
        const page = await reader.read(file, cursor);
        assert.ok(Buffer.byteLength(JSON.stringify(page)) <= 256 * 1024);
        assert.ok(typeof page.nextByte === "number" && Number.isSafeInteger(page.nextByte));
        assert.ok(page.nextByte > cursor);
        cursor = page.nextByte;
        messages.push(...pageMessages(page));
        truncated ||= page.previewTruncated === true ||
          (Array.isArray(page.blocks) && page.blocks.some(block => isJsonObject(block) && block.previewTruncated === true));
        assert.ok(++pages < 20);
        if (!page.hasMore) break;
      }
      assert.equal(cursor, Buffer.byteLength(source));
      assert.equal(messages.length, 4);
      assert.equal(messages.at(-1)?.content, "after");
      assert.equal(truncated, true);
      for (const message of messages.slice(0, -1)) {
        assert.ok(typeof message.content === "string");
        assert.ok(message.content.startsWith("visible:"));
        assert.ok(text.startsWith(message.content));
        if (unit === "😀") assert.equal(message.content.isWellFormed(), true);
      }
      assert.equal(await readFile(file, "utf8"), source);
    }
  });

  test(`${reader.name} preview reserves tool identifiers without truncating their linkage`, async (t) => {
    const file = await fixture(t);
    const id = "call_read_01a0f3a5a14c700098468a3122d65294";
    const source = [
      {
        role: "assistant",
        content: [
          { type: "text", text: "answer".repeat(30000) },
          { type: "toolCall", id, name: "read" },
        ],
      },
      { role: "toolResult", toolCallId: id, toolName: "read", content: "result".repeat(30000) },
      { role: "assistant", content: "follow-up".repeat(20000) },
    ].map(line).join("");
    await writeFile(file, source);
    const messages: JsonObject[] = [];
    let cursor = 0;
    let pages = 0;
    for (;;) {
      const page = await reader.read(file, cursor);
      pages++;
      assert.ok(Buffer.byteLength(JSON.stringify(page)) <= 256 * 1024);
      assert.ok(typeof page.nextByte === "number" && page.nextByte > cursor);
      cursor = page.nextByte;
      messages.push(...pageMessages(page));
      if (!page.hasMore) break;
    }
    assert.ok(pages > 1, "text and tool results must compete for the page budget");
    assert.equal(messages.length, 3);
    assert.ok(Array.isArray(messages[0].content));
    const call = messages[0].content.find(block => isJsonObject(block) && block.type === "toolCall");
    assert.ok(isJsonObject(call));
    assert.equal(call.id, id);
    assert.equal(messages[1].toolCallId, id);
    assert.ok(typeof messages[1].content === "string" && messages[1].content.length < "result".repeat(30000).length);
    assert.equal(messages[2].role, "assistant");
    assert.equal(cursor, Buffer.byteLength(source));
    assert.equal(await readFile(file, "utf8"), source);
  });
}

test("preview text clipping preserves the newest thinking tail and never mutates source blocks", () => {
  const message: JsonObject = {
    role: "assistant",
    content: [
      { type: "thinking", thinking: "old".repeat(4000) + "newest😀\u0001" },
      { type: "text", text: "answer\u0001".repeat(20000) },
      { type: "toolCall", id: "read-call", name: "read", arguments: { path: "original" } },
    ],
  };
  const original = structuredClone(message);
  const projected = projectPreviewMessage(message, true);
  assert.ok(Array.isArray(projected.message.content));
  const thinking = projected.message.content[0];
  assert.ok(isJsonObject(thinking) && typeof thinking.thinking === "string");
  assert.ok(thinking.thinking.endsWith("newest😀\u0001"));
  assert.equal(projected.truncated, true);
  assert.ok(Buffer.byteLength(JSON.stringify(projected.message)) <= 256 * 1024);
  assert.deepEqual(message, original);
});

test("preview retains content and nested details images beside ordinary text", () => {
  const image: JsonObject = { type: "image", mimeType: "image/png", data: "", attachment: { sessionId: "child", entryId: "result", blockIndex: 0, source: "details", etag: "native-image" } }
  const source: JsonObject = { role: "toolResult", content: "Native outcome", details: [{ nested: [image] }] }
  const original = structuredClone(source)
  const projected = projectPreviewMessage(source, false)
  assert.deepEqual(projected.message.content, [{ type: "text", text: "Native outcome" }, image])
  assert.deepEqual(source, original)
  assert.deepEqual(projectPreviewMessage({ role: "assistant", content: [image] }, false).message.content, [image])
})
