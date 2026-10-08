import assert from "node:assert/strict"
import { createServer, request as httpRequest, type ClientRequest, type IncomingHttpHeaders, type Server } from "node:http"
import type { Duplex } from "node:stream"
import { after, describe, it } from "node:test"
import { WebSocket, WebSocketServer, type RawData } from "ws"
import { generateTunnelKey } from "./config.ts"
import {
  CONTROL_PATH,
  decodeFrameMessage,
  encodeFrameMessages,
  stripHopByHopHeaders,
  type ControlFrame,
} from "./protocol.ts"
import { startRelay, type RunningRelay } from "./relay.ts"

const KEY = generateTunnelKey()
const noop = () => {}

function toBuffer(data: RawData): Buffer {
  if (Array.isArray(data)) return Buffer.concat(data)
  if (Buffer.isBuffer(data)) return data
  return Buffer.from(data as ArrayBuffer)
}

// ---------- 迷你桌面端：协议客户端侧的独立实现，用于交叉验证 ----------

class MiniDesktop {
  private readonly ws: WebSocket
  private readonly conns = new Map<number, { req?: ClientRequest; socket?: Duplex }>()
  readonly ready: Promise<{ tunnel: string; publicUrl: string | null }>

  constructor(private readonly options: { relayUrl: string; key: string; upstreamPort: number; tunnelId?: string }) {
    this.ws = new WebSocket(`${options.relayUrl}${CONTROL_PATH}`, {
      headers: {
        authorization: `Bearer ${options.key}`,
        "x-ompiui-tunnel": options.tunnelId ?? "ompiui",
      },
    })
    this.ready = new Promise((resolve, reject) => {
      this.ws.on("message", (data: RawData, isBinary: boolean) => {
        try {
          this.onMessage(data, isBinary, resolve)
        } catch (error) {
          reject(error)
        }
      })
      this.ws.on("error", reject)
    })
  }

  private onMessage(data: RawData, isBinary: boolean, resolveReady: (value: { tunnel: string; publicUrl: string | null }) => void): void {
    if (isBinary) {
      const buffer = toBuffer(data)
      const frame = decodeFrameMessage(buffer)
      if (!frame) throw new Error("malformed binary frame from relay")
      const conn = this.conns.get(frame.connId)
      if (conn?.socket) conn.socket.write(frame.payload)
      else conn?.req?.write(frame.payload)
      return
    }
    const frame = JSON.parse(toBuffer(data).toString("utf8")) as ControlFrame
    switch (frame.type) {
      case "ready":
        resolveReady({ tunnel: frame.tunnel, publicUrl: frame.publicUrl })
        return
      case "open":
        this.forward(frame)
        return
      case "reqEnd":
        this.conns.get(frame.c)?.req?.end()
        return
      case "abort":
      case "close": {
        const conn = this.conns.get(frame.c)
        conn?.req?.destroy()
        conn?.socket?.destroy()
        this.conns.delete(frame.c)
        return
      }
      default:
        return
    }
  }

  private forward(frame: Extract<ControlFrame, { type: "open" }>): void {
    const headers = { ...frame.h }
    const isUpgrade = typeof headers.upgrade === "string" && headers.upgrade.length > 0
    const req = httpRequest(
      { host: "127.0.0.1", port: this.options.upstreamPort, method: frame.m, path: frame.u, headers },
      res => {
        this.sendControl({ type: "head", c: frame.c, s: res.statusCode ?? 502, h: stripHopByHopHeaders(res.headers) })
        res.on("data", (chunk: Buffer) => this.sendBody(frame.c, chunk))
        res.on("end", () => this.sendControl({ type: "end", c: frame.c }))
      },
    )
    req.on("upgrade", (res, socket, head) => {
      this.conns.get(frame.c)!.socket = socket
      this.sendControl({ type: "head", c: frame.c, s: res.statusCode ?? 101, h: stripHopByHopHeaders(res.headers, true) })
      if (head.length > 0) this.sendBody(frame.c, head)
      socket.on("data", (chunk: Buffer) => this.sendBody(frame.c, chunk))
      socket.on("close", () => this.sendControl({ type: "close", c: frame.c }))
      socket.on("error", noop)
    })
    req.on("error", (error: NodeJS.ErrnoException) => {
      this.sendControl({ type: "fail", c: frame.c, e: error.code ?? error.message })
      this.conns.delete(frame.c)
    })
    // WebSocket 握手没有请求体：请求头必须立即冲刷，上游才会回 101
    if (isUpgrade) req.end()
    this.conns.set(frame.c, { req })
  }

  private sendControl(frame: ControlFrame): void {
    this.ws.send(JSON.stringify(frame))
  }

  private sendBody(connId: number, chunk: Buffer): void {
    for (const message of encodeFrameMessages(connId, chunk)) this.ws.send(message, { binary: true })
  }

  close(): void {
    this.ws.close()
  }
}

// ---------- mock 上游（扮演本机 OMPiUI server 的最小 HTTP+WS 服务） ----------

async function startUpstream(marker: string): Promise<{ server: Server; port: number }> {
  const server = createServer((req, res) => {
    if (req.url === "/hello") {
      res.writeHead(200, { "content-type": "text/plain", "x-marker": marker })
      res.end(`hello from ${marker}`)
      return
    }
    if (req.url === "/headers") {
      const chunks: Buffer[] = []
      req.on("data", chunk => chunks.push(chunk as Buffer))
      req.on("end", () => {
        res.writeHead(200, { "content-type": "application/json" })
        res.end(JSON.stringify(req.headers))
      })
      return
    }
    if (req.url === "/echo") {
      const chunks: Buffer[] = []
      req.on("data", chunk => chunks.push(chunk as Buffer))
      req.on("end", () => {
        const body = Buffer.concat(chunks)
        res.writeHead(200, { "content-type": "application/octet-stream", "content-length": String(body.length) })
        res.end(body)
      })
      return
    }
    res.writeHead(404)
    res.end()
  })
  const wss = new WebSocketServer({ noServer: true })
  server.on("upgrade", (req, socket, head) => {
    wss.handleUpgrade(req, socket, head, ws => {
      ws.on("message", data => ws.send(`echo:${data.toString()}`))
      ws.on("error", noop)
    })
  })
  const port = await listen(server)
  return { server, port }
}

function listen(server: Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", () => {
      const address = server.address()
      resolve(typeof address === "object" && address ? address.port : 0)
    })
  })
}

function closeRelay(relay: RunningRelay): Promise<void> {
  return relay.close()
}

function closeUpstream(server: Server): Promise<void> {
  server.closeAllConnections()
  return new Promise((resolve, reject) => server.close(error => (error ? reject(error) : resolve())))
}

interface RawResponse {
  status: number
  headers: IncomingHttpHeaders
  body: Buffer
}

function request(url: string, options: { method?: string; headers?: Record<string, string>; body?: Buffer } = {}): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url)
    const req = httpRequest(
      { host: parsed.hostname, port: parsed.port, path: `${parsed.pathname}${parsed.search}`, method: options.method ?? "GET", headers: options.headers },
      res => {
        const chunks: Buffer[] = []
        res.on("data", chunk => chunks.push(chunk as Buffer))
        res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) }))
      },
    )
    req.on("error", reject)
    if (options.body) req.end(options.body)
    else req.end()
  })
}

// ---------- 用例 ----------

describe("relay integration", () => {
  const cleanups: Array<() => Promise<void>> = []
  after(async () => {
    for (const cleanup of cleanups.reverse()) await cleanup().catch(noop)
  })

  it("routes HTTP and WS upgrades through the tunnel", async () => {
    const upstream = await startUpstream("alpha")
    const relay = await startRelay({ config: { port: 0, tunnels: [{ id: "ompiui", key: KEY }] }, log: noop })
    cleanups.push(() => closeUpstream(upstream.server), () => closeRelay(relay))
    const base = `http://127.0.0.1:${relay.port}`

    const desktop = new MiniDesktop({ relayUrl: base, key: KEY, upstreamPort: upstream.port })
    const readyInfo = await desktop.ready
    assert.equal(readyInfo.tunnel, "ompiui")
    // 单隧道无 publicUrl 配置时用控制连接的 Host 推导
    assert.equal(readyInfo.publicUrl, `http://127.0.0.1:${relay.port}`)

    const hello = await request(`${base}/hello`)
    assert.equal(hello.status, 200)
    assert.equal(hello.body.toString(), "hello from alpha")
    assert.equal(hello.headers["x-marker"], "alpha")

    const seen = JSON.parse((await request(`${base}/headers`, { headers: { "x-probe": "1" } })).body.toString()) as Record<string, string>
    assert.equal(seen["x-probe"], "1")
    assert.equal(seen["x-forwarded-proto"], "http")
    assert.ok((seen["x-forwarded-for"] ?? "").length > 0)
    assert.equal(seen.host, `127.0.0.1:${relay.port}`)

    // 大 body 往返：跨多条 64KiB 帧
    const big = Buffer.alloc(200_000, 0x5a)
    const echoed = await request(`${base}/echo`, { method: "POST", headers: { "content-length": String(big.length) }, body: big })
    assert.equal(echoed.status, 200)
    assert.ok(echoed.body.equals(big))

    const ws = new WebSocket(`ws://127.0.0.1:${relay.port}/ws`)
    const reply = await new Promise<string>((resolve, reject) => {
      ws.on("open", () => ws.send("ping"))
      ws.on("message", data => resolve(data.toString()))
      ws.on("error", reject)
    })
    assert.equal(reply, "echo:ping")
    ws.close()

    // healthz 是中转自身端点，不进隧道
    const health = await request(`${base}/healthz`)
    assert.equal(health.status, 200)
    assert.equal(health.body.toString(), "ok")

    desktop.close()
  })

  it("answers 502 TUNNEL_OFFLINE while the desktop is away", async () => {
    const relay = await startRelay({ config: { port: 0, tunnels: [{ id: "ompiui", key: KEY }] }, log: noop })
    cleanups.push(() => closeRelay(relay))
    const response = await request(`http://127.0.0.1:${relay.port}/hello`)
    assert.equal(response.status, 502)
    assert.equal((JSON.parse(response.body.toString()) as { code: string }).code, "TUNNEL_OFFLINE")
  })

  it("rejects duplicate control connections and bad keys without dropping the first session", async () => {
    const upstream = await startUpstream("alpha")
    const relay = await startRelay({ config: { port: 0, tunnels: [{ id: "ompiui", key: KEY }] }, log: noop })
    cleanups.push(() => closeUpstream(upstream.server), () => closeRelay(relay))
    const base = `http://127.0.0.1:${relay.port}`
    const first = new MiniDesktop({ relayUrl: base, key: KEY, upstreamPort: upstream.port })
    await first.ready
    await assert.rejects(new MiniDesktop({ relayUrl: base, key: KEY, upstreamPort: upstream.port }).ready, /409/)
    await assert.rejects(new MiniDesktop({ relayUrl: base, key: generateTunnelKey(), upstreamPort: upstream.port }).ready, /401/)
    assert.deepEqual(relay.onlineTunnelIds(), ["ompiui"])
    const stillServing = await request(`${base}/hello`)
    assert.equal(stillServing.status, 200)
    first.close()
  })

  it("honors explicit host binding and skips the single-tunnel fallback", async () => {
    const alpha = await startUpstream("alpha")
    const beta = await startUpstream("beta")
    const keyB = generateTunnelKey()
    const relay = await startRelay({
      config: {
        port: 0,
        tunnels: [
          { id: "a", key: KEY, host: "a.relay.test" },
          { id: "b", key: keyB },
        ],
      },
      log: noop,
    })
    cleanups.push(() => closeUpstream(alpha.server), () => closeUpstream(beta.server), () => closeRelay(relay))
    const base = `http://127.0.0.1:${relay.port}`
    const desktopA = new MiniDesktop({ relayUrl: base, key: KEY, upstreamPort: alpha.port, tunnelId: "a" })
    const desktopB = new MiniDesktop({ relayUrl: base, key: keyB, upstreamPort: beta.port, tunnelId: "b" })
    assert.equal((await desktopA.ready).publicUrl, `http://a.relay.test:${relay.port}`)
    await desktopB.ready

    const toA = await request(`${base}/hello`, { headers: { host: "a.relay.test" } })
    assert.equal(toA.body.toString(), "hello from alpha")
    // 显式路由生效后，未绑定的 Host 不允许落到其它在线隧道
    const unmatched = await request(`${base}/hello`, { headers: { host: "evil.relay.test" } })
    assert.equal(unmatched.status, 404)
    const offline = await request(`${base}/hello`, { headers: { host: "c.relay.test" } })
    assert.equal(offline.status, 404)
    desktopA.close()
    desktopB.close()
  })

  it("routes <id>.<domain> subdomains to matching tunnels", async () => {
    const alpha = await startUpstream("alpha")
    const beta = await startUpstream("beta")
    const keyB = generateTunnelKey()
    const relay = await startRelay({
      config: { port: 0, domain: "relay.test", tunnels: [{ id: "a", key: KEY }, { id: "b", key: keyB }] },
      log: noop,
    })
    cleanups.push(() => closeUpstream(alpha.server), () => closeUpstream(beta.server), () => closeRelay(relay))
    const base = `http://127.0.0.1:${relay.port}`
    const desktopA = new MiniDesktop({ relayUrl: base, key: KEY, upstreamPort: alpha.port, tunnelId: "a" })
    const desktopB = new MiniDesktop({ relayUrl: base, key: keyB, upstreamPort: beta.port, tunnelId: "b" })
    const readyA = await desktopA.ready
    const readyB = await desktopB.ready
    assert.equal(readyA.publicUrl, `http://a.relay.test:${relay.port}`)
    assert.equal(readyB.publicUrl, `http://b.relay.test:${relay.port}`)

    const toA = await request(`${base}/hello`, { headers: { host: new URL(readyA.publicUrl!).host } })
    const toB = await request(`${base}/hello`, { headers: { host: new URL(readyB.publicUrl!).host } })
    assert.equal(toA.body.toString(), "hello from alpha")
    assert.equal(toB.body.toString(), "hello from beta")
    const unknown = await request(`${base}/hello`, { headers: { host: "zz.relay.test" } })
    assert.equal(unknown.status, 404)
    desktopA.close()
    desktopB.close()
  })

  for (const publicUrl of ["https://entry.example:9443", "https://entry.example", "http://entry.example:8080"]) {
    it(`advertises routed hosts with the public protocol/port from ${publicUrl}`, async () => {
      const upstream = await startUpstream("routed")
      const relay = await startRelay({
        config: {
          port: 0, publicUrl, domain: "relay.test",
          tunnels: [{ id: "a", key: KEY }, { id: "b", key: KEY, host: "custom.example" }],
        },
        log: noop,
      })
      cleanups.push(() => closeUpstream(upstream.server), () => closeRelay(relay))
      const base = `http://127.0.0.1:${relay.port}`
      for (const [id, hostname] of [["a", "a.relay.test"], ["b", "custom.example"]]) {
        const desktop = new MiniDesktop({ relayUrl: base, key: KEY, upstreamPort: upstream.port, tunnelId: id })
        const ready = await desktop.ready
        const expected = new URL(publicUrl)
        expected.hostname = hostname!
        assert.equal(ready.publicUrl, expected.origin)
        const actual = await request(`${base}/hello`, { headers: { host: new URL(ready.publicUrl!).host } })
        assert.equal(actual.status, 200)
        assert.equal(actual.body.toString(), "hello from routed")
        const ws = new WebSocket(`${base.replace("http:", "ws:")}/ws`, { headers: { host: expected.host } })
        const reply = await new Promise<string>((resolve, reject) => {
          ws.on("open", () => ws.send("routed"))
          ws.on("message", data => resolve(data.toString()))
          ws.on("error", reject)
        })
        assert.equal(reply, "echo:routed")
        ws.close()
        desktop.close()
      }
      assert.equal((await request(`${base}/hello`, { headers: { host: new URL(publicUrl).host } })).status, 404)
    })
  }
})
