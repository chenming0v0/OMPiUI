import { redact } from "./logs.ts";
import type { ConsoleAdapter, ConsoleData } from "./types.ts";

export interface ConsoleState {
  data: ConsoleData | null;
  busy: string | null;
  notice: string | null;
  error: string | null;
}

export class ConsoleController {
  private state: ConsoleState = {
    data: null,
    busy: null,
    notice: null,
    error: null,
  };
  private listeners = new Set<() => void>();
  private reading: Promise<void> | undefined;
  private closing: Promise<void> | undefined;
  private operation: Promise<boolean> | undefined;
  private timer: NodeJS.Timeout | undefined;
  private disposed = false;
  private failures = 0;

  constructor(private readonly adapter: ConsoleAdapter) {}

  getSnapshot = (): ConsoleState => this.state;
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  private update(patch: Partial<ConsoleState>): void {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener();
  }

  async start(): Promise<void> {
    await this.refresh();
    this.scheduleRefresh();
  }

  private scheduleRefresh(): void {
    clearTimeout(this.timer);
    if (this.disposed) return;
    this.timer = setTimeout(() => {
      if (this.state.busy) { this.scheduleRefresh(); return }
      void this.refresh().finally(() => this.scheduleRefresh());
    }, Math.min(60_000, 10_000 * 2 ** Math.min(this.failures, 3)));
    this.timer.unref();
  }

  refresh(): Promise<void> {
    if (this.disposed) return Promise.resolve();
    if (this.reading) return this.reading;
    this.reading = this.adapter
      .read()
      .then((data) => {
        this.failures = data.tone === "danger" ? this.failures + 1 : 0;
        if (!this.disposed) this.update({ data, error: null });
      })
      .catch((error) => {
        this.failures++;
        if (!this.disposed)
          this.update({
            error: redact(
              error instanceof Error ? error.message : String(error),
            ),
          });
      })
      .finally(() => {
        this.reading = undefined;
      });
    return this.reading;
  }

  run(
    id: string,
    label: string,
    values: Record<string, string> = {},
    target?: string,
  ): Promise<boolean> {
    if (this.state.busy || this.disposed) return Promise.resolve(false);
    this.update({ busy: label, error: null, notice: null });
    const operation = this.execute(id, values, target);
    this.operation = operation;
    return operation;
  }

  private async execute(
    id: string,
    values: Record<string, string>,
    target?: string,
  ): Promise<boolean> {
    try {
      await this.reading;
      if (this.disposed) return false;
      const notice = await this.adapter.execute(id, values, target);
      this.update({ notice });
      await this.refresh();
      return true;
    } catch (error) {
      // 表单输入中的密钥也参与脱敏，错误消息不能泄露刚提交的凭证。
      this.update({
        error: redact(
          error instanceof Error ? error.message : String(error),
          Object.entries(values)
            .filter(([key]) => /key|token/i.test(key))
            .map(([, value]) => value),
        ),
      });
      return false;
    } finally {
      this.update({ busy: null });
    }
  }

  clearMessage(): void {
    this.update({ notice: null, error: null });
  }

  shutdown(): Promise<void> {
    if (this.closing) return this.closing;
    this.disposed = true;
    clearTimeout(this.timer);
    // 先等当前操作收尾，再清理它可能启动的进程；等待刷新的操作不再执行。
    this.closing = (async () => {
      await this.operation;
      await this.adapter.dispose();
    })();
    return this.closing;
  }
}
