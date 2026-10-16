import assert from "node:assert/strict";
import test from "node:test";
import { WebSocket } from "ws";
import { BodySink } from "./sink.ts";
import { decodeFrameMessage } from "./protocol.ts";

test("concurrent sinks share admission before sending and drain large chunks in order", async () => {
  const frames: Buffer[] = [];
  const socket = {
    readyState: WebSocket.OPEN, bufferedAmount: 1024 * 1024 - 32786,
    send(data: Buffer) { frames.push(data); this.bufferedAmount += data.length + 14; },
  };
  const sinks = Array.from({ length: 4 }, () => new BodySink(socket as unknown as WebSocket));
  const source = { pause() {}, resume() {} };
  try {
    sinks.forEach((sink, index) => sink.write(index + 1, Buffer.alloc(32768, index), source));
    assert.equal(frames.length, 1);
    assert.ok(socket.bufferedAmount <= 1024 * 1024);
    socket.bufferedAmount = 0;
    await new Promise(resolve => setTimeout(resolve, 50));
    assert.equal(frames.length, 4);
    assert.deepEqual(frames.map(frame => decodeFrameMessage(frame)!.connId).sort(), [1, 2, 3, 4]);
    socket.bufferedAmount = 0;
    const data = Buffer.alloc(2 * 1024 * 1024, 7);
    sinks[0]!.write(5, data, source);
    let ended = false;
    sinks[0]!.finish(5, () => { ended = true; });
    for (let i = 0; i < 5 && !ended; i++) {
      assert.ok(socket.bufferedAmount <= 1024 * 1024);
      socket.bufferedAmount = 0;
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    assert.equal(ended, true);
    assert.deepEqual(Buffer.concat(frames.map(frame => decodeFrameMessage(frame)!).filter(frame => frame.connId === 5).map(frame => frame.payload)), data);
  } finally { sinks.forEach(sink => sink.dispose()); }
});

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
