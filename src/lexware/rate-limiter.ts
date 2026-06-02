/**
 * A concurrency-safe token-bucket rate limiter.
 *
 * Lexware enforces ~2 requests/second per client (token bucket); exceeding it
 * returns HTTP 429. We mirror that client-side so we space requests out instead
 * of getting throttled. `now`/`sleep` are injectable for deterministic tests.
 */
export class RateLimiter {
  private tokens: number;
  private lastRefill: number;
  /** Serializes `reserve()` so concurrent callers don't both consume the same token. */
  private chain: Promise<void> = Promise.resolve();

  constructor(
    private readonly capacity: number,
    private readonly refillPerSec: number,
    private readonly now: () => number = () => Date.now(),
    private readonly sleep: (ms: number) => Promise<void> = (ms) =>
      new Promise((r) => setTimeout(r, ms)),
  ) {
    if (capacity < 1 || refillPerSec <= 0) {
      throw new Error(
        `RateLimiter requires capacity >= 1 and refillPerSec > 0 (got ${capacity}, ${refillPerSec}).`,
      );
    }
    this.tokens = capacity;
    this.lastRefill = now();
  }

  private refill(): void {
    const t = this.now();
    const elapsedSec = (t - this.lastRefill) / 1000;
    if (elapsedSec > 0) {
      this.tokens = Math.min(this.capacity, this.tokens + elapsedSec * this.refillPerSec);
      this.lastRefill = t;
    }
  }

  /** Resolve once a token is available, blocking (via `sleep`) if necessary. */
  async acquire(): Promise<void> {
    const run = this.chain.then(() => this.reserve());
    // Keep the chain alive even if a reservation rejects (it never should).
    this.chain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async reserve(): Promise<void> {
    this.refill();
    while (this.tokens < 1) {
      const needed = 1 - this.tokens;
      const waitMs = Math.max(1, Math.ceil((needed / this.refillPerSec) * 1000));
      await this.sleep(waitMs);
      this.refill();
    }
    this.tokens -= 1;
  }
}
