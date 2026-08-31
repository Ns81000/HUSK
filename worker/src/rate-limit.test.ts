import { describe, expect, it } from "vitest";
import { evaluate, type RateRecord } from "./rate-limit";
import { CREATE_MAX_ATTEMPTS, JOIN_MAX_ATTEMPTS, JOIN_WINDOW_SECONDS } from "./config";

const now = 1_700_000_000_000;

describe("join rate limiting", () => {
  it("allows the first attempt", () => {
    const decision = evaluate(null, now);
    expect(decision.allowed).toBe(true);
    expect(decision.next.attempts).toBe(1);
  });

  it("allows up to the window budget", () => {
    let record: RateRecord | null = null;
    for (let attempt = 0; attempt < JOIN_MAX_ATTEMPTS; attempt += 1) {
      const decision = evaluate(record, now);
      expect(decision.allowed).toBe(true);
      record = decision.next;
    }
    expect(evaluate(record, now).allowed).toBe(false);
  });

  it("applies exponential backoff on repeated abuse", () => {
    const overLimit: RateRecord = {
      attempts: JOIN_MAX_ATTEMPTS,
      windowStart: now,
      strikes: 0,
      blockedUntil: 0,
    };
    const first = evaluate(overLimit, now);
    const second = evaluate({ ...first.next, blockedUntil: 0 }, now);
    expect(second.retryAfterSeconds).toBeGreaterThan(first.retryAfterSeconds);
  });

  it("keeps blocking until the penalty elapses", () => {
    const blocked: RateRecord = {
      attempts: 99,
      windowStart: now,
      strikes: 3,
      blockedUntil: now + 30_000,
    };
    expect(evaluate(blocked, now).allowed).toBe(false);
    expect(evaluate(blocked, now + 31_000).allowed).toBe(true);
  });

  it("resets after the window expires", () => {
    const stale: RateRecord = {
      attempts: JOIN_MAX_ATTEMPTS,
      windowStart: now - (JOIN_WINDOW_SECONDS + 1) * 1000,
      strikes: 0,
      blockedUntil: 0,
    };
    const decision = evaluate(stale, now);
    expect(decision.allowed).toBe(true);
    expect(decision.next.attempts).toBe(1);
  });

  it("enforces the tighter create budget under its own namespace", () => {
    // The create budget (CREATE_MAX_ATTEMPTS) is smaller than the join
    // budget: the 5th create in a window is the last allowed one.
    expect(CREATE_MAX_ATTEMPTS).toBeLessThan(JOIN_MAX_ATTEMPTS);
    let record: RateRecord | null = null;
    for (let attempt = 0; attempt < CREATE_MAX_ATTEMPTS; attempt += 1) {
      const decision = evaluate(record, now, CREATE_MAX_ATTEMPTS);
      expect(decision.allowed).toBe(true);
      record = decision.next;
    }
    expect(evaluate(record, now, CREATE_MAX_ATTEMPTS).allowed).toBe(false);
    // The same counter under the join budget would still be allowed.
    expect(evaluate(record, now).allowed).toBe(true);
  });

  it("applies backoff once the create budget is exhausted", () => {
    const overLimit: RateRecord = {
      attempts: CREATE_MAX_ATTEMPTS,
      windowStart: now,
      strikes: 0,
      blockedUntil: 0,
    };
    const decision = evaluate(overLimit, now, CREATE_MAX_ATTEMPTS);
    expect(decision.allowed).toBe(false);
    expect(decision.retryAfterSeconds).toBeGreaterThan(0);
  });
});
