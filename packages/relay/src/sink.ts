/**
 * 隧道出方向写流（带背压）：把 body 切成 ≤64KiB 的二进制帧写进控制
 * WebSocket；对端 bufferedAmount 越过高水位就暂停源流，轮询回落后恢复。
 *
 * 中转（公网请求体 → 桌面端）与桌面端（响应体 → 中转）两个方向共用。
 */

import { WebSocket } from "ws";
import {
  BACKPRESSURE_HIGH_WATER,
  BACKPRESSURE_LOW_WATER,
  FRAME_PAYLOAD_MAX,
  encodeFrameMessages,
} from "./protocol.ts";

export type BodySource = { pause(): void; resume(): void };

export class BodySink {
  get hasPendingData(): boolean { return this.pending.size > 0 }
  private paused = new Set<BodySource>();
  private timer?: NodeJS.Timeout;
  private flushTimer?: NodeJS.Timeout;
  private pending = new Map<
    number,
    { chunks: Buffer[]; bytes: number; sources: Set<BodySource> }
  >();
  private finishers = new Map<number, () => void>();
  private held = false;
  private disposed = false;

  constructor(
    private readonly ws: WebSocket,
    private readonly meter?: (bytes: number, frames: number) => boolean | number,
  ) {}

  /** 在连接的 open 帧发送前阻止来源和 upgrade 首部发送。 */
  hold(source: BodySource): void {
    if (this.disposed) return;
    this.held = true;
    if (!this.paused.has(source)) {
      this.paused.add(source);
      source.pause();
    }
  }

  /** open 进入此 WebSocket 的有序发送队列后调用。 */
  release(): void {
    if (this.disposed || !this.held) return;
    this.held = false;
    this.flush();
    this.resumeSources();
    if (this.paused.size > 0) this.ensureTimer();
  }

  write(connId: number, chunk: Buffer, source: BodySource | null): void {
    if (this.disposed || this.ws.readyState !== WebSocket.OPEN) return;
    if (chunk.length === 0) return;
    const pending = this.pending.get(connId) ?? {
      chunks: [],
      bytes: 0,
      sources: new Set<BodySource>(),
    };
    pending.chunks.push(chunk);
    pending.bytes += chunk.length;
    if (source) pending.sources.add(source);
    this.pending.set(connId, pending);
    if (this.held) {
      if (source && !this.paused.has(source)) {
        this.paused.add(source);
        source.pause();
      }
      return;
    }
    if (pending.bytes >= 32 * 1024 || pending.chunks.length >= 256)
      this.flush(connId);
    else
      this.flushTimer ??= setTimeout(() => {
        this.flushTimer = undefined;
        this.flush();
      }, 2);
    if (!source) return;
    if (
      this.ws.bufferedAmount + pending.bytes > BACKPRESSURE_HIGH_WATER &&
      !this.paused.has(source)
    ) {
      this.paused.add(source);
      source.pause();
      this.ensureTimer();
    }
  }

  flush(connId?: number): void {
    if (this.disposed || this.held) return;
    for (const [id, pending] of this.pending) {
      if (connId !== undefined && id !== connId) continue;
      if (this.ws.readyState !== WebSocket.OPEN) {
        this.dispose();
        return;
      }
      const frameCount = Math.ceil(pending.bytes / FRAME_PAYLOAD_MAX);
      const bytes = pending.bytes + frameCount * 18;
      const allowed = this.meter?.(bytes, frameCount) ?? true;
      if (allowed !== true) {
        for (const source of pending.sources) {
          this.paused.add(source);
          source.pause();
        }
        this.ensureTimer();
        this.flushTimer ??= setTimeout(() => {
          this.flushTimer = undefined;
          this.flush();
        }, typeof allowed === "number" ? Math.max(1, allowed) : 50);
        continue;
      }
      const frames = encodeFrameMessages(id, pending.chunks.length === 1
        ? pending.chunks[0]! : Buffer.concat(pending.chunks, pending.bytes));
      this.pending.delete(id);
      for (const frame of frames) this.ws.send(frame, { binary: true });
    }
    for (const [id, finish] of this.finishers) {
      if (connId !== undefined && id !== connId) continue;
      if (this.pending.has(id)) continue;
      this.finishers.delete(id);
      finish();
    }
  }

  finish(connId: number, callback: () => void): void {
    if (this.disposed) return;
    this.finishers.set(connId, callback);
    this.flush(connId);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.held = false;
    clearTimeout(this.flushTimer);
    this.flushTimer = undefined;
    this.pending.clear();
    this.finishers.clear();
    clearInterval(this.timer);
    this.timer = undefined;
    for (const source of this.paused) {
      try {
        source.resume();
      } catch {
        // 源流可能已销毁
      }
    }
    this.paused.clear();
  }

  private resumeSources(): void {
    if (this.disposed || this.held || this.pending.size > 0 ||
      this.ws.bufferedAmount > BACKPRESSURE_LOW_WATER) return;
    clearInterval(this.timer);
    this.timer = undefined;
    if (this.paused.size === 0) return;
    const sources = this.paused;
    this.paused = new Set();
    for (const source of sources) source.resume();
  }

  private ensureTimer(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      if (this.ws.readyState !== WebSocket.OPEN) {
        this.dispose();
        return;
      }
      this.resumeSources();
    }, 10);
    this.timer.unref?.();
  }
}
