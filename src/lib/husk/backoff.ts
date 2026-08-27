import { RECONNECT_MAX_MS, RECONNECT_MIN_MS } from "./config";

/**
 * Exponential reconnect backoff with jitter, bounded by the configured
 * minimum and maximum delays.
 */
export function backoffDelay(attempt: number, random: () => number = Math.random): number {
  const raw = RECONNECT_MIN_MS * 2 ** Math.max(0, attempt);
  const capped = Math.min(raw, RECONNECT_MAX_MS);
  const jitter = capped * 0.2 * random();
  return Math.round(Math.min(RECONNECT_MAX_MS, capped - capped * 0.1 + jitter));
}
