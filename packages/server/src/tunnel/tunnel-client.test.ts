import assert from "node:assert/strict"
import { createServer, request as httpRequest, type Server } from "node:http"
import { after, describe, it } from "node:test"
import { WebSocket, WebSocketServer } from "ws"
import type { TunnelStatus } from "@ompiui/protocol"
import { startRelay, type RunningRelay } from "@ompiui/relay"
import { TunnelClient } from "./tunnel-client.ts"

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

function request(url: string): Promise<{ status: number; body: Buffer }> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url)
    const req = httpRequest({ host: parsed.hostname, port: parsed.port, path: parsed.pathname }, res => {
      const chunks: Buffer[] = []
      res.on("data", chunk => chunks.push(chunk as Buffer))
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks) }))
    })
    req.on("error", reject)
    req.end()
  })
}

describe("TunnelClient against a live relay", () => {
  const cleanups: Array<() => Promise<void>> = []
  after(async () => {
    for (const cleanup of cleanups.reverse()) await cleanup().catch(noop)
  })

  it("dials the relay, serves HTTP and WS through the tunnel, and stops cleanly", async () => {
    // 本机"OMPiUI server"替身：一个 hello 端点 + 一个 WS echo 端点
    const upstream = createServer((req, res) => {
      if (req.url === "/api/v1/host/health") {
        res.writeHead(200, { "content-type": "application/json" })
        res.end(JSON.stringify({ ok: true, service: "ompiui-server" }))
        return
      }
      res.writeHead(404)
      res.end()
    })
    const upstreamWss = new WebSocketServer({ noServer: true })
    upstream.on("upgrade", (req, socket, head) => {
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

    const health = await request(`http://127.0.0.1:${relay.port}/api/v1/host/health`)
    assert.equal(health.status, 200)
    assert.equal((JSON.parse(health.body.toString()) as { service: string }).service, "ompiui-server")

    const ws = new WebSocket(`ws://127.0.0.1:${relay.port}/api/v1/events`)
    const reply = await new Promise<string>((resolve, reject) => {
      ws.on("open", () => ws.send("ping"))
      ws.on("message", data => resolve(data.toString()))
      ws.on("error", reject)
    })
    assert.equal(reply, "echo:ping")
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
})
