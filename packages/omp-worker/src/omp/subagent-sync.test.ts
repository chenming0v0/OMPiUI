import assert from "node:assert/strict";
import test from "node:test";
import { appendFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { SubagentBlockRef, SubagentSyncPage } from "@ompiui/protocol";
import { readSubagentSync } from "./subagent-sync.js";
import { readSubagentPreview } from "./subagent-preview.js";

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
  t.after(() => rm(root, { recursive: true, force: true }));
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
