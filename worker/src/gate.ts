/**
 * HuskGatekeeper Durable Object.
 *
 * A single instance ("gate") that owns the join rate-limit counters in SQLite
 * storage, replacing the previous KV namespace so deployment needs no manual
 * resource creation. Storage is kept bounded by an alarm that sweeps records
 * whose window and penalty have both fully elapsed.
 */

import { JOIN_BACKOFF_MAX_SECONDS, JOIN_WINDOW_SECONDS } from "./config";
import { evaluate, isRecordExpired, type RateDecision, type RateRecord } from "./rate-limit";
import type { DurableObjectState } from "./types";

const RECORD_PREFIX = "rl:";
const PURGE_INTERVAL_MS = 60 * 60 * 1000;

type CheckRequest = { keys?: unknown };

export class HuskGatekeeper {
  constructor(private readonly state: DurableObjectState) {}

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/check" && request.method === "POST") {
      let body: CheckRequest;
      try {
        // SAFETY: the shape is narrowed below before any use.
        body = (await request.json()) as CheckRequest;
      } catch {
        return Response.json({ error: "bad_request" }, { status: 400 });
      }
      const keys = Array.isArray(body.keys)
        ? body.keys.filter((key): key is string => typeof key === "string")
        : [];
      if (keys.length === 0) {
        return Response.json({ error: "bad_request" }, { status: 400 });
      }
      const now = Date.now();
      const decision = await this.check(keys, now);
      await this.ensurePurgeAlarm(now);
      return Response.json({
        allowed: decision.allowed,
        retryAfterSeconds: decision.retryAfterSeconds,
      });
    }
    return new Response("not_found", { status: 404 });
  }

  private async check(keys: readonly string[], now: number): Promise<RateDecision> {
    let blocked: RateDecision | null = null;
    let allowedDecision: RateDecision | null = null;

    for (const key of keys) {
      // SAFETY: this key namespace is written only by this class, with this shape.
      const record = (await this.state.storage.get<RateRecord>(`${RECORD_PREFIX}${key}`)) ?? null;
      const decision = evaluate(record, now);
      await this.state.storage.put(`${RECORD_PREFIX}${key}`, decision.next);
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

  private async ensurePurgeAlarm(now: number): Promise<void> {
    const current = await this.state.storage.getAlarm();
    if (current === null) {
      await this.state.storage.setAlarm(now + PURGE_INTERVAL_MS);
    }
  }

  async alarm(): Promise<void> {
    const now = Date.now();
    const records = await this.state.storage.list<RateRecord>({
      prefix: RECORD_PREFIX,
    });
    const stale: string[] = [];
    for (const [key, record] of records) {
      if (isRecordExpired(record, now)) {
        stale.push(key);
      }
    }
    if (stale.length > 0) {
      await this.state.storage.delete(stale);
    }
    // Any record still relevant now expires within the window plus the
    // maximum penalty, so one interval later the sweep can always finish.
    await this.state.storage.setAlarm(
      now + (JOIN_WINDOW_SECONDS + JOIN_BACKOFF_MAX_SECONDS) * 1000 + PURGE_INTERVAL_MS,
    );
  }
}
