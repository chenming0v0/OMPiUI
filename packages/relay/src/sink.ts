/**
 * 隧道出方向写流（带背压）：把 body 切成 ≤64KiB 的二进制帧写进控制
 * WebSocket；对端 bufferedAmount 越过高水位就暂停源流，轮询回落后恢复。
 *
 * 中转（公网请求体 → 桌面端）与桌面端（响应体 → 中转）两个方向共用。
 */

import { WebSocket } from "ws"
import { BACKPRESSURE_HIGH_WATER, BACKPRESSURE_LOW_WATER, encodeFrameMessages } from "./protocol.ts"

export type BodySource = { pause(): void; resume(): void }

export class BodySink {
  private paused = new Set<BodySource>()
  private timer: NodeJS.Timeout | null = null

  constructor(private readonly ws: WebSocket) {}

  write(connId: number, chunk: Buffer, source: BodySource | null): void {
    if (this.ws.readyState !== WebSocket.OPEN) return
    for (const message of encodeFrameMessages(connId, chunk)) {
      this.ws.send(message, { binary: true })
    }
    if (!source) return
    if (this.ws.bufferedAmount > BACKPRESSURE_HIGH_WATER && !this.paused.has(source)) {
      this.paused.add(source)
      source.pause()
      this.ensureTimer()
    }
  }

  dispose(): void {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
    for (const source of this.paused) {
      try {
        source.resume()
      } catch {
        // 源流可能已销毁
      }
    }
    this.paused.clear()
  }

  private ensureTimer(): void {
    if (this.timer) return
    this.timer = setInterval(() => {
      if (this.paused.size === 0 || this.ws.readyState !== WebSocket.OPEN) {
        this.dispose()
        return
      }
      if (this.ws.bufferedAmount <= BACKPRESSURE_LOW_WATER) {
        for (const source of this.paused) source.resume()
        this.paused.clear()
        this.dispose()
      }
    }, 10)
    this.timer.unref?.()
  }
}
