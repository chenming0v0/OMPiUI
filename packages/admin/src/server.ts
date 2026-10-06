import { timingSafeEqual } from "node:crypto"
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { dirname, join } from "node:path"
import { loadOrCreateAdminToken } from "./config.ts"
import { ServiceManager } from "./manager.ts"

function authorized(request: IncomingMessage, token: string): boolean {
  const value = request.headers.authorization
  if (typeof value !== "string" || !value.startsWith("Bearer ")) return false
  const provided = Buffer.from(value.slice(7))
  const expected = Buffer.from(token)
  return provided.length === expected.length && timingSafeEqual(provided, expected)
}

function json(response: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body)
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" })
  response.end(payload)
}

function requestPath(request: IncomingMessage): string {
  return new URL(request.url ?? "/", "http://ompiui-admin.local").pathname
}
async function readJsonBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    total += buffer.length
    if (total > 64 * 1024) throw new Error("request body is too large")
    chunks.push(buffer)
  }
  const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") as unknown
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("request body must be an object")
  return body as Record<string, unknown>
}

function stringField(body: Record<string, unknown>, key: string): string | undefined {
  const value = body[key]
  return value === undefined ? undefined : typeof value === "string" ? value : (() => { throw new Error(`${key} must be a string`) })()
}

export class AdminHttpServer {
  readonly manager: ServiceManager
  readonly token: string
  private readonly server: Server

  constructor(manager = new ServiceManager(), token = loadOrCreateAdminToken()) {
    this.manager = manager
    this.token = token
    this.server = createServer((request, response) => { void this.handle(request, response) })
  }

  async listen(host: string, port: number): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => { this.server.off("listening", onListening); reject(error) }
      const onListening = () => { this.server.off("error", onError); resolve() }
      this.server.once("error", onError)
      this.server.once("listening", onListening)
      this.server.listen(port, host)
    })
  }

  async close(): Promise<void> {
    if (!this.server.listening) return
    await new Promise<void>((resolve, reject) => this.server.close(error => error ? reject(error) : resolve()))
  }

  address(): string | null {
    const address = this.server.address()
    if (!address || typeof address === "string") return null
    return `http://${address.address}:${address.port}`
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const pathname = requestPath(request)
    if (pathname === "/" || pathname === "/index.html") {
      if (request.method !== "GET" && request.method !== "HEAD") {
        response.writeHead(405, { allow: "GET, HEAD" }); response.end(); return
      }
      const file = join(dirname(fileURLToPath(import.meta.url)), "../public/index.html")
      try {
        const body = readFileSync(file)
        response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" })
        response.end(request.method === "HEAD" ? undefined : body)
      } catch {
        json(response, 500, { error: "management UI is not installed" })
      }
      return
    }
    if (!pathname.startsWith("/api/")) { json(response, 404, { error: "not found" }); return }
    if (!authorized(request, this.token)) { json(response, 401, { error: "missing or invalid admin token" }); return }
    try {
      if (request.method === "GET" && pathname === "/api/status") {
        json(response, 200, await this.manager.status()); return
      }
      if (request.method === "GET" && pathname === "/api/credentials") {
        const status = await this.manager.status()
        json(response, 200, { backendToken: this.manager.backendToken(), share: status.share, backendUrl: status.backendUrl }); return
      }
      if (request.method === "GET" && pathname === "/api/config") {
        json(response, 200, this.manager.publicBackendSettings()); return
      }
      if (request.method === "POST" && pathname === "/api/config") {
        const body = await readJsonBody(request)
        this.manager.updateBackendSettings({
          serverUrl: stringField(body, "serverUrl"),
          host: stringField(body, "host"),
          port: stringField(body, "port"),
          publicBaseUrl: stringField(body, "publicBaseUrl"),
          tunnelUrl: stringField(body, "tunnelUrl"),
          tunnelKey: stringField(body, "tunnelKey"),
          tunnelId: stringField(body, "tunnelId"),
          driver: stringField(body, "driver") as "omp" | "mock" | undefined,
        })
        json(response, 200, { ok: true, config: this.manager.publicBackendSettings() }); return
      }
      if (request.method === "POST" && pathname === "/api/service/start") {
        await this.manager.start(); json(response, 200, { ok: true }); return
      }
      if (request.method === "POST" && pathname === "/api/service/stop") {
        await this.manager.stop(); json(response, 200, { ok: true }); return
      }
      if (request.method === "POST" && pathname === "/api/service/restart") {
        await this.manager.restart(); json(response, 200, { ok: true }); return
      }
      json(response, 404, { error: "not found" })
    } catch (error) {
      json(response, 500, { error: error instanceof Error ? error.message : String(error) })
    }
  }
}
