import assert from "node:assert/strict"
import { createServer, request as httpRequest, type IncomingHttpHeaders, type Server } from "node:http"
import { randomBytes } from "node:crypto"
import { after, describe, it } from "node:test"
import { WebSocket, WebSocketServer } from "ws"
import type { TunnelStatus } from "@ompiui/protocol"
import { CLOSE_UNAUTHORIZED, startRelay, WIRE_VERSION, type RunningRelay } from "@ompiui/relay"
import { TunnelClient } from "./tunnel-client.ts"
import { createAppServer } from "../http.ts"
import { MAX_PAIRING_FAILURES, PairingStore } from "../host/pairing.ts"
import { TUNNEL_FORWARDING_HEADER } from "../host/security.ts"

// 测试专用密钥（relay 侧只要求 ≥16 个 base64url 字符）
const KEY = "ompiui-test-key-0123456789abcdef"
const noop = () => {}

async function listen(server: Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", () => {
      const address = server.address()
      resolve(typeof address === "object" && address ? address.port : 0)
    })
  })
}

function closeQuietly(target: Server | RunningRelay): Promise<void> {
  if ("server" in target) return target.close().catch(noop)
  target.closeAllConnections()
  return new Promise(resolve => target.close(() => resolve()))
}

function request(url: string, headers: Record<string, string> = {}): Promise<{ status: number; body: Buffer }> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url)
    const req = httpRequest({ host: parsed.hostname, port: parsed.port, path: parsed.pathname, headers }, res => {
      const chunks: Buffer[] = []
      res.on("data", chunk => chunks.push(chunk as Buffer))
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks) }))
    })
    req.on("error", reject)
    req.end()
  })
}

async function waitForStatus(client: TunnelClient, state: TunnelStatus["state"], attempts?: number): Promise<TunnelStatus> {
  const deadline = Date.now() + 5_000
  while (Date.now() < deadline) {
    const status = client.getStatus()
    if (status.state === state && (attempts === undefined || status.reconnectAttempts === attempts)) return status
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  throw new Error(`expected ${state}: ${JSON.stringify(client.getStatus())}`)
}

describe("TunnelClient against a live relay", () => {
  const cleanups: Array<() => Promise<void>> = []
  after(async () => {
    for (const cleanup of cleanups.reverse()) await cleanup().catch(noop)
  })

  it("dials the relay, serves HTTP and WS through the tunnel, and stops cleanly", async () => {
    const tunnelForwardingToken = randomBytes(32).toString("hex")
    let httpHeaders: IncomingHttpHeaders | undefined
    let upgradeHeaders: IncomingHttpHeaders | undefined
    // 本机"OMPiUI server"替身：一个 hello 端点 + 一个 WS echo 端点
    const upstream = createServer((req, res) => {
      if (req.url === "/api/v1/host/health") {
        httpHeaders = req.headers
        res.writeHead(200, { "content-type": "application/json" })
        res.end(JSON.stringify({ ok: true, service: "ompiui-server" }))
        return
      }
      res.writeHead(404)
      res.end()
    })
    const upstreamWss = new WebSocketServer({ noServer: true })
    upstream.on("upgrade", (req, socket, head) => {
      upgradeHeaders = req.headers
      upstreamWss.handleUpgrade(req, socket, head, ws => {
        ws.on("message", data => ws.send(`echo:${data.toString()}`))
        ws.on("error", noop)
      })
    })
    const upstreamPort = await listen(upstream)
    cleanups.push(() => closeQuietly(upstream))

    const relay = await startRelay({ config: { port: 0, tunnels: [{ id: "ompiui", key: KEY }] }, log: noop })
    cleanups.push(() => closeQuietly(relay))

    const statuses: TunnelStatus[] = []
    const client = new TunnelClient({
      relayUrl: `ws://127.0.0.1:${relay.port}`,
      key: KEY,
      localPort: upstreamPort,
      tunnelForwardingToken,
      onStatus: status => statuses.push(status),
    })
    client.start()
    cleanups.push(async () => client.stop())

    const connected = await new Promise<TunnelStatus>((resolve, reject) => {
      const deadline = Date.now() + 5_000
      const poll = () => {
        const latest = client.getStatus()
        if (latest.state === "connected") return resolve(latest)
        if (Date.now() > deadline) return reject(new Error(`tunnel never connected: ${latest.state} ${latest.lastError ?? ""}`))
        setTimeout(poll, 50)
      }
      poll()
    })
    assert.equal(connected.tunnelId, "ompiui")
    // 单隧道且中转未配置 publicUrl 时，入口从控制连接的 Host 推导
    assert.equal(connected.publicUrl, `http://127.0.0.1:${relay.port}`)

    const spoofedHeaders = { "X-OMPIUI-Internal-Tunnel": "untrusted-marker", "x-forwarded-for": "203.0.113.5" }
    const health = await request(`http://127.0.0.1:${relay.port}/api/v1/host/health`, spoofedHeaders)
    assert.equal(health.status, 200)
    assert.equal((JSON.parse(health.body.toString()) as { service: string }).service, "ompiui-server")

    assert.equal(httpHeaders?.[TUNNEL_FORWARDING_HEADER], tunnelForwardingToken)
    assert.equal(httpHeaders?.["x-forwarded-for"], "127.0.0.1")
    const ws = new WebSocket(`ws://127.0.0.1:${relay.port}/api/v1/events`, { headers: spoofedHeaders })
    const reply = await new Promise<string>((resolve, reject) => {
      ws.on("open", () => ws.send("ping"))
      ws.on("message", data => resolve(data.toString()))
      ws.on("error", reject)
    })
    assert.equal(reply, "echo:ping")
    assert.equal(upgradeHeaders?.[TUNNEL_FORWARDING_HEADER], tunnelForwardingToken)
    assert.equal(upgradeHeaders?.["x-forwarded-for"], "127.0.0.1")
    ws.close()

    client.stop()
    await new Promise(resolve => setTimeout(resolve, 100))
    assert.deepEqual(relay.onlineTunnelIds(), [])
    const stoppedStatuses = statuses.filter(status => status.state === "disabled")
    assert.ok(stoppedStatuses.length > 0)
  })

  it("reconnects with backoff after the relay restarts", async () => {
    const upstream = createServer((req, res) => {
      res.writeHead(200, { "content-type": "text/plain" })
      res.end("ok")
    })
    const upstreamPort = await listen(upstream)
    cleanups.push(() => closeQuietly(upstream))

    const relay = await startRelay({ config: { port: 0, tunnels: [{ id: "ompiui", key: KEY }] }, log: noop })
    cleanups.push(() => closeQuietly(relay))
    const client = new TunnelClient({ relayUrl: `ws://127.0.0.1:${relay.port}`, key: KEY, localPort: upstreamPort })
    client.start()
    cleanups.push(async () => client.stop())
    await new Promise<void>((resolve, reject) => {
      const deadline = Date.now() + 5_000
      const poll = () => {
        if (client.getStatus().state === "connected") return resolve()
        if (Date.now() > deadline) return reject(new Error("never connected"))
        setTimeout(poll, 50)
      }
      poll()
    })

    // 重启中转：旧控制连接死亡 → 客户端退避重连 → 重新 connected
    await relay.close()
    const revived = await startRelay({ config: { port: relay.port, tunnels: [{ id: "ompiui", key: KEY }] }, log: noop })
    cleanups.push(() => closeQuietly(revived))
    await new Promise<void>((resolve, reject) => {
      const deadline = Date.now() + 20_000
      const poll = () => {
        const status = client.getStatus()
        if (status.state === "connected") return resolve()
        if (Date.now() > deadline) return reject(new Error(`never reconnected: ${status.lastError ?? ""}`))
        setTimeout(poll, 100)
      }
      poll()
    })
    assert.ok(client.getStatus().reconnectAttempts >= 0)
  })

  it("rate-limits two relay socket identities independently and ignores public spoofed headers", async () => {
    const pairing = new PairingStore()
    const tunnelForwardingToken = randomBytes(32).toString("hex")
    const app = createAppServer({ authToken: "test-api-token", pairing, tunnelForwardingToken })
    const upstreamPort = await listen(app.server)
    cleanups.push(() => app.dispose())
    const relay = await startRelay({ config: { port: 0, tunnels: [{ id: "ompiui", key: KEY }] }, log: noop })
    cleanups.push(() => closeQuietly(relay))
    const client = new TunnelClient({
      relayUrl: `ws://127.0.0.1:${relay.port}`, key: KEY, localPort: upstreamPort, tunnelForwardingToken,
    }).start()
    cleanups.push(async () => client.stop())
    await waitForStatus(client, "connected")

    // Distinct actual source addresses; all forwarded requests reach the app
    // over the same 127.0.0.1 tunnel hop. No mocked forwarding identity here.
    const redeem = (localAddress: string, body: object, spoofedIp: string): Promise<number> =>
      new Promise((resolve, reject) => {
        const req = httpRequest({
          host: "127.0.0.1", port: relay.port, localAddress, agent: false,
          method: "POST", path: "/api/v1/host/pair/redeem",
          headers: {
            "content-type": "application/json",
            "x-forwarded-for": spoofedIp,
            "x-real-ip": spoofedIp,
            forwarded: `for=${spoofedIp}`,
            "X-OMPIUI-INTERNAL-TUNNEL": "attacker-marker",
          },
        }, res => {
          res.resume()
          res.on("end", () => resolve(res.statusCode ?? 0))
        })
        req.on("error", reject)
        req.end(JSON.stringify(body))
      })

    const invite = pairing.mint()
    for (let i = 0; i < MAX_PAIRING_FAILURES; i++) {
      assert.equal(await redeem("127.0.0.2", { code: "invalid" }, `198.51.100.${i + 1}`),
        i === MAX_PAIRING_FAILURES - 1 ? 429 : 400)
    }
    const validPair = { pair: `${invite.id}.${invite.secret}` }
    assert.equal(await redeem("127.0.0.2", validPair, "203.0.113.20"), 429)
    assert.equal(await redeem("127.0.0.3", validPair, "127.0.0.2"), 200)
    assert.equal(invite.redeemedBy, "relay:127.0.0.3")

    // The second client's failures get their own complete budget as well.
    for (let i = 0; i < MAX_PAIRING_FAILURES; i++) {
      assert.equal(await redeem("127.0.0.3", { code: "invalid" }, "127.0.0.2"),
        i === MAX_PAIRING_FAILURES - 1 ? 429 : 400)
    }
    assert.equal((await request(`http://127.0.0.1:${relay.port}/api/v1/host/pair/invite`)).status, 401)
    const direct = await fetch(`http://127.0.0.1:${upstreamPort}/api/v1/host/pair/redeem`, {
      method: "POST", body: JSON.stringify({ code: "invalid" }),
    })
    assert.equal(direct.status, 400, "relay failures must not consume the local client's budget")
    await direct.arrayBuffer()
  })

  for (const token of [undefined, "private-local-marker"]) {
    it(`strips every public marker spelling before forwarding (${token ? "authenticated" : "no marker configured"})`, { timeout: 10_000 }, async () => {
      let received!: (headers: IncomingHttpHeaders) => void
      const headersReceived = new Promise<IncomingHttpHeaders>(resolve => { received = resolve })
      const upstream = createServer((req, res) => {
        received(req.headers)
        res.end("ok")
      })
      const upstreamPort = await listen(upstream)
      cleanups.push(() => closeQuietly(upstream))
      const relay = createServer()
      const wss = new WebSocketServer({ server: relay })
      const relayPort = await listen(relay)
      cleanups.push(() => closeQuietly(relay))
      let controlHeaders: IncomingHttpHeaders | undefined
      wss.on("connection", (ws, req) => {
        controlHeaders = req.headers
        ws.send(JSON.stringify({ type: "ready", v: WIRE_VERSION, publicUrl: "http://relay.test" }))
        ws.send(JSON.stringify({
          type: "open", c: 1, m: "GET", u: "/", h: {
            [TUNNEL_FORWARDING_HEADER]: "untrusted-lowercase",
            "X-OMPIUI-Internal-Tunnel": "untrusted-mixed-case",
            "x-forwarded-for": "198.51.100.4",
          },
        }))
        ws.send(JSON.stringify({ type: "reqEnd", c: 1 }))
      })
      const client = new TunnelClient({
        relayUrl: `ws://127.0.0.1:${relayPort}`, key: KEY, localPort: upstreamPort, tunnelForwardingToken: token,
      }).start()
      cleanups.push(async () => { client.stop(); for (const ws of wss.clients) ws.terminate(); wss.close() })
      const headers = await headersReceived
      assert.equal(headers[TUNNEL_FORWARDING_HEADER], token)
      assert.equal(headers["x-forwarded-for"], "198.51.100.4")
      assert.equal(controlHeaders?.[TUNNEL_FORWARDING_HEADER], undefined, "internal token must never go to the relay")
    })
  }

  it("retains a handshake error across 1006 and reconnecting, then clears it on successful ready", async () => {
    const relay = createServer()
    const wss = new WebSocketServer({ noServer: true })
    const relayPort = await listen(relay)
    cleanups.push(() => closeQuietly(relay))
    let accept = false
    relay.on("upgrade", (req, socket, head) => {
      if (!accept) {
        socket.end("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\nContent-Length: 0\r\n\r\n")
        return
      }
      wss.handleUpgrade(req, socket, head, ws => {
        ws.send(JSON.stringify({ type: "ready", v: WIRE_VERSION, publicUrl: "http://relay.test" }))
      })
    })
    const statuses: TunnelStatus[] = []
    const client = new TunnelClient({
      relayUrl: `ws://127.0.0.1:${relayPort}`, key: KEY, localPort: 1,
      onStatus: status => statuses.push(status),
    }).start()
    cleanups.push(async () => { client.stop(); for (const ws of wss.clients) ws.terminate(); wss.close() })
    const failed = await waitForStatus(client, "reconnecting")
    assert.match(failed.lastError ?? "", /Unexpected server response: 401/)
    assert.equal(failed.reconnectAttempts, 1)
    accept = true
    const recovered = await waitForStatus(client, "connected")
    assert.ok(statuses.some(status => status.state === "connecting" && status.lastError === failed.lastError))
    assert.equal(recovered.lastError, null)
    assert.equal(recovered.reconnectAttempts, 0)
  })

  it("retains protocol mismatch diagnostics and replaces them with a meaningful close reason", async () => {
    const relay = createServer()
    const wss = new WebSocketServer({ server: relay })
    const relayPort = await listen(relay)
    cleanups.push(() => closeQuietly(relay))
    let attempts = 0
    wss.on("connection", ws => {
      if (++attempts === 1) {
        ws.send(JSON.stringify({ type: "ready", v: WIRE_VERSION + 1, publicUrl: "http://relay.test" }))
      } else {
        ws.close(CLOSE_UNAUTHORIZED)
      }
    })
    const client = new TunnelClient({ relayUrl: `ws://127.0.0.1:${relayPort}`, key: KEY, localPort: 1 }).start()
    cleanups.push(async () => { client.stop(); for (const ws of wss.clients) ws.terminate(); wss.close() })
    const failed = await waitForStatus(client, "reconnecting")
    assert.match(failed.lastError ?? "", /relay protocol version.*upgrade/)
    const replaced = await waitForStatus(client, "reconnecting", 2)
    assert.match(replaced.lastError ?? "", /relay rejected the tunnel key/)
  })
})
