/**
 * Husk edge Worker.
 *
 * Routes requests to the room Durable Objects and to the rate-limit
 * gatekeeper, and mints the short-lived signed tickets used for chunked file
 * transfer. It handles ciphertext only: grep this directory for a variable
 * holding a room key and you will find none, because the key lives
 * exclusively in the browser URL fragment.
 */

import { JOIN_TOKEN_TTL_SECONDS, MAX_FILE_BYTES, PIN_PATTERN } from "./config";
import { checkJoinAllowed } from "./rate-limit";
import { signTicket } from "./tickets";
import type { Env } from "./types";

export { HuskRoom } from "./room";
export { HuskGatekeeper } from "./gate";

type CorsHeaders = Record<string, string>;

function corsHeaders(request: Request, env: Env): CorsHeaders {
  const origin = request.headers.get("Origin") ?? "";
  const allowed = env.ALLOWED_ORIGINS.split(",").map((value) => value.trim());
  const headers: CorsHeaders = {
    "Access-Control-Allow-Methods": "GET,POST,PUT,OPTIONS",
    "Access-Control-Allow-Headers": "content-type",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
  // No ACAO header at all for disallowed origins: the browser blocks the read.
  if (origin !== "" && allowed.includes(origin)) {
    headers["Access-Control-Allow-Origin"] = origin;
  }
  return headers;
}

function json<T>(body: T, status: number, headers: CorsHeaders): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...headers, "content-type": "application/json" },
  });
}

const SOCKET_PATTERN = /^\/room\/([1-9][0-9]{5})\/socket$/;
const FILE_INIT_PATTERN = /^\/room\/([1-9][0-9]{5})\/file$/;
const FILE_OBJECT_PATTERN = /^\/room\/([1-9][0-9]{5})\/file\/([0-9a-f-]{36})(?:\/(\d+))?$/;

/** Boundary parsers: request bodies are coerced, then validated by pattern. */
async function readJson(request: Request): Promise<Record<string, unknown>> {
  try {
    // SAFETY: the value is narrowed by callers before any field is used.
    return (await request.json()) as Record<string, unknown>;
  } catch {
    return {};
  }
}

/** Forwards a response from a Durable Object, adding CORS headers without buffering the body. */
function forwardWithCors(response: Response, cors: CorsHeaders): Response {
  const headers = new Headers(response.headers);
  for (const [key, value] of Object.entries(cors)) {
    headers.set(key, value);
  }
  return new Response(response.body, { status: response.status, headers });
}

type FileGrant = {
  fileId: string;
  chunks: number;
  putExpiresAt: number;
  chunkSigs: string[];
  getExpiresAt: number;
  getSig: string;
};

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const cors = corsHeaders(request, env);
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: cors });
    }

    // POST /room/create  { pin }
    if (url.pathname === "/room/create" && request.method === "POST") {
      const body = await readJson(request);
      const pin = String(body.pin ?? "");
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
      const body = await readJson(request);
      const pin = String(body.pin ?? "");
      const ip = request.headers.get("CF-Connecting-IP") ?? "unknown";
      const decision = await checkJoinAllowed(env, [`ip:${ip}`, `pin:${pin}`]);
      if (!decision.allowed) {
        return json({ error: "rate_limited", retryAfter: decision.retryAfterSeconds }, 429, cors);
      }
      if (!PIN_PATTERN.test(pin)) {
        return json({ error: "unavailable" }, 404, cors);
      }
      const stub = env.HUSK_ROOMS.get(env.HUSK_ROOMS.idFromName(pin));
      const joined = await stub.fetch(new Request(`https://room/${pin}/join`, { method: "POST" }));
      if (!joined.ok) {
        // Deliberately generic: does not distinguish missing, full or wrong.
        return json({ error: "unavailable" }, 404, cors);
      }
      // Mint the one-time token the socket route will consume, bound to this
      // caller's IP so a leaked link cannot be replayed from elsewhere.
      const tokenExpiresAt = Math.floor(Date.now() / 1000) + JOIN_TOKEN_TTL_SECONDS;
      const tokenSignature = await signTicket(
        env.HUSK_TICKET_SECRET,
        "join",
        `${pin}|${ip}|${tokenExpiresAt}`,
        tokenExpiresAt,
      );
      return json({ ok: true, pin, joinToken: `${tokenExpiresAt}.${tokenSignature}` }, 200, cors);
    }

    // GET (upgrade) /room/<pin>/socket?jt=<one-time join token>
    // The join token is minted only by a successful, rate-limited /room/join,
    // so every socket connect costs exactly one join attempt: the socket route
    // cannot bypass the join budget, and probing it without a token yields the
    // same generic 404 as a nonexistent room (no existence oracle).
    const socketMatch = SOCKET_PATTERN.exec(url.pathname);
    if (socketMatch) {
      const stub = env.HUSK_ROOMS.get(env.HUSK_ROOMS.idFromName(socketMatch[1] ?? ""));
      const forwarded = new Request(request.url, request);
      forwarded.headers.set("x-husk-ip", request.headers.get("CF-Connecting-IP") ?? "unknown");
      forwarded.headers.set("x-husk-join-token", url.searchParams.get("jt") ?? "");
      return stub.fetch(forwarded);
    }

    // POST /room/<pin>/file  { size, member }
    // Reserves room storage for one encrypted file and returns per-chunk
    // upload URLs plus the download capability that travels inside the
    // encrypted relay. The room Durable Object enforces that "member" is a
    // currently connected participant, so storage cannot be reserved — or
    // tickets minted — by anyone who has not joined the room.
    const fileInitMatch = FILE_INIT_PATTERN.exec(url.pathname);
    if (fileInitMatch && request.method === "POST") {
      const pin = fileInitMatch[1] ?? "";
      const body = await readJson(request);
      const size = Number(body.size);
      const member = String(body.member ?? "");
      if (!Number.isFinite(size) || size <= 0 || size > MAX_FILE_BYTES || member === "") {
        return json({ error: "bad_request" }, 400, cors);
      }
      const stub = env.HUSK_ROOMS.get(env.HUSK_ROOMS.idFromName(pin));
      const grantResponse = await stub.fetch(
        new Request(`https://do${url.pathname}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ size, member }),
        }),
      );
      if (!grantResponse.ok) {
        return forwardWithCors(grantResponse, cors);
      }
      // SAFETY: the Durable Object is our own code and returns this exact shape;
      // the fields are re-checked before the URLs are built.
      const grant = (await grantResponse.json()) as Partial<FileGrant>;
      if (
        grant.fileId === undefined ||
        grant.putExpiresAt === undefined ||
        grant.getExpiresAt === undefined ||
        grant.getSig === undefined ||
        !Array.isArray(grant.chunkSigs)
      ) {
        return json({ error: "unavailable" }, 503, cors);
      }
      return json(
        {
          fileId: grant.fileId,
          chunkUrls: grant.chunkSigs.map(
            (signature, index) =>
              `${url.origin}/room/${pin}/file/${grant.fileId}/${index}?exp=${grant.putExpiresAt}&sig=${signature}`,
          ),
          download: { exp: grant.getExpiresAt, sig: grant.getSig },
        },
        200,
        cors,
      );
    }

    // PUT /room/<pin>/file/<fileId>/<n>?exp=&sig=   (one encrypted chunk)
    // GET /room/<pin>/file/<fileId>?exp=&sig=       (streamed ciphertext)
    const fileObjectMatch = FILE_OBJECT_PATTERN.exec(url.pathname);
    if (fileObjectMatch) {
      const stub = env.HUSK_ROOMS.get(env.HUSK_ROOMS.idFromName(fileObjectMatch[1] ?? ""));
      const response = await stub.fetch(request);
      return forwardWithCors(response, cors);
    }

    return json({ error: "not_found" }, 404, cors);
  },
};
