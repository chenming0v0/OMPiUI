import assert from "node:assert/strict";
import test from "node:test";
import { RateBudget } from "./rate-budget.ts";
import { WebSocketIngressBudget } from "./ws-ingress-budget.ts";
import { WebSocketSendBudget } from "./ws-send-budget.ts";

test("zero-byte refunds do not wake blocked replay producers", () => {
  const budget = new WebSocketSendBudget<{ bufferedAmount: number }>(8, 8);
  const peer = { bufferedAmount: 0 };
  const waiting = { bufferedAmount: 0 };
  budget.register(peer, () => {});
  budget.register(waiting, () => {});
  assert.equal(budget.reserve(peer, 8), "accepted");
  budget.sending(peer, 8);
  let wakes = 0;
  budget.whenAvailable(() => { wakes++; });
  for (let index = 0; index < 10; index++) {
    assert.equal(budget.reserve(waiting, 1), "global_full");
    budget.release(waiting, 0);
    budget.discardQueued(waiting);
  }
  assert.equal(wakes, 0);
  budget.release(peer, 8, true);
  assert.equal(wakes, 1);
  assert.equal(budget.reserve(waiting, 1), "accepted");
});

test("raw WebSocket frame limits charge malformed and control frames before parsing", () => {
  const sharedFrames = new RateBudget(1000, 1);
  const sharedBytes = new RateBudget(16 * 1024 * 1024, 1);
  const ingress = new WebSocketIngressBudget(sharedFrames, sharedBytes);
  for (let index = 0; index < 240; index++) assert.equal(ingress.allow(1), true);
  assert.equal(ingress.allow(1), false);
  const other = new WebSocketIngressBudget(sharedFrames, sharedBytes);
  assert.equal(other.allow(1), true);
  assert.equal(other.allow(4 * 1024 * 1024 + 1), false);
});

test("WebSocket global reservations cannot exceed 64 MiB even when every peer stays below its own cap", () => {
  const budget = new WebSocketSendBudget<{ bufferedAmount: number }>();
  const peers = Array.from({ length: 8 }, () => ({ bufferedAmount: 0 }));
  for (const peer of peers) budget.register(peer, () => {});
  for (const peer of peers) {
    assert.equal(budget.reserve(peer, 8 * 1024 * 1024), "accepted");
  }
  const extra = { bufferedAmount: 0 };
  budget.register(extra, () => {});
  assert.equal(budget.total, 64 * 1024 * 1024);
  assert.equal(budget.reserve(extra, 1), "global_full");
  budget.release(peers[0]!, 1);
  assert.equal(budget.reserve(extra, 1), "accepted");
  budget.sending(extra, 1);
  assert.equal(budget.total, 64 * 1024 * 1024);
  budget.release(extra, 1, true);
  for (const peer of peers) budget.remove(peer);
  budget.remove(extra);
  assert.equal(budget.total, 0);
});
