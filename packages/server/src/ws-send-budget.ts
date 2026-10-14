export type SendAdmission = "accepted" | "connection_full" | "global_full";

export interface BufferedSocket {
  readonly bufferedAmount: number;
}

interface Reservation {
  queued: number;
  sending: number;
  reclaim: () => void;
}

/** 应用消息的排队和发送共用一份预留，直到交付或关闭。 */
export class WebSocketSendBudget<Socket extends BufferedSocket> {
  private readonly sockets = new Map<Socket, Reservation>();
  private readonly waiters = new Set<() => void>();

  constructor(
    readonly connectionLimit = 8 * 1024 * 1024,
    readonly totalLimit = 64 * 1024 * 1024,
  ) {}

  register(socket: Socket, reclaim: () => void): void {
    this.sockets.set(socket, { queued: 0, sending: 0, reclaim });
  }

  usage(socket: Socket): number {
    const entry = this.sockets.get(socket);
    return entry
      ? entry.queued + Math.max(entry.sending, socket.bufferedAmount)
      : 0;
  }

  get total(): number {
    let bytes = 0;
    for (const socket of this.sockets.keys()) bytes += this.usage(socket);
    return bytes;
  }

  reserve(socket: Socket, bytes: number): SendAdmission {
    const entry = this.sockets.get(socket);
    if (!entry || bytes + this.usage(socket) > this.connectionLimit)
      return "connection_full";
    if (bytes + this.total > this.totalLimit) return "global_full";
    entry.queued += bytes;
    return "accepted";
  }

  /** ws.send 开始时转移预留，而不是释放额度。 */
  sending(socket: Socket, bytes: number): void {
    const entry = this.sockets.get(socket);
    if (!entry) return;
    entry.queued -= bytes;
    entry.sending += bytes;
  }

  release(socket: Socket, bytes: number, sent = false): void {
    const entry = this.sockets.get(socket);
    if (!entry) return;
    if (sent) entry.sending = Math.max(0, entry.sending - bytes);
    else entry.queued = Math.max(0, entry.queued - bytes);
    this.wake();
  }

  discardQueued(socket: Socket): void {
    const entry = this.sockets.get(socket);
    if (!entry) return;
    entry.queued = 0;
    this.wake();
  }

  remove(socket: Socket): void {
    this.sockets.delete(socket);
    this.wake();
  }

  /**
   * 仅回收较大的应用积压，不能回收健康的请求者或尚未经过
   * 一轮事件循环的交付回调。reserve() 准入更多字节前，
   * 回收必须实际释放排队数据；socket 持有的字节直到回调或关闭才退款。
   */
  reclaimFor(socket: Socket, bytes: number): void {
    const tried = new Set<Socket>();
    while (this.total + bytes > this.totalLimit) {
      let victim: Socket | undefined;
      let largest = this.usage(socket) + bytes;
      for (const [candidate, entry] of this.sockets) {
        if (candidate === socket || tried.has(candidate) || entry.queued === 0)
          continue;
        const usage = this.usage(candidate);
        if (usage > largest) {
          largest = usage;
          victim = candidate;
        }
      }
      if (!victim) return;
      tried.add(victim);
      this.sockets.get(victim)!.reclaim();
    }
  }

  whenAvailable(callback: () => void): () => void {
    this.waiters.add(callback);
    return () => this.waiters.delete(callback);
  }

  private wake(): void {
    for (const callback of this.waiters) callback();
  }
}
