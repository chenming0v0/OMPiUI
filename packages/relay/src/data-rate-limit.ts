/** 数据面同时按帧数和字节计费，独立于新建请求的配额。 */
export class DataRateLimit {
  private bytes: number;
  private frames: number;
  private last: number;

  constructor(
    private readonly bytesPerSecond = 16 * 1024 * 1024,
    private readonly byteBurst = 32 * 1024 * 1024,
    private readonly framesPerSecond = 2000,
    private readonly frameBurst = 4000,
    private readonly now = Date.now,
  ) {
    this.bytes = byteBurst;
    this.frames = frameBurst;
    this.last = now();
  }

  allow(bytes: number, frames = 1): boolean {
    this.refill();
    if (this.bytes < bytes || this.frames < frames) return false;
    this.bytes -= bytes;
    this.frames -= frames;
    return true;
  }

  canAllow(bytes: number, frames = 1): boolean {
    this.refill();
    return this.bytes >= bytes && this.frames >= frames;
  }

  private refill(): void {
    const now = this.now();
    const seconds = Math.max(0, now - this.last) / 1000;
    this.last = now;
    this.bytes = Math.min(
      this.byteBurst,
      this.bytes + seconds * this.bytesPerSecond,
    );
    this.frames = Math.min(
      this.frameBurst,
      this.frames + seconds * this.framesPerSecond,
    );
  }
}
