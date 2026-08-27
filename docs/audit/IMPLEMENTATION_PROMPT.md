# HUSK — Implementation Prompt (Session 2: Fix, Test, Log — Phase by Phase)

You are implementing fixes for the Husk project based on a completed paranoid audit.
Read every file in `docs/audit/phase-1-*.md` through `docs/audit/phase-6-*.md` FIRST,
in full, before writing any code. These are your ground truth for what's broken —
do not re-derive findings from scratch or second-guess them without new evidence;
if you disagree with a finding, say so explicitly in your phase log rather than
silently ignoring it.

## Rules
- Work through the implementation phases below IN ORDER. Do not start phase N+1
  until phase N's log file exists and its tests pass.
- For each phase: implement the fix(es) -> run the full relevant test suite
  (`pnpm test`, `pnpm build`, `pnpm exec tsc --noEmit -p worker/tsconfig.json`,
  and any manual verification steps the phase specifies) -> hunt HARD for new bugs your
  own change might have introduced, specifically re-testing every edge case listed
  in the original spec's Section 6 that touches the area you just changed ->
  write `docs/implementation/phase-N-log.md` documenting exactly what changed,
  what you tested, what passed/failed, and any residual risk -> only then move on.
- Be token-efficient: don't re-read whole files you already have open in context
  from a prior step in the same phase; use targeted diffs/greps; keep log files
  factual and concise, not narrated.
- If a fix requires a decision only the user can make (e.g., Cloudflare account
  credentials, actual deployment, choosing between two valid tradeoffs), STOP and
  ask — don't guess and don't silently pick one.
- Never mark a phase complete if any test is failing or any manual check is unverified.
- Package manager is pnpm exclusively. Never `npm install` / `pip install`.

## Implementation Phase 1 — R2 Removal / SQLite Durable Object Storage Migration (BLOCKING)

The project cannot deploy to the Workers Free plan as configured (KV-backed DO class,
R2 binding, and the KV namespace ID in `worker/wrangler.toml:27` is still the literal
placeholder `PASTE_KV_NAMESPACE_ID_HERE`). File download is also broken outright today
(client fetches `/room/<pin>/object/<key>`, which no Worker route serves, and ignores
the signed `downloadUrl`). Implement the full "R2 Removal Plan" section of
`docs/audit/phase-1-backend-architecture.md` (end of file) exactly:

1. `worker/wrangler.toml`: remove `[[r2_buckets]]`; switch the DO migration to
   `new_sqlite_classes` (new class name + new migration tag if this was ever deployed;
   otherwise replace v1's `new_classes`); resolve or eliminate the KV placeholder
   (ask the user which they prefer: create a KV namespace, or move rate-limit counters
   into a second SQLite DO).
2. `worker/src/types.ts`: drop `R2Bucket`/`R2Object`; expand `DurableObjectStorage`
   (`delete(key)`, `list`, etc.). Remove `HUSK_FILES` from `Env`.
3. `worker/src/room.ts` + `worker/src/index.ts`: replace `/object/*` proxy and
   `/room/<pin>/upload-ticket` with the DO-routed chunk scheme from the plan —
   `POST /room/<pin>/file` (size validation, **membership check via live WebSocket
   in the DO — this also closes the unauthenticated-ticket finding**), per-chunk
   `PUT /room/<pin>/file/<fileId>/<n>?exp=&sig=` writing `file:<id>:<n>` rows
   (1 MiB ArrayBuffers, per-room byte budget), `GET /room/<pin>/file/<fileId>` that
   **streams rows through a pull-based ReadableStream** (never buffer the whole file
   server-side — Free-plan 10ms CPU budget, see phase-6 finding). Cancel-frame
   deletion of a file's rows; alarm `deleteAll()` is already the orphan cleanup.
4. Config: `MAX_FILE_BYTES` -> 25 MB in BOTH `worker/src/config.ts` and
   `src/lib/husk/config.ts`; add `MAX_ROOM_FILE_BYTES = 100 MB`.
5. `src/lib/husk/files.ts`: rewrite to stream — per-1MiB-chunk encrypt+PUT (no
   `parts`/`blobParts` accumulation), download reads the response `ReadableStream`
   chunk-wise and decrypts incrementally (never materialize more than ~2 chunks).
   Fix the download URL to the new route. Add upload failure UI: `onSendFile` in
   `src/routes/r.$pin.tsx` currently has no retry — add a failed state with retry.
6. Set up the integration test harness (`@cloudflare/vitest-pool-workers` in the
   worker workspace) — the migration's acceptance tests require it: real
   chunk-PUT/GET byte-equality, forged/expired/replayed ticket rejection, room file
   budget rejection, alarm purge asserts rows gone via `storage.list`.
7. Update `README.md` deployment steps (R2 and lifecycle-rule steps are gone;
   fix the `npx tsgo` verification commands; add `pnpm` everywhere; add
   `typecheck`/`test` scripts to `worker/package.json`).
8. Fix the PIN regex inconsistency (worker/src/index.ts:127,134 use `[0-9]{6}`;
   create/join use `[1-9][0-9]{5}`) — one shared constant.
9. Document the honest file-size ceiling: 25 MB/file, ~100 MB live files/room,
   ~5 GB account-wide (phase-1 capacity arithmetic section).

## Implementation Phase 2 — Critical & High Security Fixes

Every Critical/High finding from `docs/audit/phase-2-security-crypto.md`:

1. **CSP + security headers** (HIGH): nonce-based CSP coordinated with the TanStack
   Start SSR shell (audit which inline scripts it emits first — a naive
   `script-src 'self'` will break hydration), plus `frame-ancestors 'none'`,
   `X-Content-Type-Options: nosniff`, `referrer-policy: no-referrer`, in
   `src/server.ts` and a `_headers` for static assets. Verify the app still
   hydrates after tightening.
2. **WebSocket route abuse** (HIGH): apply the join rate-limit budget to
   `/room/<pin>/socket` per IP, and require the short-lived join token minted by a
   successful `/room/join` (design: join returns a one-time token, socket route
   consumes it). Keep the generic 404 on failure so no existence oracle survives.
3. **Ticket single-use** (HIGH): if Phase 1's membership-gated per-chunk tickets
   don't already make replay useless, add a one-time-use registry; in any case fix
   the false "single-use" claims in `README.md` and code comments to describe the
   actual guarantee.
4. **Editor telemetry** (MEDIUM): strip `src/lib/lovable-error-reporting.ts` from
   production builds (`import.meta.env.DEV` guard) or delete it and its call site
   in `__root.tsx`.
5. Add the missing security tests to the Phase 1 harness: captured-frame
   plaintext-absence, unsigned object GET 403, brute-force 429 wiring, XSS filename
   render test.

## Implementation Phase 3 — Reliability & Race-Condition Fixes

From `docs/audit/phase-3-reliability-races.md` (HIGH/MEDIUM first):

1. **Reconnect termination** (HIGH): dispose the connection when a server `closed`
   frame arrives (store.ts); distinguish a 404 socket handshake from a network blip
   and map it to `closed_not_found`; cap reconnect attempts (e.g. 10) into a visible
   terminal "Disconnected" state with manual retry.
2. **Per-message failure/retry** (HIGH): timeout (10s, no `ack`) flips `sending` to
   `failed`; implement `retry(id)` in the store and a retry affordance in
   `DeliveryNote`/chat UI. Buffered-but-unacked frames resolve on flush.
3. **Receiver-side dedup** (MEDIUM): skip relay insertion when an entry with the same
   `localId` exists; add DO-side recent-`(socketId, localId)` resend filter.
4. **`parseServerMessage` shape validation** (MEDIUM): per-tag field validation,
   null on mismatch; surface repeated parse failures instead of silently dropping.
5. **Grace-window race** (MEDIUM): replace the single mutable `graceTimer` with
   deadline data; derive grace UI state from `participants.length` + `lastLeaveAt`.
6. Duplicate `leave` broadcast guard in `webSocketClose` (skip if socket already
   gone from `getWebSockets()`).
7. Stale-write guard for late async decrypts (verify room identity before `set`).
8. Outbox cap (50 frames) + drop frames older than room expiry.
9. Add the six Section 6 edge-case tests (named per row) to the harness — this is
   also the spec Section 8 debt from phase 6.

## Implementation Phase 4 — PWA, Frontend Runtime & Cross-Platform Fixes

From `docs/audit/phase-4-frontend-pwa.md`:

1. **PWA** (CRITICAL): add `vite-plugin-pwa` — manifest (standalone, maskable +
   regular 192/512 icons generated from a token-colored SVG mark, theme/background
   colors from the palette), minimal precache SW (app shell only; never cache
   anything from the Worker routes), SW registration, and an explicit offline
   banner state driven by the connection store.
2. **IME fix** (MEDIUM): add `!event.nativeEvent.isComposing` to the composer's
   Enter handler (chat.tsx:240-245).
3. **Online/offline awareness** (MEDIUM): `window` `online`/`offline` listeners;
   on `online`, reset backoff and reconnect immediately; distinct "You are offline"
   status.
4. **Self-host Inter** (MEDIUM): woff2 in `public/fonts/`, delete Google Fonts
   preconnect/stylesheet from `__root.tsx` (required for the Phase 2 CSP too).
5. Port the 404 and error screens in `__root.tsx` to Husk tokens + primitives
   (current classes reference nonexistent tokens and render unstyled).
6. Theme flash: pre-paint `dark` class application (nonce'd inline script,
   coordinated with the Phase 2 CSP nonce story).
7. Memoize message list items (`MessageItem` component), auto-scroll only when
   already near-bottom.

## Implementation Phase 5 — Design System & Accessibility Compliance

From `docs/audit/phase-5-design-accessibility.md`:

1. Fix AA contrast: darken light-theme `warn` (~oklch(0.5 0.09 78)) and `ink-faint`
   (~oklch(0.56 0.006 250)), dark `ink-faint` bump; add the oklch->contrast script
   as a permanent vitest unit test asserting every token pair used for body text
   clears 4.5:1 in both themes.
2. Modal focus management: trap Tab, restore focus to the invoker on close,
   close on scrim click.
3. Add `--scrim` token for the modal backdrop (replace the raw `oklch` literal).
4. Bless or snap off-scale spacing (`min-h-11`, `h-14`, `w-11`).
5. Add `@axe-core/playwright` smoke specs: landing + PIN screens, both themes,
   zero violations.

## Implementation Phase 6 — Performance, Test-Coverage Gaps & Final Hardening

From `docs/audit/phase-6-performance-testgaps.md`:

1. Verify the Phase 1 streaming GET keeps CPU bounded (integration test with a
   10+ chunk file through `wrangler dev`/pool-workers; no 1102).
2. Add the missing unit tests: `orderedEntries` (out-of-order, ties, system
   messages) and seq-order rendering under out-of-order relays.
3. Confirm remaining Section 8 rows are green (the matrix in phase-6 is the
   checklist); anything still Missing from phases 1-5 gets written here.
4. Run live Lighthouse against `wrangler dev` (desktop + mobile profiles) and
   record scores + the font fix's effect in the log.

## Final Step
After Phase 6's log is written and all tests pass, produce a top-level
`docs/implementation/SUMMARY.md` listing every change made across all phases,
current test status, and exact commands to deploy to Cloudflare Workers on the
Free plan: create the SQLite DO class (`new_sqlite_classes` migration), resolve
rate-limit storage (KV ID or DO alternative — per the user's Phase 1 decision),
`wrangler secret put HUSK_TICKET_SECRET`, set `ALLOWED_ORIGINS`, `wrangler deploy`
from `worker/`, build the frontend (`pnpm build`, nitro -> Cloudflare), set
`VITE_WORKER_URL`, redeploy, then run the spec Section 8 manual QA checklist
(desktop create / mobile join / messages both ways / file both ways /
background >8s / host force-close / confirm no server-side trace after close)
and record the results.
