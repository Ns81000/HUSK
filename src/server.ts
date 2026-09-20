import "./lib/error-capture";

import { consumeLastCapturedError } from "./lib/error-capture";
import { renderErrorPage } from "./lib/error-page";

type ServerEntry = {
  fetch: (request: Request, env: unknown, ctx: unknown) => Promise<Response> | Response;
};

let serverEntryPromise: Promise<ServerEntry> | undefined;

async function getServerEntry(): Promise<ServerEntry> {
  if (!serverEntryPromise) {
    serverEntryPromise = import("@tanstack/react-start/server-entry").then(
      (m) => (m.default ?? m) as ServerEntry,
    );
  }
  return serverEntryPromise;
}

/**
 * The relay origin the browser talks to (WebSocket + file transfer), baked in
 * at build time exactly like the client bundle's copy.
 */
const WORKER_ORIGIN = (import.meta.env["VITE_WORKER_URL"] ?? "").replace(/\/$/, "");

function buildCsp(scriptHashes: readonly string[]): string {
  const connectSources = ["'self'"];
  if (WORKER_ORIGIN.length > 0) {
    connectSources.push(
      WORKER_ORIGIN,
      WORKER_ORIGIN.replace(/^http:/, "ws:").replace(/^https:/, "wss:"),
    );
  }
  return [
    "default-src 'self'",
    // The SSR shell emits inline scripts (TanStack stream barrier + scroll
    // restoration bootstrap + the constant theme pre-paint snippet). Each one
    // is hashed per response below, so no inline script outside the
    // server-rendered document can ever run.
    `script-src 'self' 'wasm-unsafe-eval' ${scriptHashes.join(" ")}`.trim(),
    // Inter is self-hosted from /fonts; inline style attributes from the SSR
    // shell require 'unsafe-inline'.
    "style-src 'self' 'unsafe-inline'",
    "font-src 'self'",
    "img-src 'self' data:",
    `connect-src ${connectSources.join(" ")}`,
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join("; ");
}

async function sha256Base64(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  let binary = "";
  for (const byte of new Uint8Array(digest)) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

async function hashInlineScripts(html: string): Promise<string[]> {
  const hashes: string[] = [];
  const pattern = /<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g;
  for (let match = pattern.exec(html); match !== null; match = pattern.exec(html)) {
    hashes.push(`'sha256-${await sha256Base64(match[1] ?? "")}'`);
  }
  return hashes;
}

/**
 * TanStack Start serializes dehydrated route-match IDs containing literal
 * U+0000 characters into the emitted `$tsr-stream-barrier` inline script. The
 * HTML parser replaces NUL with U+FFFD (WHATWG parse-error rule for NUL in
 * script data), so a hash computed over the raw response bytes can never
 * match the script text the browser executes — the framework's own hydration
 * bootstrap gets CSP-blocked and the app blanks after hydration. Re-encoding
 * each NUL as the equivalent JS string escape keeps the executed values
 * identical (a JS/JSON string literal "\u0000" is the same string as a raw
 * NUL) while making the bytes parser-stable, so per-response script hashes
 * hold. NUL never legitimately occurs in SSR output outside these scripts.
 */
function stabilizeInlineScriptBytes(html: string): string {
  return html.replaceAll("\u0000", "\\u0000");
}

/**
 * Adds the security header set to every server-rendered response. HTML
 * responses get a CSP whose script-src is closed over per-response hashes of
 * the exact inline scripts the SSR shell emitted (their content includes
 * dehydrated state, so static hashes would not work).
 */
async function withSecurityHeaders(response: Response): Promise<Response> {
  const headers = new Headers(response.headers);
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("Referrer-Policy", "no-referrer");
  headers.set("X-Frame-Options", "DENY");
  const contentType = headers.get("content-type") ?? "";
  if (contentType.includes("text/html")) {
    const html = stabilizeInlineScriptBytes(await response.text());
    const hashes = await hashInlineScripts(html);
    headers.set("Content-Security-Policy", buildCsp(hashes));
    return new Response(html, { status: response.status, headers });
  }
  return new Response(response.body, { status: response.status, headers });
}

// h3 swallows in-handler throws into a normal 500 Response with body
// {"unhandled":true,"message":"HTTPError"} — try/catch alone never fires for those.
async function normalizeCatastrophicSsrResponse(response: Response): Promise<Response> {
  if (response.status < 500) return response;
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes("application/json")) return response;

  const body = await response.clone().text();
  if (!isH3SwallowedErrorBody(body)) return response;

  console.error(consumeLastCapturedError() ?? new Error(`h3 swallowed SSR error: ${body}`));
  return withSecurityHeaders(
    new Response(renderErrorPage(), {
      status: 500,
      headers: { "content-type": "text/html; charset=utf-8" },
    }),
  );
}

function isH3SwallowedErrorBody(body: string): boolean {
  try {
    const payload = JSON.parse(body) as { unhandled?: unknown; message?: unknown };
    return payload.unhandled === true && payload.message === "HTTPError";
  } catch {
    return false;
  }
}

export default {
  async fetch(request: Request, env: unknown, ctx: unknown) {
    try {
      const handler = await getServerEntry();
      const response = await handler.fetch(request, env, ctx);
      return withSecurityHeaders(await normalizeCatastrophicSsrResponse(response));
    } catch (error) {
      console.error(error);
      return withSecurityHeaders(
        new Response(renderErrorPage(), {
          status: 500,
          headers: { "content-type": "text/html; charset=utf-8" },
        }),
      );
    }
  },
};
