import assert from "node:assert/strict";
import test from "node:test";
import type { ChildProcess } from "node:child_process";
import { RequestSender } from "./request-sender.ts";

test("IPC requests wait for flush, reject excess bytes and skip cancelled queued requests", () => {
  const sent: unknown[] = [];
  const callbacks: Array<(error: Error | null) => void> = [];
  const child = { send(message: unknown, callback: (error: Error | null) => void) { sent.push(message); callbacks.push(callback); return false } };
  const sender = new RequestSender(child as ChildProcess, 100);
  const errors: Error[] = [];
  const item = (message: string, bytes: number, active = true) => ({
    message, bytes, active: () => active, done: (error: Error | null) => { if (error) errors.push(error) },
  });
  sender.send(item("first", 60));
  sender.send(item("cancelled", 20, false));
  sender.send(item("second", 20));
  sender.send(item("overflow", 1));
  assert.equal((errors[0] as Error & { code: string }).code, "RATE_LIMITED");
  assert.deepEqual(sent, ["first"]);
  callbacks.shift()!(null);
  assert.deepEqual(sent, ["first", "second"]);
  callbacks.shift()!(null);
  sender.send(item("after", 100));
  assert.deepEqual(sent, ["first", "second", "after"]);
  callbacks.shift()!(null);
});
