import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { readSessionToolOutput } from "./tool-output.js";

test("reads full-output artifact pages without splitting UTF-8 characters", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ompiui-tool-output-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const sessionFile = path.join(root, "session.jsonl");
  const artifactDir = path.join(root, "session", "local");
  await writeFile(sessionFile, "{}\n");
  await mkdir(artifactDir, { recursive: true });
  const original = `${"a".repeat(128 * 1024 - 1)}😀end`;
  await writeFile(path.join(artifactDir, "3.log"), original, "utf8");

  const first = await readSessionToolOutput(sessionFile, "session-1", "3", 0);
  assert.equal(first.data, "a".repeat(128 * 1024 - 1));
  assert.equal(first.nextOffset, Buffer.byteLength(first.data));
  assert.equal(first.hasMore, true);

  const second = await readSessionToolOutput(sessionFile, "session-1", "3", first.nextOffset, first.revision);
  assert.equal(first.data + second.data, original);
  assert.equal(second.hasMore, false);
  await assert.rejects(readSessionToolOutput(sessionFile, "session-1", "../outside", 0), /Invalid tool output artifact id/);
});
