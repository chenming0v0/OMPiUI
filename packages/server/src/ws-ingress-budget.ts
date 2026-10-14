import { RateBudget } from "./rate-budget.ts";

export class WebSocketIngressBudget {
  private readonly frames = new RateBudget(240, 120);
  private readonly bytes = new RateBudget(4 * 1024 * 1024, 1024 * 1024);

  constructor(
    private readonly sharedFrames: RateBudget,
    private readonly sharedBytes: RateBudget,
  ) {}

  /** Call on raw application AND RFC control frames, before decoding JSON. */
  allow(bytes: number): boolean {
    if (
      this.frames.retryAfterMs(1) !== 0 ||
      this.bytes.retryAfterMs(bytes) !== 0 ||
      this.sharedFrames.retryAfterMs(1) !== 0 ||
      this.sharedBytes.retryAfterMs(bytes) !== 0
    ) return false;
    this.frames.allow(1);
    this.bytes.allow(bytes);
    this.sharedFrames.allow(1);
    this.sharedBytes.allow(bytes);
    return true;
  }
}
