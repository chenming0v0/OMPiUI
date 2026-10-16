// 上限按 UTF-8 载荷字节计，不含队列项开销。真实 RPC 行是 100B~2KB 的 JSON 帧，
// 项开销最多几倍；禁止用"1 字节行"推算放大后上报。
const MAX_LINE_BYTES = 1024 * 1024;
const MAX_BUFFER_BYTES = 8 * 1024 * 1024;

/** 完整行排队、未完成行单独累积，不反复切片整个积压缓冲。 */
export class RpcLineReader {
  private lines: Array<{ text: string; bytes: number }> = [];
  private head = 0;
  private bytes = 0;
  private tail = "";
  private tailBytes = 0;
  private scheduled?: NodeJS.Immediate;
  private closed = false;
  private paused = false;
  private finished?: () => void;
  private droppingLine = false;

  constructor(
    private readonly consume: (line: string) => void,
    private readonly pause: () => void,
    private readonly resume: () => void,
    private readonly batchSize = 64,
    private readonly onError: (message: string) => void = () => {},
  ) {}

  push(chunk: string): void {
    if (this.closed) return;
    const parts = chunk.split("\n");
    for (let index = 0; index < parts.length; index++) {
      const complete = index < parts.length - 1;
      if (!this.droppingLine) {
        const part = parts[index]!;
        this.tailBytes += Buffer.byteLength(part);
        if (this.tailBytes > MAX_LINE_BYTES) {
          this.tail = "";
          this.tailBytes = 0;
          this.droppingLine = true;
          this.onError("rpc stdout line exceeds 1 MiB");
        } else this.tail += part;
      }
      if (!complete) continue;
      if (!this.droppingLine && this.tail) {
        this.lines.push({ text: this.tail, bytes: this.tailBytes });
        this.bytes += this.tailBytes;
      }
      this.tail = "";
      this.tailBytes = 0;
      this.droppingLine = false;
    }
    // 暂停上游而不丢完整响应，避免人为制造命令超时。
    if (this.bytes >= MAX_BUFFER_BYTES) this.pause();
    if (!this.paused && !this.scheduled) this.drain();
  }

  setPaused(paused: boolean): void {
    this.paused = paused;
    if (paused) this.pause();
    else if (!this.scheduled && !this.closed) this.drain();
  }

  finish(callback: () => void): void {
    this.finished = callback;
    if (!this.scheduled && !this.paused) this.drain();
  }

  private drain(): void {
    this.scheduled = undefined;
    const started = performance.now();
    let count = 0;
    while (!this.closed && !this.paused && this.head < this.lines.length) {
      this.deliver();
      if (++count >= this.batchSize || performance.now() - started >= 4) break;
    }
    if (this.head) {
      this.lines = this.lines.slice(this.head);
      this.head = 0;
    }
    if (this.closed || this.paused) return;
    if (this.lines.length) {
      this.pause();
      this.scheduled = setImmediate(() => this.drain());
    } else {
      this.resume();
      const finished = this.finished;
      this.finished = undefined;
      finished?.();
    }
  }

  private deliver(): void {
    const line = this.lines[this.head++]!;
    this.bytes -= line.bytes;
    const text = line.text.trim();
    if (text) this.consume(text);
  }

  /**
   * 子进程已退出:不再等待 IPC 背压释放。只交付退出前已读入缓冲的完整行
   * (有界,不会等待更多输出),丢弃不完整的尾行。
   */
  flushForExit(): void {
    if (this.closed) return;
    clearImmediate(this.scheduled);
    this.scheduled = undefined;
    this.paused = false;
    this.finished = undefined;
    while (this.head < this.lines.length) this.deliver();
    this.lines = [];
    this.head = 0;
    this.tail = "";
    this.tailBytes = 0;
  }

  close(): void {
    this.closed = true;
    if (this.scheduled) clearImmediate(this.scheduled);
    this.scheduled = undefined;
    this.lines = [];
    this.head = 0;
    this.bytes = 0;
    this.tail = "";
    this.tailBytes = 0;
    this.finished = undefined;
  }
}
