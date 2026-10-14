import assert from "node:assert/strict";
import test from "node:test";
import { once } from "node:events";
import { Writable } from "node:stream";
import type { ServerResponse } from "node:http";
import { MAX_PENDING_BYTES, reserveHttpOutput, writeHttpOutput } from "./http-output.ts";

// 每次预留按 `bytes * 2` 计入全局预算，取 MAX/4 的正文正好各占一半额度。
const HALF_CEILING_BYTES = MAX_PENDING_BYTES / 4;

test("HTTP output has a global byte ceiling and releases reservations on finish and close", () => {
  const outputs = Array.from({ length: 3 }, () => new Writable({ write(_data, _encoding, done) { done() } }));
  const response = (index: number) => outputs[index]! as unknown as ServerResponse;
  try {
    assert.ok(reserveHttpOutput(response(0), HALF_CEILING_BYTES));
    assert.ok(reserveHttpOutput(response(1), HALF_CEILING_BYTES));
    assert.equal(reserveHttpOutput(response(2), 1), undefined);
    outputs[0]!.emit("finish");
    assert.ok(reserveHttpOutput(response(2), 1));
    outputs[1]!.emit("close");
  } finally {
    for (const output of outputs) output.emit("close");
  }
});

test("a closed response retains its budget until compression finishes", () => {
  const outputs = Array.from({ length: 3 }, () => new Writable({ write(_data, _encoding, done) { done() } }));
  const response = (index: number) => outputs[index]! as unknown as ServerResponse;
  try {
    const first = reserveHttpOutput(response(0), HALF_CEILING_BYTES)!;
    const done = first.hold();
    outputs[0]!.emit("close");
    assert.ok(reserveHttpOutput(response(1), HALF_CEILING_BYTES));
    assert.equal(reserveHttpOutput(response(2), 1), undefined);
    done();
    assert.ok(reserveHttpOutput(response(2), 1));
  } finally {
    for (const output of outputs) output.emit("close");
  }
});

test("HTTP output waits for drain and never queues a complete large body", async () => {
  const chunks: Buffer[] = [];
  let release: (() => void) | undefined;
  const output = new Writable({
    highWaterMark: 1,
    write(data, _encoding, done) { chunks.push(Buffer.from(data)); release = done },
  });
  const payload = Buffer.alloc(256 * 1024, 7);
  const finished = once(output, "finish");
  writeHttpOutput(output as unknown as ServerResponse, payload);
  assert.equal(chunks.length, 1);
  assert.equal(output.writableLength, 64 * 1024);
  while (!output.writableFinished) {
    const callback = release;
    release = undefined;
    callback?.();
    await new Promise(resolve => setImmediate(resolve));
  }
  await finished;
  assert.deepEqual(Buffer.concat(chunks), payload);
});
