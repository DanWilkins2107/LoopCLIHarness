import { BACKOFF_BASE_S, BACKOFF_CAP_S } from "./constants";

export function sleepMs(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export function apiBackoffMs(n: number): number {
  return Math.min(BACKOFF_BASE_S * 2 ** n, BACKOFF_CAP_S) * 1000;
}
