# Phase 2 — Security & Cryptography

## Summary

Read `src/lib/husk/crypto.ts` (+ tests), `pin.ts` (+ tests), `linkify.ts` (+ tests), `protocol.ts`, `connection.ts`, `store.ts`, `api.ts`, both routes, `error-capture.ts`, `lovable-error-reporting.ts`, `src/server.ts`, `theme.ts`, and re-traced every Worker route from Phase 1. Ran repo-wide greps for key-leakage channels (`console.log`, `localStorage`/`sessionStorage`, `document.cookie`, `postMessage`, `sendBeacon`), XSS vectors (`dangerouslySetInnerHTML`, `innerHTML`, `alert/confirm/prompt`), hash/fragment usage, and `pnpm audit` (root, prod deps: no known vulnerabilities). The core cryptographic design is genuinely correct — the claims hold at code level. The biggest real gap is the complete absence of CSP/security headers, plus the two Worker-side abuse findings cross-referenced from Phase 1.

## Findings

### [HIGH] No Content-Security-Policy or security headers anywhere in the frontend (src/server.ts:47-61; no `_headers` file; no CSP meta)
- **Category:** Security
- **Evidence:** `src/server.ts` builds 500 responses with only `content-type`; greps for `content-security-policy|x-frame-options|frame-ancestors|_headers` across `src/`, `public/`, `vite.config.ts` return zero hits. `public/` contains only `favicon.ico` and `robots.txt`. Worker routes set no security headers either.
- **Why it matters:** Spec Section 5 explicitly requires "Strict CSP headers on the deployed frontend — no inline scripts, no wildcard script-src, no third-party analytics." As deployed, the app has no XSS backstop (if any future injection bug appears, nothing constrains it), no `frame-ancestors`/`X-Frame-Options` (the room page can be iframed and clickjacked — realistic for a "paste your invite link" app), and no `referrer-policy` beyond browser defaults. Note: TanStack Start SSR injects inline hydration/bootstrap scripts, so a naive `script-src 'self'` will break the app — the fix needs nonce-based CSP coordinated with the SSR shell.
- **Confidence:** High (absence verified)
- **Recommended fix:** Add nonce-based CSP + `frame-ancestors 'none'` + `referrer-policy: no-referrer` + `X-Content-Type-Options: nosniff` in `src/server.ts` (and a `_headers`/Worker-header equivalent for static assets); audit which inline scripts the SSR shell emits before choosing `script-src` tokens.

### [HIGH] WebSocket route is an unthrottled PIN existence oracle and skips join rate limiting (worker/src/index.ts:127-132)
- **Category:** Security (full evidence in Phase 1)
- **Why it matters here:** This is the single biggest hole in the spec's Section 5 anti-brute-force requirement. `/room/join` enforces the 10-per-5-min KV budget and returns generic errors; `/room/<pin>/socket` enforces neither, and 101-vs-404 cleanly distinguishes live rooms. An attacker can enumerate the 900k PIN space and then passively listen to ciphertext of any live room (which they cannot decrypt without the fragment — but presence, timing, and message volume leak, and combined with a shared-link interception the room is fully exposed).
- **Confidence:** High
- **Recommended fix:** Rate-limit `/socket` connections per IP with the same `checkJoinAllowed` budget; ideally require a short-lived join token issued by a successful `/room/join`.

### [HIGH] Upload tickets are unauthenticated, unthrottled, and not single-use (worker/src/index.ts:134-164, worker/src/tickets.ts:44-64)
- **Category:** Security (full evidence in Phase 1)
- **Why it matters here:** README.md:96 claims "single-use" — false in code (HMAC + expiry only, unlimited replays within 5 min, PUT and GET issued together to anonymous callers). Spec Section 4's "short-lived, single-use" upload-URL requirement is only half-implemented.
- **Confidence:** High
- **Recommended fix:** Gate issuance on live room membership via the DO; add a one-time-use registry (KV nonce or DO-set) or restate the actual guarantee honestly everywhere.

### [MEDIUM] Editor telemetry hooks ship in the production bundle (src/lib/lovable-error-reporting.ts:26-58)
- **Category:** Security / Metadata minimization
- **Evidence:** `window.__lovableEvents?.captureException?.(...)` and `window.__lovableReportRuntimeError?.(...)` with `route: window.location.pathname`. The hooks are only defined inside the Lovable editor preview, so in production they are undefined and no data leaves — but the reporting code ships, and if the editor runtime were ever present (e.g. preview URL shared with a guest), error reports including stack traces would go to a third party. Spec Section 5: "no third-party analytics or trackers of any kind."
- **Confidence:** High (code path), Medium (real-world exposure)
- **Recommended fix:** Strip this module from production builds (dead-code eliminate behind `import.meta.env.DEV`) or delete it outright.

### [LOW] Ticket signatures travel in URLs and are replayable within TTL (worker/src/index.ts:158-159)
- **Category:** Security (minor)
- **Evidence:** `?exp=...&sig=...` in both upload and download URLs; `verifyTicket` has no nonce.
- **Why it matters:** URLs (with signatures) can leak via intermediary logs; within 5 minutes a leaked download URL is reusable by anyone. Acceptable for ciphertext-only content, but should be a documented, deliberate decision.
- **Confidence:** High
- **Recommended fix:** Fold into the single-use ticket fix above.

### [LOW] Global `console.error` monkeypatch records error stacks in module state (src/lib/error-capture.ts:55-63)
- **Category:** Security (minor) / Reliability
- **Evidence:** Wraps `console.error` to expand and record Error objects for 5s, read back by the SSR 500 path in `server.ts`.
- **Why it matters:** Any future error object carrying sensitive strings (e.g. a message body in a render error) would flow into the SSR error page's log pipeline. The room key itself never appears in error objects today (verified: no error constructor in `src/lib/husk/` receives the fragment), so this is latent, not active.
- **Confidence:** Medium
- **Recommended fix:** Keep, but add a lint/test guard that no `src/lib/husk` error path embeds payload content in Error messages.

## Verified-Correct

- **AES-256-GCM is genuinely correct** — `crypto.subtle` with `AES-GCM`, 32-byte keys (`ROOM_KEY_BYTES`), 12-byte IVs, and a **fresh `crypto.getRandomValues` IV per `sealBytes` call** (crypto.ts:72). No counter/derived IV anywhere. The single most catastrophic AES-GCM bug (IV reuse) is not present.
- **Keys are non-extractable** — `importKey(..., false, ["encrypt","decrypt"])` (crypto.ts:59-65); wrong-length fragments rejected before import.
- **Tamper handling per spec** — GCM failure and malformed plaintext both raise `DecryptionFailedError`; store.ts:148-164 surfaces a distinct `unverified` delivery state instead of dropping or crashing.
- **The room key never reaches the server — verified, not assumed.** All channels checked: `api.ts` takes only PIN/size; `connection.ts` sends only `{t, localId, payload:{iv,ct}}`; `protocol.ts` has no key field; Worker code has no variable that could hold K (only `pin`, `objectKey`, ticket sig material); greps for `localStorage/sessionStorage/document.cookie/postMessage/sendBeacon/console.log` across `src/` return only theme persistence (`theme.ts:24,38` — stores theme name, nothing else) and unused shadcn scaffold (`chart.tsx`, `sidebar.tsx`, not imported anywhere).
- **Fragment handling in routing is correct** — key read once via `window.location.hash.slice(1)` (r.$pin.tsx:79), never placed in query params, fetch URLs, or TanStack router `params`; navigation on create/join passes the fragment via the `hash` option (index.tsx:53,83), which stays browser-side. `robots: noindex` set on the room route (r.$pin.tsx:29). OG/meta tags contain no URL or fragment.
- **XSS: solid.** No `dangerouslySetInnerHTML`/`innerHTML` in any shipped component (only unused scaffold). `linkify.ts` matches only `https?://` prefixes, then re-parses with `new URL()` and allowlists `http:`/`https:` protocols (linkify.ts:26-27) — `javascript:`, `data:`, and scheme-smuggling payloads cannot produce a link token; chat.tsx:32-33 renders with `rel="noopener noreferrer"`. linkify.test.ts actively tests `javascript:alert(1)`, `data:text/html`, and `<img onerror>` payloads.
- **No `alert()/confirm()/prompt()`** — grep clean (hits are only in test payload strings).
- **PIN entropy is real** — `crypto.getRandomValues` (CSPRNG) with correct rejection sampling: `limit = floor(2^32 / 900000) * 900000` avoids modulo bias (pin.ts:20-32); range is exactly 100000–999999 (900,000 values); leading-zero exclusion is deliberate and *consistent* between client `isValidPin` and Worker `PIN_PATTERN` (the socket-route regex inconsistency is Phase 1's finding, not an entropy issue). Tests verify validity at scale, spread, and the rejection-sampling boundary.
- **Rate limiter genuinely enforces** — traced end-to-end: `checkJoinAllowed` → `evaluate` returns `allowed:false` past 10 attempts in-window with escalating backoff (60s→1h cap), and index.ts:106-112 returns HTTP 429 with `retryAfterSeconds`. Join errors are deliberately generic (index.ts:120-123), no room-existence leak on this path.
- **Secrets hygiene** — no `.env*` files in the tree; `.gitignore` covers `.dev.vars`, `*.local`, `.wrangler/`; ticket secret is a wrangler secret, not a var. `pnpm audit --prod`: no known vulnerabilities. (Worker package's only dependency is wrangler itself.)
- **Zero-storage claim holds for message content** — DO keeps only sockets, attachments (random UUID + timestamp), seq counter, and deadlines; `deleteAll()` on alarm. No message bytes are ever persisted server-side (file chunks under R2 are ciphertext-only; the DO-storage migration keeps that property).

## Security test coverage vs. spec Section 8 (honest accounting)

| Required security test | Status |
|---|---|
| Read plaintext from captured WS frame must fail | **Missing** (nothing exercises a real frame; protocol/crypto tests cover round-trip only) |
| Fetch object without valid signed URL must fail | **Missing** (no HTTP-level test of `/object/*` or ticket verification at all) |
| Brute-force join attempts must throttle | **Present-but-weak** — `rate-limit.test.ts` covers the pure `evaluate()` logic well, but nothing tests the HTTP route wiring (429, headers, KV read/write) |
| XSS payload in message body and filename must render inert | **Present** for message body (`linkify.test.ts`); **Missing** for filename (filenames render as plain text in React, but no test pins that contract) |

## Phase Verdict

The cryptography and key-handling design is the strongest part of the audit so far: AES-256-GCM with per-message random IVs, non-extractable keys, a fragment that verifiably never leaves the browser, protocol frames that carry only ciphertext, and active tests for tamper/IV/XSS cases. The gaps are all at the edges: no CSP or frame-protection headers at all (spec violation with real clickjacking exposure), the Worker's socket and ticket routes bypass the abuse controls that `/room/join` does enforce, tickets aren't single-use despite claiming to be, and the spec's security-test section is one-quarter implemented at HTTP level. **Verdict: needs minor fixes on the crypto core; has blocking issues on deployment-edge abuse controls and CSP** — the socket-oracle and CSP findings should land before any public deployment.
