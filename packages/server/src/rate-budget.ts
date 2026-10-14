/** 允许短时突发，按经过时间补充预算，不保留定时器。 */
export class RateBudget {
  private available: number;
  private updated = Date.now();

  constructor(private readonly burst: number, private readonly perSecond: number) {
    this.available = burst;
  }

  allow(amount: number): boolean {
    if (this.retryAfterMs(amount) !== 0) return false;
    this.available -= amount;
    return true;
  }

  /** Inspect all participating buckets before consuming any of them. */
  retryAfterMs(amount: number): number {
    const now = Date.now();
    this.available = Math.min(
      this.burst,
      this.available + Math.max(0, now - this.updated) * this.perSecond / 1000,
    );
    this.updated = Math.max(this.updated, now);
    if (amount > this.burst) return Infinity;
    if (amount <= this.available) return 0;
    return Math.ceil((amount - this.available) * 1000 / this.perSecond);
  }
}
