import assert from "node:assert/strict";
import test from "node:test";
import { RateBudget } from "./rate-budget.ts";

test("rate budgets cap bursts, refill with time and do not consume refused work", t => {
  let now = 1000;
  t.mock.method(Date, "now", () => now);
  const budget = new RateBudget(12, 4);
  assert.equal(budget.allow(13), false);
  assert.equal(budget.allow(12), true);
  assert.equal(budget.allow(1), false);
  now += 250;
  assert.equal(budget.allow(1), true);
  assert.equal(budget.allow(1), false);
  now += 60_000;
  assert.equal(budget.allow(13), false);
  assert.equal(budget.allow(12), true);
});
