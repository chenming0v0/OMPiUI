import assert from "node:assert/strict"
import test from "node:test"
import { WebSocket } from "ws"
import { TunnelClient } from "./tunnel-client.ts"

test("desktop accepts the relay's ordinary and cleanup control budgets independently", t => {
  t.mock.timers.enable({ apis: ["Date"], now: 0 })
  const client = new TunnelClient({ relayUrl: "ws://127.0.0.1", key: "test", localPort: 1 })
  let terminated = 0
  let opens = 0
  const internal = client as unknown as {
    ws: { readyState: number; terminate(): void }
    forwardRequest(frame: unknown): void
    handleMessage(data: Buffer, binary: boolean): void
  }
  internal.ws = { readyState: WebSocket.OPEN, terminate() { terminated++ } }
  internal.forwardRequest = () => { opens++ }
  const open = (c: number, bytes: number) => {
    const frame = { type: "open", c, m: "POST", p: "/", h: { "x-pad": "" } }
    frame.h["x-pad"] = "x".repeat(bytes - 14 - Buffer.byteLength(JSON.stringify(frame)))
    const data = Buffer.from(JSON.stringify(frame))
    assert.equal(data.length + 14, bytes)
    internal.handleMessage(data, false)
  }
  for (let c = 1; c <= 174; c++) {
    open(c, 12_000)
    internal.handleMessage(Buffer.from(JSON.stringify({ type: "abort", c })), false)
  }
  open(175, 8_000)
  assert.equal(terminated, 0)
  assert.equal(opens, 175)
  for (let index = 0; index < 3; index++)
    internal.handleMessage(Buffer.from(JSON.stringify({ type: "abort", c: 1, pad: "x".repeat(60_000) })), false)
  assert.ok(terminated > 0, "cleanup traffic retains its own hard budget")
})
