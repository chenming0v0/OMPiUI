import assert from "node:assert/strict"
import { createHash, randomBytes } from "node:crypto"
import {
  Agent,
  request as httpRequest,
  createServer as createHttpServer,
  type IncomingMessage,
  type Server as HttpServer,
  type ServerResponse,
} from "node:http"
import { connect, createServer as createTcpServer, type Server as TcpServer, type Socket } from "node:net"
import { performance } from "node:perf_hooks"
import { Transform, type TransformCallback } from "node:stream"
import { test } from "node:test"
import { WebSocket, WebSocketServer, type RawData } from "ws"
import type { TunnelStatus } from "@ompiui/protocol"
import { startRelay } from "@ompiui/relay"
import {
  createHistoryBenchmarkFixture,
  HISTORY_DATASET_NAME,
  HISTORY_ENTRY_BYTES,
  HISTORY_ENTRY_COUNT,
  HISTORY_MESSAGE_BYTES,
  HISTORY_MESSAGE_COUNT,
  type HistoryBenchmarkEntry,
  type HistoryBenchmarkFixture,
} from "../../test-fixtures/remote-history-benchmark-fixture.ts"
import { TunnelClient } from "./tunnel-client.ts"

const KEY = "remote-link-benchmark-key-0123456789"
const RAMP = [
  { downloadKbps: 1024, uploadKbps: 256 },
  { downloadKbps: 512, uploadKbps: 128 },
  { downloadKbps: 256, uploadKbps: 64 },
]
const HISTORY_SESSION_ID = "history-benchmark"
const HISTORY_PAGE_LIMIT = 100
const HISTORY_PAGE_MAX_BYTES = 128 * 1024
const ENTRY_CHUNK_CHARS = 64 * 1024

interface LinkStats {
  uploadBytes: number
  downloadBytes: number
}

class RateLimitedTransform extends Transform {
  private tokens: number
  private updatedAt = performance.now()
  private timer?: NodeJS.Timeout

  constructor(
    private readonly rate: () => number,
    private readonly record: (bytes: number) => void,
  ) {
    super()
    this.tokens = this.capacity()
  }

  override _transform(chunk: Buffer, _encoding: BufferEncoding, callback: TransformCallback): void {
    const rate = this.rate()
    const now = performance.now()
    const capacity = this.capacity(rate)
    this.tokens = Math.min(capacity, this.tokens + Math.max(0, now - this.updatedAt) * rate / 1000)
    this.updatedAt = now
    this.record(chunk.length)

    const missing = chunk.length - this.tokens
    if (missing <= 0) {
      this.tokens -= chunk.length
      callback(null, chunk)
      return
    }

    this.tokens = 0
    this.timer = setTimeout(() => {
      this.timer = undefined
      this.updatedAt = performance.now()
      callback(null, chunk)
    }, missing / rate * 1000)
  }

  override _destroy(error: Error | null, callback: (error?: Error | null) => void): void {
    if (this.timer) clearTimeout(this.timer)
    callback(error)
  }

  private capacity(rate = this.rate()): number {
    return Math.max(1024, rate * 0.05)
  }
}

function createLinkProxy(destinationPort: number) {
  const sockets = new Set<Socket>()
  const stats: LinkStats = { uploadBytes: 0, downloadBytes: 0 }
  let uploadRate = 128_000
  let downloadRate = 512_000

  const server = createTcpServer(client => {
    sockets.add(client)
    client.once("close", () => sockets.delete(client))

    const upstream = connect(destinationPort, "127.0.0.1")
    sockets.add(upstream)
    upstream.once("close", () => sockets.delete(upstream))

    const upload = new RateLimitedTransform(
      () => uploadRate,
      bytes => { stats.uploadBytes += bytes },
    )
    const download = new RateLimitedTransform(
      () => downloadRate,
      bytes => { stats.downloadBytes += bytes },
    )

    client.pipe(upload).pipe(upstream)
    upstream.pipe(download).pipe(client)
    client.on("error", () => upstream.destroy())
    upstream.on("error", () => client.destroy())
    client.once("close", () => {
      upload.destroy()
      download.destroy()
      upstream.destroy()
    })
    upstream.once("close", () => {
      upload.destroy()
      download.destroy()
      client.destroy()
    })
  })

  return {
    server,
    listen: () => listenTcp(server),
    setRates(uploadKbps: number, downloadKbps: number) {
      uploadRate = uploadKbps * 1000 / 8
      downloadRate = downloadKbps * 1000 / 8
    },
    reset() {
      stats.uploadBytes = 0
      stats.downloadBytes = 0
    },
    snapshot(): LinkStats {
      return { ...stats }
    },
    async close() {
      for (const socket of sockets) socket.destroy()
      await new Promise<void>((resolve, reject) => {
        server.close(error => error ? reject(error) : resolve())
      })
    },
  }
}

function listenTcp(server: TcpServer): Promise<number> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error) => reject(error)
    server.once("error", onError)
    server.listen(0, "127.0.0.1", () => {
      server.removeListener("error", onError)
      const address = server.address()
      if (typeof address !== "object" || !address) {
        reject(new Error("TCP proxy did not bind to a port"))
        return
      }
      resolve(address.port)
    })
  })
}

function listenHttp(server: HttpServer): Promise<number> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error) => reject(error)
    server.once("error", onError)
    server.listen(0, "127.0.0.1", () => {
      server.removeListener("error", onError)
      const address = server.address()
      if (typeof address !== "object" || !address) {
        reject(new Error("HTTP server did not bind to a port"))
        return
      }
      resolve(address.port)
    })
  })
}

function toBuffer(data: RawData): Buffer {
  if (Array.isArray(data)) return Buffer.concat(data)
  if (Buffer.isBuffer(data)) return data
  return Buffer.from(data as ArrayBuffer)
}

type HistoryPageItem = HistoryBenchmarkEntry | {
  type: "ompiui.entry_ref"
  id: string
  parentId: string | null
  timestamp: string
  contentRef: { etag: string; totalChars: number }
}

interface HistoryPage {
  head: Record<string, unknown>
  items: HistoryPageItem[]
  hasMore: boolean
  beforeCursor?: string
  syncCursor: string
}

type HistoryEntryChunk = {
  entryId: string
  etag: string
  totalChars: number
  offset: number
  nextOffset: number
  content: string
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    req.on("data", chunk => chunks.push(Buffer.from(chunk)))
    req.on("error", reject)
    req.on("end", () => resolve(Buffer.concat(chunks)))
  })
}

function writeJson(res: ServerResponse, data: unknown): void {
  const body = Buffer.from(JSON.stringify({ data }))
  res.writeHead(200, { "content-type": "application/json", "content-length": String(body.length) })
  res.end(body)
}

function createHistoryPage(
  entries: HistoryBenchmarkEntry[],
  serializedEntries: Map<string, string>,
  beforeId: string | undefined,
  limit: number,
  maxBytes: number,
): HistoryPage {
  const head = {
    sdkVersion: "benchmark",
    revision: 1,
    sessionFormatVersion: 3,
    header: { id: HISTORY_SESSION_ID, cwd: "/workspace", name: HISTORY_DATASET_NAME },
    leafId: entries.at(-1)?.id ?? null,
    entryCount: entries.length,
    epoch: "x".repeat(22),
  }
  const end = beforeId === undefined ? entries.length : entries.findIndex(entry => entry.id === beforeId)
  if (end < 0) throw new Error(`unknown history anchor: ${beforeId}`)
  const syncCursor = "x".repeat(36)
  const cursorLength = (beforeId: string) =>
    Math.ceil(Buffer.byteLength(JSON.stringify({ v: 1, epoch: head.epoch, beforeId })) * 4 / 3) + 44
  const pageValue = (items: HistoryPageItem[], hasMore: boolean): HistoryPage => ({
    head,
    items,
    hasMore,
    ...(hasMore ? { beforeCursor: "x".repeat(cursorLength(items[0]?.id ?? "")) } : {}),
    syncCursor,
  })
  const makeReference = (entry: HistoryBenchmarkEntry): HistoryPageItem => {
    const serialized = serializedEntries.get(entry.id)!
    const etag = createHash("sha256").update(serialized).digest("hex")
    return {
      type: "ompiui.entry_ref",
      id: entry.id,
      parentId: entry.parentId,
      timestamp: entry.timestamp,
      contentRef: { etag, totalChars: serialized.length },
    }
  }

  const selectedDescending: HistoryPageItem[] = []
  let index = end - 1
  while (index >= 0 && selectedDescending.length < limit) {
    const entry = entries[index]!
    const fullPage = pageValue([entry], true)
    let item: HistoryPageItem = Buffer.byteLength(JSON.stringify(fullPage)) > maxBytes
      ? makeReference(entry)
      : entry
    const candidate = pageValue([...selectedDescending, item].reverse(), index > 0)
    if (Buffer.byteLength(JSON.stringify(candidate)) > maxBytes) {
      if (selectedDescending.length === 0) throw new Error(`history entry ${entry.id} exceeds the page budget`)
      break
    }
    selectedDescending.push(item)
    index--
  }
  return pageValue(selectedDescending.reverse(), index >= 0)
}

async function startWorkloadServer(history?: HistoryBenchmarkFixture) {
  const historyStats = { previewRequests: 0, branchRequests: 0, entryRequests: 0 }
  const serializedEntries = new Map<string, string>(history?.entries.map(entry => [entry.id, JSON.stringify(entry)] as const) ?? [])
  const entryEtags = new Map<string, string>()
  const server = createHttpServer((req, res) => {
    if (req.method !== "POST") {
      res.writeHead(404).end()
      return
    }

    if (req.url === "/api/v1/session/input") {
      void readBody(req).then(body => {
        res.writeHead(200, { "content-type": "application/octet-stream", "content-length": String(body.length) })
        res.end(body)
      }, () => res.writeHead(400).end())
      return
    }

    if (!history) {
      res.writeHead(404).end()
      return
    }

    void (async () => {
      const params = JSON.parse((await readBody(req)).toString() || "{}") as Record<string, unknown>
      if (req.url === "/api/v1/pi/commands/session.preview") {
        historyStats.previewRequests++
        const branch = createHistoryPage(
          history.entries,
          serializedEntries,
          typeof params.beforeId === "string" ? params.beforeId : undefined,
          typeof params.limit === "number" ? params.limit : HISTORY_PAGE_LIMIT,
          typeof params.maxBytes === "number" ? params.maxBytes : HISTORY_PAGE_MAX_BYTES,
        )
        writeJson(res, {
          state: {
            sessionId: HISTORY_SESSION_ID,
            readOnly: false,
            diskPreview: true,
            sessionFile: "/fixture/history.jsonl",
            sessionName: HISTORY_DATASET_NAME,
            cwd: "/workspace",
            model: null,
            thinkingLevel: "medium",
            isStreaming: false,
            isCompacting: false,
            steeringMode: null,
            followUpMode: null,
            autoCompactionEnabled: true,
            autoRetryEnabled: true,
            messageCount: HISTORY_MESSAGE_COUNT,
            pendingMessageCount: 0,
            availableThinkingLevels: ["off", "minimal", "low", "medium", "high", "xhigh", "max"],
          },
          branch,
        })
        return
      }

      const sessionCommand = new RegExp(`^/api/v1/pi/sessions/${HISTORY_SESSION_ID}/commands/(branch\\.get|entry\\.get)$`).exec(req.url ?? "")
      if (!sessionCommand) {
        res.writeHead(404).end()
        return
      }
      if (sessionCommand[1] === "branch.get") {
        historyStats.branchRequests++
        writeJson(res, createHistoryPage(
          history.entries,
          serializedEntries,
          typeof params.beforeId === "string" ? params.beforeId : undefined,
          typeof params.limit === "number" ? params.limit : HISTORY_PAGE_LIMIT,
          typeof params.maxBytes === "number" ? params.maxBytes : HISTORY_PAGE_MAX_BYTES,
        ))
        return
      }

      historyStats.entryRequests++
      const entryId = typeof params.entryId === "string" ? params.entryId : ""
      const serialized = serializedEntries.get(entryId)
      if (!serialized) {
        res.writeHead(404).end()
        return
      }
      let etag = entryEtags.get(entryId)
      if (!etag) {
        etag = createHash("sha256").update(serialized).digest("hex")
        entryEtags.set(entryId, etag)
      }
      const offset = typeof params.offset === "number" ? params.offset : 0
      if (params.etag !== etag || !Number.isSafeInteger(offset) || offset < 0 || offset > serialized.length) {
        res.writeHead(400).end()
        return
      }
      const nextOffset = Math.min(serialized.length, offset + ENTRY_CHUNK_CHARS)
      writeJson(res, {
        entryId,
        etag,
        totalChars: serialized.length,
        offset,
        nextOffset,
        content: serialized.slice(offset, nextOffset),
        hasMore: nextOffset < serialized.length,
      })
    })().catch(() => res.writeHead(500).end())
  })
  const webSocketServer = new WebSocketServer({ noServer: true })
  server.on("upgrade", (req, socket, head) => {
    if (req.url !== "/api/v1/events") {
      socket.destroy()
      return
    }
    webSocketServer.handleUpgrade(req, socket, head, ws => {
      ws.on("message", data => {
        const message = JSON.parse(toBuffer(data).toString()) as { id: string; payload: string }
        const digest = createHash("sha256").update(message.payload).digest("hex")
        ws.send(JSON.stringify({ id: message.id, digest }))
      })
    })
  })

  const port = await listenHttp(server)
  return {
    port,
    historyStats,
    async close() {
      for (const ws of webSocketServer.clients) ws.terminate()
      server.closeAllConnections()
      await new Promise<void>((resolve, reject) => {
        server.close(error => error ? reject(error) : resolve())
      })
    },
  }
}

async function waitForConnected(client: TunnelClient): Promise<TunnelStatus> {
  const deadline = Date.now() + 5_000
  while (Date.now() < deadline) {
    const status = client.getStatus()
    if (status.state === "connected") return status
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  throw new Error(`tunnel did not connect: ${JSON.stringify(client.getStatus())}`)
}

function postInput(port: number, body: Buffer): Promise<{ status: number; body: Buffer }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({
      host: "127.0.0.1",
      port,
      path: "/api/v1/session/input",
      method: "POST",
      agent: false,
      headers: {
        "content-type": "application/json",
        "content-length": String(body.length),
      },
    }, res => {
      const chunks: Buffer[] = []
      res.on("data", chunk => chunks.push(Buffer.from(chunk)))
      res.on("error", reject)
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks) }))
    })
    req.on("error", reject)
    req.end(body)
  })
}

function postJsonData(port: number, path: string, params: unknown, agent: Agent): Promise<{ status: number; data: unknown }> {
  const body = Buffer.from(JSON.stringify(params))
  return new Promise((resolve, reject) => {
    const req = httpRequest({
      host: "127.0.0.1",
      port,
      path,
      method: "POST",
      agent,
      headers: { "content-type": "application/json", "content-length": String(body.length) },
    }, res => {
      const chunks: Buffer[] = []
      res.on("data", chunk => chunks.push(Buffer.from(chunk)))
      res.on("error", reject)
      res.on("end", () => {
        const payload = JSON.parse(Buffer.concat(chunks).toString()) as { data?: unknown }
        resolve({ status: res.statusCode ?? 0, data: payload.data })
      })
    })
    req.on("error", reject)
    req.end(body)
  })
}

async function scrollHistoryToTop(port: number, agent: Agent): Promise<{
  entries: HistoryBenchmarkEntry[]
  pages: number
  hydratedEntries: number
  hydrationRequests: number
}> {
  const read = async <T>(path: string, params: unknown): Promise<T> => {
    const response = await postJsonData(port, path, params, agent)
    assert.equal(response.status, 200, `history request failed: ${path}`)
    return response.data as T
  }
  const hydrate = async (items: HistoryPageItem[]) => {
    const result: HistoryBenchmarkEntry[] = []
    let hydratedEntries = 0
    let hydrationRequests = 0
    for (const item of items) {
      if (item.type !== "ompiui.entry_ref") {
        result.push(item)
        continue
      }
      hydratedEntries++
      const parts: string[] = []
      let offset = 0
      while (offset < item.contentRef.totalChars) {
        const chunk: HistoryEntryChunk = await read<HistoryEntryChunk>(
          `/api/v1/pi/sessions/${HISTORY_SESSION_ID}/commands/entry.get`,
          {
            entryId: item.id,
            offset,
            etag: item.contentRef.etag,
          },
        )
        hydrationRequests++
        assert.equal(chunk.entryId, item.id)
        assert.equal(chunk.etag, item.contentRef.etag)
        assert.equal(chunk.offset, offset)
        assert.equal(chunk.totalChars, item.contentRef.totalChars)
        assert.ok(chunk.nextOffset > offset)
        assert.equal(chunk.nextOffset - offset, chunk.content.length)
        parts.push(chunk.content)
        offset = chunk.nextOffset
      }
      const entry = JSON.parse(parts.join("")) as HistoryBenchmarkEntry
      assert.equal(entry.id, item.id)
      result.push(entry)
    }
    return { entries: result, hydratedEntries, hydrationRequests }
  }

  const preview = await read<{ state: { diskPreview?: boolean }; branch: HistoryPage }>(
    "/api/v1/pi/commands/session.preview",
    { sessionId: HISTORY_SESSION_ID, limit: HISTORY_PAGE_LIMIT, maxBytes: HISTORY_PAGE_MAX_BYTES },
  )
  assert.equal(preview.state.diskPreview, true)
  let page = preview.branch
  let current = await hydrate(page.items)
  let entries = current.entries
  let pages = 1
  let hydratedEntries = current.hydratedEntries
  let hydrationRequests = current.hydrationRequests

  while (page.hasMore) {
    page = await read<HistoryPage>(`/api/v1/pi/sessions/${HISTORY_SESSION_ID}/commands/branch.get`, {
      beforeId: entries[0]?.id,
      limit: HISTORY_PAGE_LIMIT,
      maxBytes: HISTORY_PAGE_MAX_BYTES,
    })
    current = await hydrate(page.items)
    entries = [...current.entries, ...entries]
    pages++
    hydratedEntries += current.hydratedEntries
    hydrationRequests += current.hydrationRequests
    if (pages > HISTORY_ENTRY_COUNT) throw new Error("history pagination did not reach its first page")
  }

  return { entries, pages, hydratedEntries, hydrationRequests }
}

function openEvents(port: number): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/api/v1/events`)
    ws.on("error", () => {})
    const onOpen = () => {
      ws.off("error", onError)
      resolve(ws)
    }
    const onError = (error: Error) => {
      ws.off("open", onOpen)
      reject(error)
    }
    ws.once("open", onOpen)
    ws.once("error", onError)
  })
}

function exchange(ws: WebSocket, message: { id: string; payload: string }): Promise<{ id: string; digest: string }> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(new Error("event exchange timed out")), 10_000)
    const cleanup = () => {
      clearTimeout(timer)
      ws.off("message", onMessage)
      ws.off("error", onError)
    }
    const finish = (error?: Error, result?: { id: string; digest: string }) => {
      cleanup()
      if (error) reject(error)
      else if (result) resolve(result)
      else reject(new Error("event exchange returned no result"))
    }
    const onMessage = (data: RawData) => {
      try {
        finish(undefined, JSON.parse(toBuffer(data).toString()) as { id: string; digest: string })
      } catch (error) {
        finish(error instanceof Error ? error : new Error(String(error)))
      }
    }
    const onError = (error: Error) => finish(error)

    ws.once("message", onMessage)
    ws.once("error", onError)
    ws.send(JSON.stringify(message), error => {
      if (error) finish(error)
    })
  })
}

async function closeEvents(ws: WebSocket): Promise<void> {
  if (ws.readyState === WebSocket.CLOSED) return
  await new Promise<void>(resolve => {
    ws.once("close", () => resolve())
    ws.close()
  })
}

test("remote-link traffic and behavior across a slow-link ramp", { timeout: 60_000 }, async t => {
  const cleanups: Array<() => Promise<void> | void> = []
  t.after(async () => {
    for (const cleanup of cleanups.reverse()) await cleanup()
  })

  const upstream = await startWorkloadServer()
  cleanups.push(() => upstream.close())

  const relay = await startRelay({ config: { port: 0, tunnels: [{ id: "ompiui", key: KEY }] }, log: () => {} })
  cleanups.push(() => relay.close())

  const visitorLink = createLinkProxy(relay.port)
  const visitorPort = await visitorLink.listen()
  cleanups.push(() => visitorLink.close())

  const desktopLink = createLinkProxy(relay.port)
  const desktopPort = await desktopLink.listen()
  cleanups.push(() => desktopLink.close())

  const client = new TunnelClient({ relayUrl: `ws://127.0.0.1:${desktopPort}`, key: KEY, localPort: upstream.port }).start()
  cleanups.push(() => client.stop())
  await waitForConnected(client)

  let referenceStreamBytes: number | undefined
  for (const step of RAMP) {
    visitorLink.setRates(step.uploadKbps, step.downloadKbps)
    desktopLink.setRates(step.uploadKbps, step.downloadKbps)
    visitorLink.reset()
    desktopLink.reset()
    const startedAt = performance.now()

    const requestBody = Buffer.from(JSON.stringify({
      id: randomBytes(12).toString("hex"),
      method: "session.input",
      text: randomBytes(768).toString("base64"),
    }))
    const response = await postInput(visitorPort, requestBody)
    assert.equal(response.status, 200)
    assert.deepEqual(response.body, requestBody)

    const ws = await openEvents(visitorPort)
    cleanups.push(() => {
      if (ws.readyState !== WebSocket.CLOSED) ws.terminate()
    })
    const runId = randomBytes(8).toString("hex")
    for (let index = 0; index < 12; index++) {
      const payload = randomBytes(128).toString("base64")
      const id = `${runId}-${index}`
      const result = await exchange(ws, { id, payload })
      assert.equal(result.id, id)
      assert.equal(result.digest, createHash("sha256").update(payload).digest("hex"))
    }
    await closeEvents(ws)
    assert.equal(client.getStatus().state, "connected")

    const visitorStats = visitorLink.snapshot()
    const desktopStats = desktopLink.snapshot()
    const totalStreamBytes = visitorStats.uploadBytes + visitorStats.downloadBytes
      + desktopStats.uploadBytes + desktopStats.downloadBytes
    assert.ok(visitorStats.uploadBytes > 0 && visitorStats.downloadBytes > 0)
    assert.ok(desktopStats.uploadBytes > 0 && desktopStats.downloadBytes > 0)
    assert.ok(totalStreamBytes < 32 * 1024, `workload emitted unexpected traffic: ${totalStreamBytes} stream bytes`)
    if (referenceStreamBytes !== undefined) {
      assert.ok(totalStreamBytes <= referenceStreamBytes + 1024, `slower rung added unexpected traffic: ${totalStreamBytes} vs ${referenceStreamBytes} stream bytes`)
    } else {
      referenceStreamBytes = totalStreamBytes
    }

    t.diagnostic(JSON.stringify({
      downloadKbps: step.downloadKbps,
      uploadKbps: step.uploadKbps,
      elapsedMs: Math.round(performance.now() - startedAt),
      visitor: visitorStats,
      desktop: desktopStats,
      totalStreamBytes,
    }))
  }
})

test(HISTORY_DATASET_NAME, { timeout: 120_000 }, async t => {
  const fixture = createHistoryBenchmarkFixture()
  assert.equal(fixture.entries.length, HISTORY_ENTRY_COUNT)
  assert.equal(fixture.serializedMessageBytes, HISTORY_MESSAGE_BYTES)
  assert.equal(fixture.serializedEntryBytes, HISTORY_ENTRY_BYTES)

  const cleanups: Array<() => Promise<void> | void> = []
  t.after(async () => {
    for (const cleanup of cleanups.reverse()) await cleanup()
  })

  const upstream = await startWorkloadServer(fixture)
  cleanups.push(() => upstream.close())

  const relay = await startRelay({ config: { port: 0, tunnels: [{ id: "ompiui", key: KEY }] }, log: () => {} })
  cleanups.push(() => relay.close())

  const visitorLink = createLinkProxy(relay.port)
  const visitorPort = await visitorLink.listen()
  cleanups.push(() => visitorLink.close())

  const desktopLink = createLinkProxy(relay.port)
  const desktopPort = await desktopLink.listen()
  cleanups.push(() => desktopLink.close())

  const client = new TunnelClient({ relayUrl: `ws://127.0.0.1:${desktopPort}`, key: KEY, localPort: upstream.port }).start()
  cleanups.push(() => client.stop())
  await waitForConnected(client)

  const agent = new Agent({ keepAlive: true, maxSockets: 4 })
  cleanups.push(() => agent.destroy())
  visitorLink.setRates(100_000, 100_000)
  desktopLink.setRates(100_000, 100_000)
  visitorLink.reset()
  desktopLink.reset()

  const startedAt = performance.now()
  const result = await scrollHistoryToTop(visitorPort, agent)
  const visitorStats = visitorLink.snapshot()
  const desktopStats = desktopLink.snapshot()
  const phoneDownlinkBytes = visitorStats.downloadBytes
  const totalStreamBytes = visitorStats.uploadBytes + visitorStats.downloadBytes
    + desktopStats.uploadBytes + desktopStats.downloadBytes

  assert.deepEqual(result.entries, fixture.entries)
  assert.equal(result.entries.length, HISTORY_ENTRY_COUNT)
  assert.equal(result.entries.filter(entry => entry.type === "message").length, HISTORY_MESSAGE_COUNT)
  assert.ok(result.pages > 100 && result.pages < 300, `unexpected page count: ${result.pages}`)
  assert.equal(result.hydratedEntries, 3)
  assert.equal(result.hydrationRequests, 9)
  assert.equal(upstream.historyStats.previewRequests, 1)
  assert.equal(upstream.historyStats.branchRequests, result.pages - 1)
  assert.equal(upstream.historyStats.entryRequests, result.hydrationRequests)
  assert.ok(phoneDownlinkBytes >= fixture.serializedEntryBytes)
  assert.ok(phoneDownlinkBytes < 24 * 1024 * 1024, `phone downlink repeated too much history: ${phoneDownlinkBytes} bytes`)
  assert.equal(client.getStatus().state, "connected")

  t.diagnostic(JSON.stringify({
    dataset: HISTORY_DATASET_NAME,
    timelineEntryCount: result.entries.length,
    messageCount: result.entries.filter(entry => entry.type === "message").length,
    sourceMessageBytes: fixture.serializedMessageBytes,
    sourceTimelineEntryBytes: fixture.serializedEntryBytes,
    pages: result.pages,
    hydratedEntries: result.hydratedEntries,
    hydrationRequests: result.hydrationRequests,
    phoneDownlinkBytes,
    phoneUploadBytes: visitorStats.uploadBytes,
    desktopToRelayBytes: desktopStats.uploadBytes,
    relayToDesktopBytes: desktopStats.downloadBytes,
    totalStreamBytes,
    elapsedMs: Math.round(performance.now() - startedAt),
  }))
})
