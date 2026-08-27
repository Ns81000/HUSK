/**
 * Husk edge Worker.
 *
 * Routes requests to the room's Durable Object, rate-limits join attempts and
 * issues short-lived signed R2 tickets. It handles ciphertext only: grep this
 * directory for a variable holding a room key and you will find none, because
 * the key lives exclusively in the browser URL fragment.
 */

import { MAX_FILE_BYTES, TICKET_TTL_SECONDS } from "./config";
import { checkJoinAllowed } from "./rate-limit";
import { signTicket, verifyTicket } from "./tickets";
import type { Env } from "./types";

export { HuskRoom } from "./room";

type CorsHeaders = {
  readonly "Access-Control-Allow-Origin": string;
  readonly "Access-Control-Allow-Methods": string;
  readonly "Access-Control-Allow-Headers": string;
  readonly "Access-Control-Max-Age": string;
  readonly Vary: string;
};

function corsHeaders(request: Request, env: Env): CorsHeaders {
  const origin = request.headers.get("Origin") ?? "";
  const allowed = env.ALLOWED_ORIGINS.split(",").map((value) => value.trim());
  const match = allowed.includes(origin) ? origin : (allowed[0] ?? "");
  return {
    "Access-Control-Allow-Origin": match,
    "Access-Control-Allow-Methods": "GET,POST,PUT,OPTIONS",
    "Access-Control-Allow-Headers": "content-type,x-husk-chunks",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
}

function json<T>(body: T, status: number, headers: CorsHeaders): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...headers, "content-type": "application/json" },
  });
}

const PIN_PATTERN = /^[1-9][0-9]{5}$/;

/** Boundary parsers: request bodies are coerced, then validated by pattern. */
async function readPin(request: Request): Promise<string> {
  try {
    // SAFETY: the value is coerced to a string and pattern-checked by callers.
    const body = (await request.json()) as { pin?: string };
    return String(body.pin ?? "");
  } catch {
    return "";
  }
}

async function readSize(request: Request): Promise<number> {
  try {
    // SAFETY: the value is coerced to a number and range-checked by callers.
    const body = (await request.json()) as { size?: number };
    return Number(body.size);
  } catch {
    return Number.NaN;
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const cors = corsHeaders(request, env);
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: cors });
    }

    // POST /room/create  { pin }
    if (url.pathname === "/room/create" && request.method === "POST") {
      const pin = await readPin(request);
      if (!PIN_PATTERN.test(pin)) {
        return json({ error: "bad_request" }, 400, cors);
      }
      const stub = env.HUSK_ROOMS.get(env.HUSK_ROOMS.idFromName(pin));
      const created = await stub.fetch(
        new Request(`https://room/${pin}/create`, { method: "POST" }),
      );
      if (created.status === 409) {
        // PIN collision: the caller regenerates transparently.
        return json({ error: "pin_taken" }, 409, cors);
      }
      if (!created.ok) {
        return json({ error: "unavailable" }, 503, cors);
      }
      return json({ ok: true, pin }, 200, cors);
    }

    // POST /room/join  { pin }
    if (url.pathname === "/room/join" && request.method === "POST") {
      const pin = await readPin(request);
      const ip = request.headers.get("CF-Connecting-IP") ?? "unknown";
      const decision = await checkJoinAllowed(
        env.HUSK_RATE_LIMIT,
        [`ip:${ip}`, `pin:${pin}`],
        Date.now(),
      );
      if (!decision.allowed) {
        return json(
          { error: "rate_limited", retryAfter: decision.retryAfterSeconds },
          429,
          cors,
        );
      }
      if (!PIN_PATTERN.test(pin)) {
        return json({ error: "unavailable" }, 404, cors);
      }
      const stub = env.HUSK_ROOMS.get(env.HUSK_ROOMS.idFromName(pin));
      const joined = await stub.fetch(
        new Request(`https://room/${pin}/join`, { method: "POST" }),
      );
      if (!joined.ok) {
        // Deliberately generic: does not distinguish missing, full or wrong.
        return json({ error: "unavailable" }, 404, cors);
      }
      return json({ ok: true, pin }, 200, cors);
    }

    const socketMatch = /^\/room\/([0-9]{6})\/socket$/.exec(url.pathname);
    if (socketMatch) {
      const pin = socketMatch[1] ?? "";
      const stub = env.HUSK_ROOMS.get(env.HUSK_ROOMS.idFromName(pin));
      return stub.fetch(request);
    }

    const ticketMatch = /^\/room\/([0-9]{6})\/upload-ticket$/.exec(url.pathname);
    if (ticketMatch && request.method === "POST") {
      const pin = ticketMatch[1] ?? "";
      const size = await readSize(request);
      if (!Number.isFinite(size) || size <= 0 || size > MAX_FILE_BYTES) {
        return json({ error: "bad_request" }, 400, cors);
      }
      const objectKey = `${pin}/${crypto.randomUUID()}`;
      const expiresAt = Math.floor(Date.now() / 1000) + TICKET_TTL_SECONDS;
      const putSignature = await signTicket(
        env.HUSK_TICKET_SECRET,
        "put",
        objectKey,
        expiresAt,
      );
      const getSignature = await signTicket(
        env.HUSK_TICKET_SECRET,
        "get",
        objectKey,
        expiresAt,
      );
      return json(
        {
          objectKey,
          uploadUrl: `${url.origin}/object/${encodeURIComponent(objectKey)}?exp=${expiresAt}&sig=${putSignature}`,
          downloadUrl: `${url.origin}/object/${encodeURIComponent(objectKey)}?exp=${expiresAt}&sig=${getSignature}`,
        },
        200,
        cors,
      );
    }

    const objectMatch = /^\/object\/(.+)$/.exec(url.pathname);
    if (objectMatch) {
      const objectKey = decodeURIComponent(objectMatch[1] ?? "");
      const expiresAt = Number(url.searchParams.get("exp"));
      const signature = url.searchParams.get("sig") ?? "";
      const operation = request.method === "PUT" ? "put" : "get";
      const valid = await verifyTicket(
        env.HUSK_TICKET_SECRET,
        operation,
        objectKey,
        expiresAt,
        signature,
        Date.now(),
      );
      if (!valid) {
        return json({ error: "forbidden" }, 403, cors);
      }

      if (operation === "put") {
        if (request.body === null) {
          return json({ error: "bad_request" }, 400, cors);
        }
        await env.HUSK_FILES.put(objectKey, request.body);
        return json({ ok: true }, 200, cors);
      }

      const object = await env.HUSK_FILES.get(objectKey);
      if (object === null || object.body === null) {
        return json({ error: "not_found" }, 404, cors);
      }
      return new Response(object.body, {
        status: 200,
        headers: { ...cors, "content-type": "application/octet-stream" },
      });
    }

    return json({ error: "not_found" }, 404, cors);
  },
};
