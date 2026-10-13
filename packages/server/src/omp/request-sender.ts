import type { ChildProcess } from "node:child_process";

type Item = { message: unknown; bytes: number; active: () => boolean; done: (error: Error | null) => void };

/** 按 IPC 写回调串行交付，避免 child.send(false) 后继续堆积正文。 */
export class RequestSender {
  private readonly queue: Item[] = [];
  private bytes = 0;
  private sending = false;
  constructor(private readonly child: ChildProcess, private readonly maxBytes = 32 * 1024 * 1024) {}
  send(item: Item): void {
    if (this.bytes + item.bytes > this.maxBytes) {
      item.done(Object.assign(new Error("worker IPC capacity reached"), { code: "RATE_LIMITED" }));
      return;
    }
    this.bytes += item.bytes;
    this.queue.push(item);
    this.flush();
  }
  private flush(): void {
    if (this.sending) return;
    const item = this.queue.shift();
    if (!item) return;
    if (!item.active()) {
      this.bytes -= item.bytes;
      this.flush();
      return;
    }
    this.sending = true;
    const done = (error: Error | null) => {
      this.bytes -= item.bytes;
      this.sending = false;
      item.done(error);
      this.flush();
    };
    try { this.child.send(item.message as object, done) }
    catch (error) { done(error as Error) }
  }
}
