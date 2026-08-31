/**
 * Join rate limiting logic.
 *
 * Counts attempts per IP and per room id inside a fixed window and applies
 * exponential backoff once the window budget is exhausted. Only counters and
 * timestamps are stored; no message data of any kind. The counters themselves
 * live in the HuskGatekeeper Durable Object (see gate.ts), not KV.
 */

import {
  JOIN_BACKOFF_BASE_SECONDS,
  JOIN_BACKOFF_MAX_SECONDS,
  JOIN_MAX_ATTEMPTS,
  JOIN_WINDOW_SECONDS,
} from "./config";
import type { Env } from "./types";

export type RateRecord = {
  readonly attempts: number;
  readonly windowStart: number;
  readonly strikes: number;
  readonly blockedUntil: number;
};

export type RateDecision = {
  readonly allowed: boolean;
  readonly retryAfterSeconds: number;
  readonly next: RateRecord;
};

export function evaluate(
  record: RateRecord | null,
  now: number,
  maxAttempts: number = JOIN_MAX_ATTEMPTS,
): RateDecision {
  const windowMs = JOIN_WINDOW_SECONDS * 1000;
  const base: RateRecord = record ?? {
    attempts: 0,
    windowStart: now,
    strikes: 0,
    blockedUntil: 0,
  };

  if (base.blockedUntil > now) {
    return {
      allowed: false,
      retryAfterSeconds: Math.ceil((base.blockedUntil - now) / 1000),
      next: base,
    };
  }

  // A served penalty resets the window, so a throttled caller gets a fresh
  // budget rather than being locked out forever by a stale counter.
  const penaltyServed = base.blockedUntil > 0 && now >= base.blockedUntil;
  const windowExpired = penaltyServed || now - base.windowStart >= windowMs;
  const attempts = windowExpired ? 1 : base.attempts + 1;
  const windowStart = windowExpired ? now : base.windowStart;

  if (attempts > maxAttempts) {
    const strikes = base.strikes + 1;
    const penalty = Math.min(
      JOIN_BACKOFF_MAX_SECONDS,
      JOIN_BACKOFF_BASE_SECONDS * 2 ** (strikes - 1),
    );
    return {
      allowed: false,
      retryAfterSeconds: penalty,
      next: {
        attempts,
        windowStart,
        strikes,
        blockedUntil: now + penalty * 1000,
      },
    };
  }

  return {
    allowed: true,
    retryAfterSeconds: 0,
    next: { attempts, windowStart, strikes: base.strikes, blockedUntil: 0 },
  };
}

/** A record can be dropped once neither its window nor penalty can matter again. */
export function isRecordExpired(record: RateRecord, now: number): boolean {
  const windowMs = JOIN_WINDOW_SECONDS * 1000;
  return now >= record.blockedUntil && now - record.windowStart >= windowMs;
}

/**
 * Asks the gatekeeper Durable Object for a join decision across every counter
 * key (per IP and per room id). Fails closed: an unreachable gatekeeper must not
 * silently disable the anti-brute-force budget.
 */
export async function checkJoinAllowed(
  env: Env,
  keys: readonly string[],
  maxAttempts: number = JOIN_MAX_ATTEMPTS,
): Promise<{ allowed: boolean; retryAfterSeconds: number }> {
  const gate = env.HUSK_GATE.get(env.HUSK_GATE.idFromName("gate"));
  const response = await gate.fetch(
    new Request("https://gate/check", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ keys, maxAttempts }),
    }),
  );
  if (!response.ok) {
    return { allowed: false, retryAfterSeconds: 30 };
  }
  // SAFETY: this route is served only by our own gatekeeper with this shape.
  const decision = (await response.json()) as {
    allowed?: unknown;
    retryAfterSeconds?: unknown;
  };
  return {
    allowed: decision.allowed === true,
    retryAfterSeconds: Number(decision.retryAfterSeconds ?? 0),
  };
}
