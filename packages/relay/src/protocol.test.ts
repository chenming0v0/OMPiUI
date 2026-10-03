import assert from "node:assert/strict"
import { describe, it } from "node:test"
import {
  CONTROL_PATH,
  FRAME_PAYLOAD_MAX,
  decodeFrameMessage,
  encodeFrameMessages,
  relayProblemBody,
  serializeRawHead,
  stripHopByHopHeaders,
} from "./protocol.ts"

describe("frame codec", () => {
  it("round-trips small payloads", () => {
    const [message] = encodeFrameMessages(7, Buffer.from("hello"))
    assert.ok(message)
    const decoded = decodeFrameMessage(message)
    assert.deepEqual(decoded, { connId: 7, payload: Buffer.from("hello") })
  })

  it("splits payloads above 64KiB into ordered frames", () => {
    const big = Buffer.alloc(FRAME_PAYLOAD_MAX * 2 + 10, 0xab)
    const messages = encodeFrameMessages(42, big)
    assert.equal(messages.length, 3)
    const joined = Buffer.concat(
      messages.map(message => {
        const decoded = decodeFrameMessage(message)
        assert.equal(decoded?.connId, 42)
        return decoded!.payload
      }),
    )
    assert.ok(joined.equals(big))
  })

  it("rejects malformed frames", () => {
    assert.equal(decodeFrameMessage(Buffer.alloc(3)), null)
    assert.equal(decodeFrameMessage(Buffer.alloc(FRAME_PAYLOAD_MAX + 5)), null)
  })
})

describe("stripHopByHopHeaders", () => {
  it("strips hop-by-hop headers and lowercases names", () => {
    const stripped = stripHopByHopHeaders({
      Host: "relay.example.com",
      "Content-Length": "5",
      Connection: "keep-alive",
      "Transfer-Encoding": "chunked",
      "Keep-Alive": "timeout=5",
    })
    assert.deepEqual(stripped, { host: "relay.example.com", "content-length": "5" })
  })

  it("keeps upgrade headers only when asked (101 pass-through)", () => {
    const stripped = stripHopByHopHeaders(
      { host: "x", connection: "Upgrade", upgrade: "websocket", "sec-websocket-key": "abc" },
      true,
    )
    assert.equal(stripped.upgrade, "websocket")
    assert.equal(stripped.connection, "Upgrade")
    assert.equal(stripHopByHopHeaders({ upgrade: "websocket", connection: "Upgrade" }).upgrade, undefined)
  })
})

describe("misc protocol helpers", () => {
  it("serializes raw heads for upgrade responses", () => {
    const head = serializeRawHead(101, { upgrade: "websocket", connection: "Upgrade" })
    assert.equal(
      head.toString(),
      "HTTP/1.1 101\r\nupgrade: websocket\r\nconnection: Upgrade\r\n\r\n",
    )
  })

  it("renders problem bodies and keeps the control path stable", () => {
    assert.equal(relayProblemBody("TUNNEL_OFFLINE", "x"), '{"code":"TUNNEL_OFFLINE","message":"x"}')
    assert.equal(CONTROL_PATH, "/_tunnel")
  })
})
