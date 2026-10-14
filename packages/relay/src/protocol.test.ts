import assert from "node:assert/strict"
import { describe, it } from "node:test"
import {
  CONTROL_PATH,
  FRAME_PAYLOAD_MAX,
  allocateConnectionId,
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

  it("keeps control/data IDs aligned across u32 rollover, active IDs and reuse", () => {
    const firstTunnel = new Map<number, Buffer[]>()
    const secondTunnel = new Map<number, Buffer[]>([[1, []]])
    const isActive = (id: number) => firstTunnel.has(id) || secondTunnel.has(id)
    const last = allocateConnectionId(0xffffffff, isActive)
    firstTunnel.set(last, [])
    const wrapped = allocateConnectionId((last + 1) >>> 0, isActive)
    firstTunnel.set(wrapped, [])
    const skipped = allocateConnectionId(last, isActive)
    firstTunnel.set(skipped, [])
    assert.deepEqual([last, wrapped, skipped], [0xffffffff, 0, 2])

    for (const c of [last, wrapped, skipped]) {
      // The receiver registers the JSON ID, then looks up every binary frame.
      const open = JSON.parse(JSON.stringify({ type: "open", c })) as { c: number }
      for (const fill of [0x55, 0x44]) {
        const peer = new Map<number, Buffer[]>([[open.c, []]])
        const payload = Buffer.alloc(FRAME_PAYLOAD_MAX + 1, fill)
        for (const message of encodeFrameMessages(c, payload)) {
          const decoded = decodeFrameMessage(message)!
          const received = peer.get(decoded.connId)
          assert.ok(received, "the body must address the registered control ID")
          received.push(decoded.payload)
        }
        assert.deepEqual(Buffer.concat(peer.get(c)!), payload)
      }
    }

    firstTunnel.delete(wrapped)
    assert.equal(allocateConnectionId(0, isActive), wrapped)
    assert.equal(firstTunnel.has(last), true)
    assert.equal(secondTunnel.has(1), true)
    assert.throws(() => encodeFrameMessages(0x100000000, Buffer.from("x")), RangeError)
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
