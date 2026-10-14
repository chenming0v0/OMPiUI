import type { ChildProcess } from "node:child_process";

export interface RequestSendResult {
  /** attempted 只表示调用过 child.send，出错也不能证明 worker 未执行。 */
  state: "unsent" | "attempted";
  error: Error | null;
}

export interface RequestSendHandle {
  readonly attempted: boolean;
  /** 仅撤销仍在本地队列中的请求；已交给 IPC 的正文不能安全撤回。 */
  cancel(): boolean;
}

type Item = {
  message: unknown;
  bytes: number;
  active: () => boolean;
  done: (result: RequestSendResult) => void;
};
type Entry = Item & { attempted: boolean; settled: boolean };
const UNSENT: RequestSendHandle = { attempted: false, cancel: () => false };

/** 按 IPC 写回调串行交付；每项（包括未发送取消）恰好结算一次。 */
export class RequestSender {
  private readonly queue = new Set<Entry>();
  private bytes = 0;
  private current?: Entry;
  private flushing = false;
  private closedError?: Error;

  constructor(private readonly child: ChildProcess, private readonly maxBytes = 32 * 1024 * 1024) {}

  send(item: Item): RequestSendHandle {
    if (this.closedError || !item.active()) {
      item.done({ state: "unsent", error: this.closedError ?? null });
      return UNSENT;
    }
    if (this.bytes + item.bytes > this.maxBytes) {
      item.done({
        state: "unsent",
        error: Object.assign(new Error("worker IPC capacity reached"), { code: "RATE_LIMITED" }),
      });
      return UNSENT;
    }
    const entry: Entry = { ...item, attempted: false, settled: false };
    this.bytes += entry.bytes;
    this.queue.add(entry);
    const handle: RequestSendHandle = {
      get attempted() { return entry.attempted; },
      cancel: () => {
        if (!this.queue.has(entry)) return false;
        this.finish(entry, "unsent", null);
        this.flush();
        return true;
      },
    };
    this.flush();
    return handle;
  }

  /** 只在进程退出后调用；不把 IPC 回调错误冒充为进程已安全停止。 */
  close(error: Error): void {
    if (this.closedError) return;
    this.closedError = error;
    if (this.current) this.finish(this.current, "attempted", error);
    for (const entry of this.queue) this.finish(entry, "unsent", error);
  }

  private finish(entry: Entry, state: RequestSendResult["state"], error: Error | null): void {
    if (entry.settled) return;
    entry.settled = true;
    this.queue.delete(entry);
    if (this.current === entry) this.current = undefined;
    this.bytes -= entry.bytes;
    entry.message = undefined;
    entry.done({ state, error });
  }

  private flush(): void {
    if (this.flushing || this.current || this.closedError) return;
    this.flushing = true;
    try {
      while (!this.current && !this.closedError) {
        const entry = this.queue.values().next().value;
        if (!entry) return;
        if (!entry.active()) {
          this.finish(entry, "unsent", null);
          continue;
        }
        if (this.child.connected === false) {
          this.finish(entry, "unsent", Object.assign(new Error("worker IPC channel disconnected"), { code: "ERR_IPC_CHANNEL_CLOSED" }));
          continue;
        }
        this.queue.delete(entry);
        entry.attempted = true;
        this.current = entry;
        const done = (error: Error | null) => {
          if (entry.settled) return;
          this.finish(entry, "attempted", error);
          this.flush();
        };
        try { this.child.send(entry.message as object, done); }
        catch (error) { done(error instanceof Error ? error : new Error(String(error))); }
      }
    } finally {
      this.flushing = false;
    }
  }
}
