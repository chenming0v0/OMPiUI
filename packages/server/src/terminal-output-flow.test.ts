import assert from "node:assert/strict"
import test from "node:test"
import { TerminalOutputFlow, TERMINAL_OUTPUT_ACK_WINDOW, TERMINAL_OUTPUT_BURST, TERMINAL_OUTPUT_PER_SECOND } from "./terminal-output-flow.ts"

test("terminal downlink bounds actual wire bytes per second without consuming refused work", t => {
  let now = 0
  t.mock.method(Date, "now", () => now)
  const flow = new TerminalOutputFlow(false)
  assert.equal(flow.retryAfterMs(TERMINAL_OUTPUT_BURST), 0)
  flow.sent(1, TERMINAL_OUTPUT_BURST)
  assert.equal(flow.retryAfterMs(TERMINAL_OUTPUT_PER_SECOND), 1000)
  assert.equal(flow.retryAfterMs(TERMINAL_OUTPUT_PER_SECOND), 1000)
  now = 1000
  assert.equal(flow.retryAfterMs(TERMINAL_OUTPUT_PER_SECOND), 0)
  flow.sent(2, TERMINAL_OUTPUT_PER_SECOND)
  assert.equal(flow.retryAfterMs(32768), 16)
  assert.equal(flow.hasPendingAcknowledgements, false)
})

test("only consumed output boundaries refund the bounded acknowledgement window", () => {
  const flow = new TerminalOutputFlow(true)
  for (let index = 1; index <= 8; index++) {
    assert.equal(flow.retryAfterMs(TERMINAL_OUTPUT_ACK_WINDOW / 8), 0)
    flow.sent(index * 100, TERMINAL_OUTPUT_ACK_WINDOW / 8)
  }
  assert.equal(flow.retryAfterMs(1), Infinity)
  assert.equal(flow.acknowledge(801), false)
  assert.equal(flow.acknowledge(399), false)
  assert.equal(flow.acknowledge(400), true)
  assert.equal(flow.acknowledge(400), true)
  assert.equal(flow.retryAfterMs(TERMINAL_OUTPUT_ACK_WINDOW / 2), 0)
  assert.equal(flow.acknowledge(800), true)
  assert.equal(flow.hasPendingAcknowledgements, false)
})
