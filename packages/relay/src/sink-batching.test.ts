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
  const sink = new BodySink(socket as unknown as WebSocket, () => available);
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
