import { describe, expect, it } from "vitest";
import { RateLimiter } from "../src/lexware/rate-limiter.js";

/** Build a limiter with a controllable virtual clock; `sleep` advances time. */
function makeLimiter(capacity: number, refillPerSec: number) {
  let t = 0;
  const slept: number[] = [];
  const now = () => t;
  const sleep = async (ms: number) => {
    slept.push(ms);
    t += ms;
  };
  return { rl: new RateLimiter(capacity, refillPerSec, now, sleep), slept, clock: () => t };
}

describe("RateLimiter", () => {
  it("allows an initial burst up to capacity without sleeping", async () => {
    const { rl, slept } = makeLimiter(2, 2);
    await rl.acquire();
    await rl.acquire();
    expect(slept).toEqual([]);
  });

  it("spaces requests beyond capacity by the refill interval", async () => {
    const { rl, slept } = makeLimiter(2, 2);
    await rl.acquire();
    await rl.acquire();
    await rl.acquire(); // must wait ~500ms for one token at 2/sec
    expect(slept.length).toBe(1);
    expect(slept[0]).toBeGreaterThanOrEqual(500);
  });

  it("serializes concurrent acquirers (no double-spend of one token)", async () => {
    const { rl, slept } = makeLimiter(1, 1);
    await Promise.all([rl.acquire(), rl.acquire(), rl.acquire()]);
    // 1 token immediately, then 2 more each waiting ~1s.
    expect(slept.length).toBe(2);
    for (const ms of slept) expect(ms).toBeGreaterThanOrEqual(1000);
  });
});
