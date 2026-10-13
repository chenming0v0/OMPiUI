type Waiter = {
  resolve: () => void;
  reject: (error: Error) => void;
  signal?: AbortSignal;
  abort: () => void;
};

export function requestAborted(): Error {
  return Object.assign(new Error("request cancelled"), { code: "REQUEST_ABORTED" });
}

/** 等待者取消只退出自己的队列位置，执行中的查询仍由其 signal 控制。 */
export class QueryPool {
  private active = 0;
  private readonly waiters: Waiter[] = [];

  constructor(private readonly limit: number, private readonly queueLimit = 128) {}

  async run<T>(signal: AbortSignal | undefined, operation: () => Promise<T>): Promise<T> {
    if (signal?.aborted) throw requestAborted();
    if (this.active >= this.limit) {
      if (this.waiters.length >= this.queueLimit) {
        throw Object.assign(new Error("query capacity reached"), { code: "RATE_LIMITED" });
      }
      await new Promise<void>((resolve, reject) => {
        const waiter: Waiter = {
          resolve,
          reject,
          signal,
          abort: () => {
            const index = this.waiters.indexOf(waiter);
            if (index >= 0) this.waiters.splice(index, 1);
            reject(requestAborted());
          },
        };
        this.waiters.push(waiter);
        signal?.addEventListener("abort", waiter.abort, { once: true });
        if (signal?.aborted) waiter.abort();
      });
    } else {
      this.active++;
    }
    try {
      if (signal?.aborted) throw requestAborted();
      return await operation();
    } finally {
      const waiter = this.waiters.shift();
      if (waiter) {
        waiter.signal?.removeEventListener("abort", waiter.abort);
        waiter.resolve();
      } else {
        this.active--;
      }
    }
  }
}

export async function mapConcurrent<T, R>(
  items: readonly T[],
  limit: number,
  operation: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  let next = 0;
  const results = new Array<R>(items.length);
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await operation(items[index]!, index);
    }
  }));
  return results;
}
