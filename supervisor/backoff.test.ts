import { describe, it, expect, afterEach, vi } from "vitest";
import { apiBackoffMs, sleepMs } from "./backoff";
import { BACKOFF_BASE_S, BACKOFF_CAP_S, BACKOFF_JITTER } from "./constants";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("sleepMs", () => {
  it("resolves after the requested delay", async () => {
    vi.useFakeTimers();
    const done = vi.fn();
    const p = sleepMs(500).then(done);
    await vi.advanceTimersByTimeAsync(499);
    expect(done).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(done).toHaveBeenCalled();
    await p;
  });
});

describe("apiBackoffMs", () => {
  it("doubles with each attempt", () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    expect(apiBackoffMs(0)).toBe(BACKOFF_BASE_S * 1000);
    expect(apiBackoffMs(1)).toBe(BACKOFF_BASE_S * 2000);
    expect(apiBackoffMs(2)).toBe(BACKOFF_BASE_S * 4000);
  });

  it("clamps at the cap", () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    expect(apiBackoffMs(30)).toBe(BACKOFF_CAP_S * 1000);
  });

  it("adds at most JITTER on top of the capped delay", () => {
    vi.spyOn(Math, "random").mockReturnValue(1);
    expect(apiBackoffMs(30)).toBe(BACKOFF_CAP_S * 1000 * (1 + BACKOFF_JITTER));
  });

  it("stays within [delay, delay * (1 + JITTER)] with real randomness", () => {
    for (let n = 0; n < 12; n++) {
      const base = Math.min(BACKOFF_BASE_S * 2 ** n, BACKOFF_CAP_S) * 1000;
      const ms = apiBackoffMs(n);
      expect(ms).toBeGreaterThanOrEqual(base);
      expect(ms).toBeLessThanOrEqual(base * (1 + BACKOFF_JITTER));
    }
  });
});
