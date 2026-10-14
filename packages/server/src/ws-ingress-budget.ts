import { RateBudget } from "./rate-budget.ts";

export class WebSocketIngressBudget {
  private readonly frames = new RateBudget(240, 120);
  private readonly bytes = new RateBudget(4 * 1024 * 1024, 1024 * 1024);

  constructor(
    private readonly sharedFrames: RateBudget,
    private readonly sharedBytes: RateBudget,
  ) {}

  /** 解码 JSON 前对原始应用帧及 RFC 控制帧均调用此方法。 */
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
