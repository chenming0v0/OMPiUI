import { randomBytes, randomUUID } from "node:crypto"
import { connect, type Socket } from "node:net"
import { join } from "node:path"
import { mkdirSync } from "node:fs"
import {
  isJsonObject, jsonByteSize, TOOL_INTERACTION_MAX_FRAME_BYTES,
  TOOL_INTERACTION_PROTOCOL_VERSION, type JsonObject, type JsonValue,
} from "@ompiui/protocol"

const MAX_PENDING = 64
const MAX_PENDING_BYTES = 1024 * 1024

/** Private transport to the PTY owner inside the selected official runtime. */
export class ToolInteractionChannel {
  readonly runtimeId = randomUUID()
  private readonly token = randomBytes(32).toString("hex")
  readonly endpoint: string
  private socket?: Socket
  private connecting?: Promise<void>
  private authenticated = false
  private closed = false
  private buffer = ""
  private pendingBytes = 0
  private readonly pending = new Map<string, {
    resolve: (data: JsonValue) => void
    reject: (error: Error) => void
    timer: NodeJS.Timeout
    bytes: number
  }>()

  constructor() {
    const name = `tool-${this.runtimeId}`
    if (process.platform === "win32") this.endpoint = `\\\\.\\pipe\\ompiui-${name}`
    else {
      // macOS/Linux socket paths have a small sun_path limit; keep the private endpoint short.
      const socketDirectory = join("/tmp", `ompiui-${process.getuid?.() ?? "user"}`)
      mkdirSync(socketDirectory, { recursive: true, mode: 0o700 })
      this.endpoint = join(socketDirectory, `${name}.sock`)
    }
  }

  environment(): Record<string, string> {
    return {
      OMPIUI_TOOL_INTERACTION_ENDPOINT: this.endpoint,
      OMPIUI_TOOL_INTERACTION_TOKEN: this.token,
      OMPIUI_TOOL_INTERACTION_RUNTIME_ID: this.runtimeId,
    }
  }

  private async ensureConnected(): Promise<void> {
    if (this.closed) throw Object.assign(new Error("Tool interaction runtime is closed"), { code: "RUNTIME_CLOSING" })
    if (this.authenticated && this.socket && !this.socket.destroyed) return
    if (this.connecting) return this.connecting
    this.connecting = (async () => {
      const socket = connect(this.endpoint)
      this.socket = socket
      this.buffer = ""
      socket.setEncoding("utf8")
      socket.on("data", chunk => this.receive(String(chunk)))
      socket.on("error", error => this.disconnect(socket, error))
      socket.on("close", () => this.disconnect(socket, new Error("Tool interaction connection closed; delivery may be unknown")))
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          socket.destroy()
          reject(Object.assign(new Error("Tool interaction connection timed out"), { code: "CAPABILITY_DISABLED" }))
        }, 3000)
        timer.unref()
        socket.once("connect", () => { clearTimeout(timer); resolve() })
        socket.once("error", error => { clearTimeout(timer); reject(error) })
      })
      const hello = await this.send({ operation: "hello", token: this.token, protocolVersion: TOOL_INTERACTION_PROTOCOL_VERSION }, 5000)
      if (!isJsonObject(hello) || hello.protocolVersion !== TOOL_INTERACTION_PROTOCOL_VERSION || hello.runtimeId !== this.runtimeId) {
        socket.destroy()
        throw Object.assign(new Error("Tool interaction protocol mismatch"), { code: "CAPABILITY_DISABLED" })
      }
      this.authenticated = true
    })().finally(() => { this.connecting = undefined })
    return this.connecting
  }

  async request(params: JsonObject, timeoutMs = 5000): Promise<JsonValue> {
    await this.ensureConnected()
    return this.send(params, timeoutMs)
  }

  private send(params: JsonObject, timeoutMs: number): Promise<JsonValue> {
    const socket = this.socket
    if (!socket || socket.destroyed) return Promise.reject(Object.assign(new Error("Tool interaction transport unavailable"), { code: "CAPABILITY_DISABLED" }))
    const id = randomUUID()
    const frame = { ...params, id }
    const bytes = jsonByteSize(frame, TOOL_INTERACTION_MAX_FRAME_BYTES)
    if (bytes >= TOOL_INTERACTION_MAX_FRAME_BYTES) return Promise.reject(Object.assign(new Error("Tool interaction frame is too large"), { code: "INVALID_REQUEST" }))
    if (this.pending.size >= MAX_PENDING || this.pendingBytes + bytes > MAX_PENDING_BYTES || socket.writableLength > MAX_PENDING_BYTES) {
      return Promise.reject(Object.assign(new Error("Tool interaction transport is busy; request was not sent"), { code: "RESOURCE_EXHAUSTED" }))
    }
    return new Promise<JsonValue>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.settle(id, Object.assign(new Error("Tool interaction acknowledgement timed out; delivery is unknown"), { code: "TOOL_INPUT_UNKNOWN" }))
      }, timeoutMs)
      timer.unref()
      this.pendingBytes += bytes
      this.pending.set(id, { resolve, reject, timer, bytes })
      socket.write(`${JSON.stringify(frame)}\n`, error => {
        if (error) this.settle(id, Object.assign(new Error("Tool interaction delivery failed; result is unknown"), { code: "TOOL_INPUT_UNKNOWN" }))
      })
    })
  }

  private receive(chunk: string): void {
    this.buffer += chunk
    while (true) {
      const newline = this.buffer.indexOf("\n")
      if (newline < 0) break
      const line = this.buffer.slice(0, newline)
      this.buffer = this.buffer.slice(newline + 1)
      if (Buffer.byteLength(line, "utf8") > TOOL_INTERACTION_MAX_FRAME_BYTES) {
        this.socket?.destroy(new Error("Tool interaction response frame is too large"))
        return
      }
      let frame: unknown
      try { frame = JSON.parse(line) } catch { this.socket?.destroy(new Error("Invalid tool interaction response")); return }
      if (!isJsonObject(frame) || typeof frame.id !== "string") continue
      if (frame.ok === true) this.settle(frame.id, undefined, frame.data ?? null)
      else this.settle(frame.id, Object.assign(new Error(isJsonObject(frame.error) && typeof frame.error.message === "string" ? frame.error.message : "Tool interaction failed"), {
        code: isJsonObject(frame.error) && typeof frame.error.code === "string" ? frame.error.code : "TOOL_INTERACTION_FAILED",
      }))
    }
    if (Buffer.byteLength(this.buffer, "utf8") > TOOL_INTERACTION_MAX_FRAME_BYTES) this.socket?.destroy(new Error("Tool interaction response frame is too large"))
  }

  private settle(id: string, error?: Error, data?: JsonValue): void {
    const pending = this.pending.get(id)
    if (!pending) return
    this.pending.delete(id)
    this.pendingBytes -= pending.bytes
    clearTimeout(pending.timer)
    if (error) pending.reject(error)
    else pending.resolve(data ?? null)
  }

  private disconnect(socket: Socket, error: Error): void {
    if (this.socket !== socket) return
    this.authenticated = false
    this.socket = undefined
    for (const id of this.pending.keys()) this.settle(id, Object.assign(new Error(error.message), { code: "TOOL_INPUT_UNKNOWN" }))
  }

  close(): void {
    this.closed = true
    this.authenticated = false
    this.socket?.destroy()
    this.socket = undefined
    for (const id of this.pending.keys()) this.settle(id, Object.assign(new Error("Tool interaction runtime closed"), { code: "RUNTIME_CLOSING" }))
  }
}
