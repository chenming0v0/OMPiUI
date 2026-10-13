/** 允许短时突发，按经过时间补充预算，不保留定时器。 */
export class RateBudget {
  private available: number;
  private updated = Date.now();

  constructor(private readonly burst: number, private readonly perSecond: number) {
    this.available = burst;
  }

  allow(bytes: number): boolean {
    const now = Date.now();
    this.available = Math.min(this.burst, this.available + Math.max(0, now - this.updated) * this.perSecond / 1000);
    this.updated = now;
    if (bytes > this.available) return false;
    this.available -= bytes;
    return true;
  }
}
