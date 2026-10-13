import assert from "node:assert/strict";
import test from "node:test";
import { QueryPool, mapConcurrent } from "./query-pool.ts";

test("query slots are bounded and cancelled waiters do not consume a slot", async () => {
  const pool = new QueryPool(1, 2);
  let release!: () => void;
  const first = pool.run(undefined, () => new Promise<void>(resolve => { release = resolve; }));
  const cancelled = new AbortController();
  let started = false;
  const second = pool.run(cancelled.signal, async () => { started = true; });
  const third = pool.run(undefined, async () => "third");
  await assert.rejects(pool.run(undefined, async () => "overflow"), { code: "RATE_LIMITED" });
  cancelled.abort();
  await assert.rejects(second, { code: "REQUEST_ABORTED" });
  release();
  await first;
  assert.equal(await third, "third");
  assert.equal(started, false);
  assert.equal(await pool.run(undefined, async () => "reusable"), "reusable");
});

test("concurrent mapping bounds IO while retaining input ordering", async () => {
  let active = 0;
  let peak = 0;
  const result = await mapConcurrent([1, 2, 3, 4, 5], 2, async item => {
    active++;
    peak = Math.max(peak, active);
    await new Promise(resolve => setTimeout(resolve, 2));
    active--;
    return item * 2;
  });
  assert.equal(peak, 2);
  assert.deepEqual(result, [2, 4, 6, 8, 10]);
});
