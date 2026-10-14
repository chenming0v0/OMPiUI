import assert from "node:assert/strict";
import test from "node:test";
import type { ChildProcess } from "node:child_process";
import { RequestSender, type RequestSendResult } from "./request-sender.ts";

test("queued cancellation settles immediately, releases capacity and never reaches the worker", () => {
  const sent: unknown[] = [];
  const callbacks: Array<(error: Error | null) => void> = [];
  const child = { send(message: unknown, callback: (error: Error | null) => void) { sent.push(message); callbacks.push(callback); return false; } };
  const sender = new RequestSender(child as ChildProcess, 100);
  const outcomes: Array<{ message: string } & RequestSendResult> = [];
  const item = (message: string, bytes: number) => ({
    message, bytes, active: () => true,
    done: (result: RequestSendResult) => outcomes.push({ message, ...result }),
  });
  const first = sender.send(item("first", 60));
  const cancelled = sender.send(item("cancelled", 40));
  assert.equal(first.attempted, true);
  assert.equal(first.cancel(), false);
  assert.equal(cancelled.cancel(), true);
  assert.equal(cancelled.cancel(), false);
  assert.deepEqual([...outcomes], [{ message: "cancelled", state: "unsent", error: null }]);
  sender.send(item("second", 40));
  sender.send(item("overflow", 1));
  assert.equal(outcomes[1].state, "unsent");
  assert.equal((outcomes[1].error as Error & { code: string }).code, "RATE_LIMITED");
  assert.deepEqual(sent, ["first"]);
  const firstDone = callbacks.shift()!;
  firstDone(null);
  firstDone(null);
  assert.deepEqual(sent, ["first", "second"]);
  sender.send(item("still-full", 61));
  assert.equal(outcomes.at(-1)?.state, "unsent");
  assert.equal((outcomes.at(-1)?.error as Error & { code: string }).code, "RATE_LIMITED");
  callbacks.shift()!(null);
  sender.send(item("after", 100));
  assert.deepEqual(sent, ["first", "second", "after"]);
  callbacks.shift()!(null);
  assert.equal(outcomes.filter(result => result.message === "first").length, 1);
  assert.equal(outcomes.filter(result => result.message === "cancelled").length, 1);
});

test("inactive and disconnected queued requests have an explicit unsent terminal result", () => {
  const sent: unknown[] = [];
  let callback!: (error: Error | null) => void;
  const child = { connected: true, send(message: unknown, done: typeof callback) { sent.push(message); callback = done; return false; } };
  const sender = new RequestSender(child as ChildProcess);
  const outcomes: RequestSendResult[] = [];
  let active = true;
  sender.send({ message: "block", bytes: 1, active: () => true, done: () => undefined });
  sender.send({ message: "inactive", bytes: 1, active: () => active, done: result => outcomes.push(result) });
  sender.send({ message: "disconnected", bytes: 1, active: () => true, done: result => outcomes.push(result) });
  active = false;
  child.connected = false;
  callback(null);
  assert.deepEqual(sent, ["block"]);
  assert.deepEqual(outcomes.map(result => result.state), ["unsent", "unsent"]);
  assert.equal(outcomes[0].error, null);
  assert.equal((outcomes[1].error as Error & { code: string }).code, "ERR_IPC_CHANNEL_CLOSED");
});

test("a send error is not proof of non-delivery and a late callback cannot over-credit capacity", () => {
  const callbacks: Array<(error: Error | null) => void> = [];
  const sent: unknown[] = [];
  const sender = new RequestSender({ send(message: unknown, done: (error: Error | null) => void) { sent.push(message); callbacks.push(done); return false; } } as ChildProcess, 10);
  const outcomes: RequestSendResult[] = [];
  const first = sender.send({ message: "first", bytes: 10, active: () => true, done: result => outcomes.push(result) });
  assert.equal(first.cancel(), false);
  const firstDone = callbacks.shift()!;
  const error = new Error("callback failed after handoff");
  firstDone(error);
  firstDone(null);
  assert.deepEqual(outcomes, [{ state: "attempted", error }]);
  sender.send({ message: "next", bytes: 10, active: () => true, done: result => outcomes.push(result) });
  sender.send({ message: "overflow", bytes: 1, active: () => true, done: result => outcomes.push(result) });
  assert.deepEqual(sent, ["first", "next"]);
  assert.equal(outcomes[1].state, "unsent");
  callbacks.shift()!(null);
});

test("worker exit settles active and queued sends once and forbids late delivery", () => {
  const sent: unknown[] = [];
  let callback!: (error: Error | null) => void;
  const sender = new RequestSender({ send(message: unknown, done: typeof callback) { sent.push(message); callback = done; return false; } } as ChildProcess, 10);
  const outcomes: RequestSendResult[] = [];
  sender.send({ message: "active", bytes: 5, active: () => true, done: result => outcomes.push(result) });
  sender.send({ message: "queued", bytes: 5, active: () => true, done: result => outcomes.push(result) });
  const error = new Error("worker exited");
  sender.close(error);
  sender.close(error);
  callback(null);
  assert.deepEqual(outcomes, [{ state: "attempted", error }, { state: "unsent", error }]);
  sender.send({ message: "after", bytes: 1, active: () => true, done: result => outcomes.push(result) });
  assert.deepEqual(outcomes.at(-1), { state: "unsent", error });
  assert.deepEqual(sent, ["active"]);
});
