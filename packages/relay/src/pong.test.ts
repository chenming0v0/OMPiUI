import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter } from "node:events";
import { WebSocket } from "ws";
import { createPongSender } from "./pong.ts";

test("congested pong sender retains at most one in-flight and the latest pending ping", () => {
  const socket = Object.assign(new EventEmitter(), {
    readyState: WebSocket.OPEN, bufferedAmount: 1024 * 1024 + 65554,
    pong(data: Buffer, _mask: unknown, done: () => void) {
      sent.push(data.toString()); callbacks.push(done);
    },
  });
  const sent: string[] = [];
  const callbacks: Array<() => void> = [];
  const send = createPongSender(socket as unknown as WebSocket);
  send(Buffer.from("first"));
  send(Buffer.from("second"));
  send(Buffer.from("latest"));
  assert.deepEqual(sent, ["first"]);
  callbacks.shift()!();
  assert.deepEqual(sent, ["first", "latest"]);
  send(Buffer.from("closed"));
  socket.emit("close");
  callbacks.shift()!();
  assert.equal(sent.length, 2);
});
