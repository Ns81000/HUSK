import { describe, expect, it } from "vitest";
import { backoffDelay } from "./backoff";
import { RECONNECT_MAX_MS, RECONNECT_MIN_MS } from "./config";

describe("reconnect backoff", () => {
  it("starts near the configured minimum", () => {
    expect(backoffDelay(0, () => 0.5)).toBeGreaterThanOrEqual(RECONNECT_MIN_MS * 0.9);
    expect(backoffDelay(0, () => 0.5)).toBeLessThanOrEqual(RECONNECT_MIN_MS * 1.1);
  });

  it("grows exponentially", () => {
    expect(backoffDelay(2, () => 0.5)).toBeGreaterThan(backoffDelay(1, () => 0.5));
  });

  it("never exceeds the cap", () => {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      expect(backoffDelay(attempt, () => 1)).toBeLessThanOrEqual(RECONNECT_MAX_MS);
    }
  });
});
