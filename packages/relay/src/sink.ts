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
  private paused = new Set<BodySource>();
  private timer: NodeJS.Timeout | null = null;
  private flushTimer?: NodeJS.Timeout;
  private pending = new Map<
    number,
    { chunks: Buffer[]; bytes: number; sources: Set<BodySource> }
  >();
  private finishers = new Map<number, () => void>();

  constructor(
    private readonly ws: WebSocket,
    private readonly meter?: (bytes: number, frames: number) => boolean | number,
  ) {}

  write(connId: number, chunk: Buffer, source: BodySource | null): void {
    if (this.ws.readyState !== WebSocket.OPEN) return;
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
    for (const [id, pending] of this.pending) {
      if (connId !== undefined && id !== connId) continue;
      if (this.ws.readyState !== WebSocket.OPEN) {
        this.pending.delete(id);
        continue;
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
      const finish = this.finishers.get(id);
      this.finishers.delete(id);
      finish?.();
    }
  }

  finish(connId: number, callback: () => void): void {
    if (!this.pending.has(connId)) {
      callback();
      return;
    }
    this.finishers.set(connId, callback);
    this.flush(connId);
  }

  dispose(): void {
    clearTimeout(this.flushTimer);
    this.flushTimer = undefined;
    this.pending.clear();
    this.finishers.clear();
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    for (const source of this.paused) {
      try {
        source.resume();
      } catch {
        // 源流可能已销毁
      }
    }
    this.paused.clear();
  }

  private ensureTimer(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      if (this.ws.readyState !== WebSocket.OPEN) {
        this.dispose();
        return;
      }
      if (
        this.pending.size === 0 &&
        this.ws.bufferedAmount <= BACKPRESSURE_LOW_WATER
      ) {
        for (const source of this.paused) source.resume();
        this.paused.clear();
        if (this.timer) clearInterval(this.timer);
        this.timer = null;
      }
    }, 10);
    this.timer.unref?.();
  }
}
