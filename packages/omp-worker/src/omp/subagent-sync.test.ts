import assert from "node:assert/strict";
import test from "node:test";
import { appendFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { isJsonObject, type SubagentBlockRef, type SubagentSyncPage } from "@ompiui/protocol";
import { readSubagentSync } from "./subagent-sync.js";
import { readSubagentPreview } from "./subagent-preview.js";
import { readSyncedSubagentHistory, type FetchSubagentPage } from "../../../app/src/omp/subagentSync.js";
import { clearSubagentBlockMemory, loadSubagentBlocks, saveSubagentBlocks } from "../../../app/src/omp/subagentBlockCache.js";

const line = (text: string) =>
  JSON.stringify({
    type: "message",
    message: { role: "assistant", content: text },
  }) + "\n";

async function fixture(
  t: { after: (fn: () => Promise<void>) => void },
  source: string,
) {
  const root = await mkdtemp(path.join(tmpdir(), "ompiui-subagent-sync-"));
  assert.ok(path.resolve(root).startsWith(path.resolve(tmpdir()) + path.sep));
  const previous = process.env.OMPIUI_DATA_DIR;
  process.env.OMPIUI_DATA_DIR = root;
  t.after(async () => {
    if (previous === undefined) delete process.env.OMPIUI_DATA_DIR;
    else process.env.OMPIUI_DATA_DIR = previous;
    await rm(root, { recursive: true, force: true });
  });
  const file = path.join(root, "child.jsonl");
  await writeFile(file, source);
  return file;
}

async function page(
  file: string,
  fromByte = 0,
  knownBlocks: SubagentBlockRef[] = [],
  snapshot?: string,
) {
  return (await readSubagentSync(file, fromByte, {
    version: 1,
    knownBlocks,
    snapshot,
  })) as unknown as SubagentSyncPage;
}

test("unchanged child history reuses hashes without any message body and leaves native history untouched", async (t) => {
  const source = line("中文 history");
  const file = await fixture(t, source);
  const first = await page(file);
  assert.equal(first.blocks[0]?.kind, "data");
  const second = await page(file, 0, first.blocks);
  assert.equal(second.blocks[0]?.kind, "reuse");
  assert.ok(!JSON.stringify(second).includes("中文 history"));
  assert.equal(await readFile(file, "utf8"), source);
  assert.equal((await readSubagentPreview(file, 0)).nextByte, first.nextByte);
});

test("append preserves sealed blocks and only transfers the changed tail", async (t) => {
  const source = Array.from({ length: 30 }, (_, i) =>
    line(`${i}:` + "x".repeat(10000)),
  ).join("");
  const file = await fixture(t, source);
  const first = await page(file);
  const second = await page(file, first.nextByte, [], first.snapshot);
  const known = [...first.blocks, ...second.blocks];
  await appendFile(file, line("new tail"));
  const appended = await page(file, 0, known);
  assert.equal(appended.blocks[0]?.kind, "reuse");
  assert.equal(appended.blocks.at(-1)?.kind, "data");
  assert.ok(JSON.stringify(appended).includes("new tail"));
  assert.ok(
    Buffer.byteLength(JSON.stringify(appended)) < Buffer.byteLength(source) / 3,
  );
});

test("same-size rewrites and truncation cannot reuse stale content", async (t) => {
  const file = await fixture(t, line("old"));
  const first = await page(file);
  await writeFile(file, line("new"));
  const replaced = await page(file, 0, first.blocks);
  assert.equal(replaced.blocks[0]?.kind, "data");
  assert.notEqual(replaced.blocks[0]?.hash, first.blocks[0]?.hash);
  await writeFile(file, "");
  const truncated = await page(file, 0, first.blocks);
  assert.deepEqual(truncated.blocks, []);
  assert.equal(truncated.nextByte, 0);
});

test("changed file expires pagination snapshot rather than mixing histories", async (t) => {
  const file = await fixture(t, line("old"));
  const first = await page(file);
  await appendFile(file, line("next"));
  await assert.rejects(page(file, first.nextByte, [], first.snapshot), {
    code: "SYNC_SNAPSHOT_EXPIRED",
  });
});

test("unfinished JSONL tails do not become cacheable blocks", async (t) => {
  const full = line("partial");
  const file = await fixture(t, full.slice(0, -1));
  const first = await page(file);
  assert.equal(first.nextByte, 0);
  assert.equal(first.hasMore, false);
  assert.deepEqual(first.blocks, []);
  await appendFile(file, "\n");
  assert.equal((await page(file)).nextByte, Buffer.byteLength(full));
});

test("retained native windows reuse unchanged blocks, reach appended tails and replace rewritten history", async (t) => {
  clearSubagentBlockMemory();
  t.after(clearSubagentBlockMemory);
  const entry = (index: number, fill = "x") => line(String(index).padStart(6, "0") + ":" + fill.repeat(1024));
  let source = Array.from({ length: 6000 }, (_, index) => entry(index)).join("");
  const file = await fixture(t, source);
  const cursors: number[] = [];
  const replies: SubagentSyncPage[] = [];
  let expired = 0;
  const fetch: FetchSubagentPage = async (cursor, signal, sync) => {
    signal.throwIfAborted();
    assert.ok(sync);
    cursors.push(cursor);
    try {
      const result = await page(file, cursor, sync.knownBlocks, sync.snapshot);
      replies.push(result);
      return result;
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "SYNC_SNAPSHOT_EXPIRED") expired++;
      throw error;
    }
  };
  const read = async () => {
    const result = await readSyncedSubagentHistory("retained-native", undefined, fetch, new AbortController().signal);
    assert.ok(isJsonObject(result) && Array.isArray(result.messages));
    const messages = result.messages;
    assert.ok(messages.every(isJsonObject));
    return { ...result, messages };
  };
  assert.equal((await read()).hasMore, true);
  const complete = await read();
  assert.equal(complete.hasMore, false);
  const saved = await loadSubagentBlocks("retained-native");
  assert.ok(saved && saved.blocks[0].fromByte > 0);

  replies.length = cursors.length = 0;
  assert.deepEqual((await read()).messages, complete.messages);
  assert.ok(replies.every(reply => reply.blocks.every(block => block.kind === "reuse")));

  source += entry(6000);
  await appendFile(file, entry(6000));
  replies.length = cursors.length = 0;
  const appended = await read();
  assert.equal(appended.messages.at(-1)?.content, "006000:" + "x".repeat(1024));
  assert.equal(appended.hasMore, false);
  assert.ok(cursors.every(cursor => cursor >= saved.blocks[0].fromByte));
  assert.ok(replies.reduce((bytes, reply) => bytes + Buffer.byteLength(JSON.stringify(reply)), 0) < 256 * 1024);
  assert.equal(replies.flatMap(reply => reply.blocks).filter(block => block.kind === "data").length, 1);

  // 持久窗口尚有下一页时仍须检验旧快照；失效后从窗口而非文件头重新验证。
  const resumed = await loadSubagentBlocks("retained-native");
  assert.ok(resumed);
  await saveSubagentBlocks({ ...resumed, hasMore: true });
  source += entry(6001);
  await appendFile(file, entry(6001));
  replies.length = cursors.length = 0;
  const continued = await read();
  assert.equal(expired, 1);
  assert.equal(cursors[0], resumed.nextByte);
  assert.equal(cursors[1], resumed.blocks[0].fromByte);
  assert.ok(cursors.every(cursor => cursor >= resumed.blocks[0].fromByte));
  assert.equal(continued.messages.at(-1)?.content, "006001:" + "x".repeat(1024));
  assert.equal(continued.hasMore, false);
  assert.equal(await readFile(file, "utf8"), source);

  const replacement = Array.from({ length: 6002 }, (_, index) => entry(index, "r")).join("");
  assert.equal(Buffer.byteLength(replacement), Buffer.byteLength(source));
  await writeFile(file, replacement);
  replies.length = 0;
  const rewritten = await read();
  assert.equal(rewritten.hasMore, false);
  assert.ok(rewritten.messages.every(message => typeof message.content === "string" && message.content.endsWith("r".repeat(1024))));
  assert.ok(replies.every(reply => reply.blocks.every(block => block.kind === "data")));
  assert.equal(await readFile(file, "utf8"), replacement);

  await writeFile(file, line("replacement after truncation"));
  const truncated = await read();
  assert.equal(truncated.reset, true);
  assert.equal(truncated.hasMore, false);
  assert.deepEqual(truncated.messages.map(message => message.content), ["replacement after truncation"]);
  assert.equal(await readFile(file, "utf8"), line("replacement after truncation"));
});
