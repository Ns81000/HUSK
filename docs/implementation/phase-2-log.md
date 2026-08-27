# Phase 2 Log — Critical & High Security Fixes

## What changed

### 1. CSP + security headers (HIGH)

- `src/server.ts` — every response now gets `X-Content-Type-Options: nosniff`,
  `Referrer-Policy: no-referrer`, `X-Frame-Options: DENY`; HTML responses get
  a full `Content-Security-Policy`:
  `default-src 'self'; script-src 'self' <per-response hashes>; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self' <WORKER_URL + wss:>; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`.
- **Design note (why hashes, not nonces):** the SSR shell emits exactly two
  inline scripts per page (TanStack's `$tsr` stream barrier and its scroll
  restoration bootstrap). The framework exposes a router-level `ssr.nonce`
  option, but `getRouter()` receives no request, so a per-request nonce cannot
  reach the router without a global that races across concurrent requests.
  Instead `server.ts` buffers each HTML response, computes SHA-256 of every
  inline script it contains, and emits those hashes — per response, so
  dehydrated-state differences between pages are handled.
- `public/_headers` (new) — nosniff/referrer/frame-opts for static files plus
  asset cache-control merge. CSP deliberately NOT set here: browsers intersect
  multiple CSP headers, and the static-file CSP would also have applied to
  SSR responses in some setups, breaking hydration.
- `connect-src` includes `VITE_WORKER_URL` and its `wss:` twin (read from
  `import.meta.env` at server build, mirroring the client bundle).
- **Verified empirically:** served the production build under `wrangler dev`,
  fetched `/` and `/r/123456`, recomputed sha256 of every inline script in
  the served HTML — both pages: every inline script COVERED by a hash in the
  emitted CSP (2/2 on each page). Script hashes are content-derived, so any
  future inline script fails closed (blocked) rather than open.

### 2. WebSocket route abuse (HIGH)

- `/room/join` now returns `{ ok, pin, joinToken }` — a one-time token:
  HMAC(`join`, `pin|ip|exp`) + expiry, TTL 60 s (worker/src/config.ts:
  `JOIN_TOKEN_TTL_SECONDS`), bound to the caller's IP.
- The socket route requires `?jt=<token>`; the room DO verifies the signature
  and **burns it** (`jt:<sig>` row in room storage, purged with the room) as
  part of the upgrade — token check and accept cannot interleave inside the
  single-threaded DO.
- Design deviation from the audit sketch (documented): the audit suggested
  also applying `checkJoinAllowed` on the socket route. That would double-burn
  the join budget on every reconnect (token mint + socket connect), halving
  the effective reconnect allowance. Instead, since a socket connect is now
  impossible without burning a successful, already-rate-limited join, the
  socket route *inherits* the join throttle — every connect costs exactly one
  join attempt. Probing `/socket` without a token yields the identical generic
  404 as a nonexistent room: **no existence oracle survives**.
- Client: `RoomConnection` now takes a `fetchJoinToken` handler and mints a
  fresh token before *every* connect attempt (initial + each reconnect); a
  refused join (room gone/full/throttled) stops reconnecting with a closed
  status instead of retrying forever. The store wires `fetchJoinToken` to
  `joinRoom` from api.ts. `src/routes/index.tsx` adapts to the new
  `JoinResult` shape.
- Note: "room full" is no longer distinguishable by clients (the 403 collapse
  into generic 404 at `/room/join` now also covers the socket path). This is
  the spec's Section 5 no-leak rule applied consistently; the `closed_full`
  state remains reachable via the in-room `error` frame, which only occurs
  for races after a successful join.

### 3. Ticket single-use (HIGH)

- Done in Phase 1 (write-once chunk rows; replay = 409) — this phase verified
  no false "single-use" claims remain: README was rewritten in Phase 1 with
  the honest guarantee; the only remaining "single-use" wording (tickets.ts
  header) describes the actual mechanism. The download capability is scoped
  to one fileId, expires with the room, and travels only inside the encrypted
  message body — documented there.

### 4. Editor telemetry (MEDIUM)

- `src/routes/__root.tsx` — `reportLovableError` moved behind
  `import.meta.env.DEV` via dynamic import; **verified** the production
  bundle contains zero occurrences of `__lovableEvents` (grep of
  `.output/public/assets/`). The module still exists for Lovable preview
  debugging, but cannot ship to production.

### 5. Security tests added (integration harness)

- Socket without token / forged token / nonexistent room → identical generic
  404 (oracle check, including response-body equality).
- Join-token replay → second connection refused 404 after a first 101.
- Brute-force joins → HTTP 429 with positive `retryAfter` after the budget.
- Captured relay frame → asserted to contain only the six allowed fields
  (no plaintext, no key material, no extra channels).
- XSS filename render contract (`src/components/husk/chat.render.test.tsx`) —
  four payloads (`<script>`, `<img onerror>`, quote-breakout, mixed filename)
  rendered via `renderToStaticMarkup`; asserts no raw `<script`/`<img`, and
  that the payload appears only as escaped text. (Uses react-dom/server, so
  no jsdom dependency was added.)
- "Unsigned object GET 403" already landed in Phase 1 as "rejects an unsigned
  file GET" (the `/object/*` route no longer exists; this is its successor).

## Test status

- `pnpm exec tsc --noEmit -p worker/tsconfig.json` — pass
- `pnpm exec tsc --noEmit -p tsconfig.json` — pass
- `pnpm test` — **55/55 pass** (38 node unit/render tests + 17 workerd
  integration tests; 4 tests added this phase, 3 adapted for the token flow)
- `pnpm build` — pass
- CSP verification (documented above) — PASS on `/` and `/r/<pin>`

## Edge cases re-tested (spec Section 6 areas touched)

- Simultaneous join at capacity — now asserted with a valid minted token at
  the DO boundary (403), while public untokenized probes get generic 404.
- Reconnect after network drop — client now re-joins (rate-limited) per
  reconnect; a refused join terminates the loop (foundation for Phase 3).
- Background >8 s / device sleep — reconnect path exercises the same token
  mint; budget of 10 joins/5 min per IP+PIN bounds reconnect storms.

## Residual risk

- Inline-script hashing depends on `server.ts` seeing the final HTML; if a
  future framework change streams the document in chunks, buffering stays
  correct (whole body is read) but adds a full-document buffer per response
  (small pages only; acceptable).
- The `style-src 'unsafe-inline'` remains until Phase 4 self-hosts Inter and
  the Google Fonts allowlist entries can be dropped.
- `getRouter()`-level nonce support would be cleaner than hashing; revisit if
  TanStack Start ever passes the request into the router entry.
- Lint repo-wide remains red (pre-existing baseline; touched files clean).
