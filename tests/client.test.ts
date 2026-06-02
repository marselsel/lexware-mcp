import { describe, expect, it, vi } from "vitest";
import { LexwareClient } from "../src/lexware/client.js";
import { LexwareApiError } from "../src/lexware/errors.js";

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

/** Client with rate limiting effectively disabled and deterministic backoff. */
function makeClient(fetchFn: typeof fetch, slept: number[] = []) {
  return new LexwareClient({
    baseUrl: "https://api.test",
    apiKey: "secret-key",
    fetchFn,
    sleep: async (ms) => {
      slept.push(ms);
    },
    random: () => 0,
    rateLimit: { capacity: 1000, refillPerSec: 1000 },
    maxRetries: 4,
  });
}

describe("LexwareClient", () => {
  it("sends a Bearer token and parses JSON", async () => {
    const fetchFn = vi.fn(async (_url, init) => {
      expect((init?.headers as Record<string, string>).Authorization).toBe("Bearer secret-key");
      return json({ companyName: "Acme" });
    }) as unknown as typeof fetch;
    const client = makeClient(fetchFn);
    const res = await client.get<{ companyName: string }>("/v1/profile");
    expect(res.companyName).toBe("Acme");
  });

  it("retries on 429 and honors Retry-After seconds", async () => {
    const slept: number[] = [];
    let n = 0;
    const fetchFn = vi.fn(async () => {
      n += 1;
      return n === 1 ? json({ error: "slow down" }, 429, { "retry-after": "2" }) : json({ ok: true });
    }) as unknown as typeof fetch;
    const client = makeClient(fetchFn, slept);
    const res = await client.get<{ ok: boolean }>("/v1/voucherlist");
    expect(res.ok).toBe(true);
    expect(n).toBe(2);
    expect(slept).toContain(2000);
  });

  it("clamps a huge Retry-After so a request can't hang", async () => {
    const slept: number[] = [];
    let n = 0;
    const fetchFn = vi.fn(async () => {
      n += 1;
      return n === 1 ? json({}, 429, { "retry-after": "3600" }) : json({ ok: true });
    }) as unknown as typeof fetch;
    const client = makeClient(fetchFn, slept);
    await client.get("/v1/profile");
    expect(Math.max(...slept)).toBeLessThanOrEqual(30_000);
  });

  it("does NOT retry a POST on a network error (no duplicate writes)", async () => {
    const fetchFn = vi.fn(async () => {
      throw new Error("ECONNRESET");
    }) as unknown as typeof fetch;
    const client = makeClient(fetchFn);
    await expect(client.post("/v1/invoices", { a: 1 })).rejects.toMatchObject({
      status: 0,
      message: expect.stringContaining("POST not retried"),
    });
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("retries an idempotent GET on a network error, then succeeds", async () => {
    let n = 0;
    const fetchFn = vi.fn(async () => {
      n += 1;
      if (n === 1) throw new Error("ETIMEDOUT");
      return json({ ok: true });
    }) as unknown as typeof fetch;
    const client = makeClient(fetchFn);
    const res = await client.get<{ ok: boolean }>("/v1/profile");
    expect(res.ok).toBe(true);
    expect(n).toBe(2);
  });

  it("passes an abort signal and retries an idempotent GET that times out", async () => {
    let n = 0;
    const fetchFn = vi.fn(async (_url, init) => {
      expect((init as RequestInit).signal).toBeInstanceOf(AbortSignal);
      n += 1;
      if (n === 1) throw new DOMException("The operation timed out.", "TimeoutError");
      return json({ ok: true });
    }) as unknown as typeof fetch;
    const client = makeClient(fetchFn);
    const res = await client.get<{ ok: boolean }>("/v1/profile");
    expect(res.ok).toBe(true);
    expect(n).toBe(2);
  });

  it("does NOT retry a POST that times out (no duplicate writes)", async () => {
    const fetchFn = vi.fn(async () => {
      throw new DOMException("The operation timed out.", "TimeoutError");
    }) as unknown as typeof fetch;
    const client = makeClient(fetchFn);
    await expect(client.post("/v1/invoices", { a: 1 })).rejects.toMatchObject({ status: 0 });
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("retries idempotent GETs on 5xx", async () => {
    let n = 0;
    const fetchFn = vi.fn(async () => {
      n += 1;
      return n < 3 ? json({ e: 1 }, 503) : json({ ok: true });
    }) as unknown as typeof fetch;
    const client = makeClient(fetchFn);
    const res = await client.get<{ ok: boolean }>("/v1/profile");
    expect(res.ok).toBe(true);
    expect(n).toBe(3);
  });

  it("maps a 400 to a validation error with safe detail", async () => {
    const fetchFn = vi.fn(async () =>
      json({ message: "voucherDate must not be null" }, 400),
    ) as unknown as typeof fetch;
    const client = makeClient(fetchFn);
    const err = await client.get("/v1/invoices/x").catch((e) => e);
    expect(err).toBeInstanceOf(LexwareApiError);
    expect(err.status).toBe(400);
    expect(err.kind).toBe("validation");
    expect(err.message).toContain("voucherDate must not be null");
    expect(err.message).not.toContain("secret-key");
  });

  it("classifies 401 as auth", async () => {
    const fetchFn = vi.fn(async () => json({}, 401)) as unknown as typeof fetch;
    const client = makeClient(fetchFn);
    const err = await client.get("/v1/profile").catch((e) => e);
    expect(err.kind).toBe("auth");
  });
});
