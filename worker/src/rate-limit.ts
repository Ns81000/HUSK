/**
 * KV-backed join rate limiting.
 *
 * Counts attempts per IP and per PIN inside a fixed window and applies
 * exponential backoff once the window budget is exhausted. Only counters and
 * timestamps are stored; no message data of any kind.
 */

import {
  JOIN_BACKOFF_BASE_SECONDS,
  JOIN_BACKOFF_MAX_SECONDS,
  JOIN_MAX_ATTEMPTS,
  JOIN_WINDOW_SECONDS,
} from "./config";
import type { KVNamespace } from "./types";

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

  if (attempts > JOIN_MAX_ATTEMPTS) {
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

export async function checkJoinAllowed(
  kv: KVNamespace,
  keys: readonly string[],
  now: number,
): Promise<RateDecision> {
  let blocked: RateDecision | null = null;
  let allowedDecision: RateDecision | null = null;

  for (const key of keys) {
    const raw = await kv.get(key);
    // SAFETY: this key namespace is written only by this module, with this shape.
    const record = raw === null ? null : (JSON.parse(raw) as RateRecord);
    const decision = evaluate(record, now);
    await kv.put(key, JSON.stringify(decision.next), {
      expirationTtl: JOIN_WINDOW_SECONDS + JOIN_BACKOFF_MAX_SECONDS,
    });
    if (decision.allowed) {
      allowedDecision = allowedDecision ?? decision;
    } else if (blocked === null || decision.retryAfterSeconds > blocked.retryAfterSeconds) {
      blocked = decision;
    }
  }

  return (
    blocked ??
    allowedDecision ?? {
      allowed: true,
      retryAfterSeconds: 0,
      next: { attempts: 1, windowStart: now, strikes: 0, blockedUntil: 0 },
    }
  );
}
