import assert from "node:assert/strict";
import test from "node:test";
import { WebSocket } from "ws";
import { BodySink } from "./sink.ts";
import { decodeFrameMessage } from "./protocol.ts";

test("rate-limited batches pause the source and send the end marker only after the body", async () => {
  const frames: Buffer[] = [];
  const order: string[] = [];
  const socket = {
    readyState: WebSocket.OPEN,
    bufferedAmount: 0,
    send: (data: Buffer) => {
      frames.push(data);
      order.push("body");
    },
  };
  let available = false;
  let pauses = 0;
  let resumes = 0;
  const source = { pause: () => pauses++, resume: () => resumes++ };
  const sink = new BodySink(socket as unknown as WebSocket, () => available || 10);
  try {
    sink.write(1, Buffer.from("one"), source);
    sink.write(1, Buffer.from("two"), source);
    sink.finish(1, () => order.push("end"));
    assert.ok(pauses > 0);
    assert.deepEqual(order, []);
    available = true;
    await new Promise((resolve) => setTimeout(resolve, 35));
    assert.deepEqual(order, ["body", "end"]);
    assert.equal(decodeFrameMessage(frames[0]!)?.payload.toString(), "onetwo");
    assert.ok(resumes > 0);
  } finally {
    sink.dispose();
  }
});

test("quota rejection happens before materializing frames and wakes at the returned delay", async () => {
  const frames: Buffer[] = [];
  const socket = { readyState: WebSocket.OPEN, bufferedAmount: 0, send: (data: Buffer) => frames.push(data) };
  let calls = 0;
  const sink = new BodySink(socket as unknown as WebSocket, (bytes, count) => {
    calls++;
    assert.equal(bytes, 32768 + 18);
    assert.equal(count, 1);
    return calls === 1 ? 60 : true;
  });
  const chunk = Buffer.alloc(32768);
  let copies = 0;
  const original = Buffer.concat;
  Buffer.concat = (...args: Parameters<typeof Buffer.concat>) => { copies++; return original(...args) };
  try {
    sink.write(1, chunk, { pause() {}, resume() {} });
    assert.equal(copies, 0);
    assert.equal(frames.length, 0);
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.equal(calls, 1);
    await new Promise(resolve => setTimeout(resolve, 60));
    assert.equal(frames.length, 1);
    assert.equal(decodeFrameMessage(frames[0]!)?.payload.length, chunk.length);
  } finally {
    Buffer.concat = original;
    sink.dispose();
  }
});
