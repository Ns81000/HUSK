# HUSK — Implementation Prompt (Session 3: Phases 3–6 + Final Summary)

You are continuing a phased fix of the Husk project (ephemeral E2E-encrypted
chat/file sharing; React + TanStack Start frontend, Cloudflare Workers + two
SQLite Durable Objects backend). Sessions 1–2 completed Implementation Phases
1 and 2 of `docs/audit/IMPLEMENTATION_PROMPT.md`.

## Read first, in full, before any code

1. `docs/audit/IMPLEMENTATION_PROMPT.md` — the original master prompt (Rules
   section and Phase definitions still apply verbatim).
2. `docs/audit/phase-3-reliability-races.md` through
   `docs/audit/phase-6-performance-testgaps.md` — ground truth for what is
   broken in your phases. Do not re-derive findings; if you disagree with one,
   say so explicitly in the phase log instead of silently ignoring it.
3. `docs/implementation/phase-1-log.md` and
   `docs/implementation/phase-2-log.md` — what already changed, including
   design decisions that affect your phases:
   - Files are stored as write-once 1 MiB rows (`file:<id>:<n>`) in the room
     DO; a `cancel` WS frame deletes a file's rows; the per-room budget is
     100 MB (`bytesUsed` counter, serialised through `fileOpQueue`).
   - Sockets require a one-time join token (`?jt=`, minted by the
     rate-limited `/room/join`, bound to IP, burned by the DO). The client's
     `RoomConnection` takes a `fetchJoinToken` handler and mints a fresh token
     before EVERY connect attempt; a refused join stops reconnecting.
   - SSR emits two inline scripts; `src/server.ts` hashes them per response
     into the CSP (`script-src 'self' 'sha256-…'`). If you add inline scripts
     (e.g. Phase 4 theme flash), the hash mechanism picks them up
     automatically — but verify hydration after.
   - Google Fonts is still referenced (style-src/font-src allowlisted) until
     your Phase 4 self-hosts Inter; tighten those CSP entries then.
   - Integration harness: `worker/tests/integration.test.ts` runs in workerd
     via `@cloudflare/vitest-pool-workers` (v0.22 plugin API). Tests use
     unique per-call `CF-Connecting-IP` values (the `pin:` rate-limit key is
     shared per PIN — do not exceed ~9 joins per test against one PIN).
     Alarm tests drive the real alarm via `runInDurableObject` +
     `runDurableObjectAlarm` (no test hooks in production code).
   - Root `pnpm test` runs two vitest projects: `node` (unit + render tests,
     includes `*.test.tsx`) and `workers`. `worker/` is its own pnpm project.

## Rules (unchanged from the master prompt)

- Work phases IN ORDER; each phase: implement → run the full relevant suites
  (`pnpm test`, `pnpm build`, `pnpm exec tsc --noEmit -p worker/tsconfig.json`,
  `pnpm exec tsc --noEmit -p tsconfig.json`, plus any manual verification the
  phase specifies) → hunt hard for new bugs your change introduced → write
  `docs/implementation/phase-N-log.md` (factual, concise) → only then move on.
- Never mark a phase complete with failing tests or unverified checks.
- pnpm exclusively. Stop and ask only for decisions requiring the user
  (credentials, real deployment, genuine tradeoffs).
- Prettier-formatted files are the norm in touched areas, but repo-wide lint
  was ALREADY failing before any of these phases (3967 pre-existing problems —
  never prettier-formatted). Do not fix repo-wide lint; only keep files you
  touch clean.
- No auto-generated docs/comments beyond what the code needs.

## Implementation Phase 3 — Reliability & Race-Condition Fixes

From `docs/audit/phase-3-reliability-races.md` (HIGH first). Where the audit
predates the join-token change, the token behaviour is the source of truth.

1. **Reconnect termination** (HIGH): when a server `closed` frame arrives the
   store applies a terminal state but the connection keeps reconnecting —
   dispose the connection (store.ts). Distinguish a refused join (token mint
   returns null — already stops connecting) from network blips; map a
   post-token handshake failure that repeats into `closed_not_found`; cap
   reconnect attempts (e.g. 10) into a visible terminal "Disconnected" state
   with a manual retry affordance (room-machine has terminal states; add a
   retry path in the store + UI affordance on the room screen).
2. **Per-message failure/retry** (HIGH): 10 s timeout with no `ack` flips
   `sending` → `failed`; implement `retry(id)` (reseal stored plaintext and
   resend via the same localId) and a retry affordance in `DeliveryNote`/
   chat UI. Buffered-but-unacked frames must resolve on flush.
3. **Receiver-side dedup** (MEDIUM): skip relay insertion when an entry with
   the same `localId` exists (store.ts); DO-side recent-`(socketId, localId)`
   resend filter (room.ts, bounded set, wiped on purge).
4. **`parseServerMessage` shape validation** (MEDIUM, protocol.ts): per-tag
   field validation, null on mismatch; surface repeated parse failures in the
   store (count + console/telemetry hook) instead of silent drops.
5. **Grace-window race** (MEDIUM): replace the single mutable `graceTimer` in
   store.ts with deadline data (per-leave timestamps); derive grace UI state
   from `participants.length` + `lastLeaveAt` in the render path.
6. Duplicate `leave` broadcast guard in `webSocketClose` (room.ts): skip if
   the socket is already gone from `getWebSockets()`.
7. Stale-write guard for late async decrypts (store.ts): capture pin/selfId
   before the await; verify room identity after before `set`.
8. Outbox cap (50 frames) + drop frames older than room expiry
   (connection.ts; expiry from the welcome frame's `expiresAt`).
9. Add the six Section 6 edge-case tests to the worker harness, named per the
   matrix rows in phase-6 (some exist: capacity, relay+ack, reconnect paths
   are client-side — add client-side unit tests where workerd cannot reach,
   e.g. store-level tests with a fake connection).

## Implementation Phase 4 — PWA, Frontend Runtime & Cross-Platform Fixes

From `docs/audit/phase-4-frontend-pwa.md`:

1. **PWA** (CRITICAL): `vite-plugin-pwa` — manifest (standalone, maskable +
   regular 192/512 icons from a token-colored SVG mark, theme/background from
   the palette), minimal precache SW (app shell only; NEVER cache anything
   from Worker routes — the SW lives on the frontend origin, Worker routes are
   cross-origin anyway), SW registration, offline banner driven by the
   connection store. Verify the built `_headers` still serves `/sw.js`,
   `/manifest.webmanifest` correctly.
2. **IME fix** (MEDIUM): `!event.nativeEvent.isComposing` in the composer's
   Enter handler (chat.tsx).
3. **Online/offline awareness** (MEDIUM): `window` online/offline listeners;
   on `online`, reset backoff and reconnect immediately; distinct "You are
   offline" status (ConnectionStatus or store field).
4. **Self-host Inter** (MEDIUM): woff2 in `public/fonts/`, `font-display:
   swap`, delete the Google Fonts preconnect/stylesheet from `__root.tsx`,
   and tighten CSP in `src/server.ts` + `_headers` (drop
   fonts.googleapis.com/fonts.gstatic.com; style-src may keep
   'unsafe-inline' only if still needed — check for inline styles first).
5. Port 404 and error screens in `__root.tsx` to Husk tokens + Button/Panel
   primitives (current classes reference nonexistent tokens).
6. Theme flash: pre-paint `dark` class (nonce'd or hashed inline script —
   coordinate with the CSP hash mechanism in server.ts; a static hash works
   since the theme script is constant).
7. Memoize message list items (`MessageItem`), auto-scroll only when already
   near-bottom (check scroll position before `scrollIntoView`).

## Implementation Phase 5 — Design System & Accessibility Compliance

From `docs/audit/phase-5-design-accessibility.md`:

1. AA contrast: light `warn` → ~`oklch(0.5 0.09 78)`, light `ink-faint` →
   ~`oklch(0.56 0.006 250)`, dark `ink-faint` bump; add a permanent vitest
   unit test computing oklch→sRGB contrast for every body-text token pair in
   both themes, asserting ≥ 4.5:1 (parse styles.css or mirror the palette in
   the test — pick one and keep it in sync-proof).
2. Modal focus management (primitives.tsx): trap Tab, restore focus to the
   invoker on close, close on scrim click.
3. `--scrim` token replacing the raw `bg-[oklch(0_0_0/0.45)]`.
4. Bless or snap off-scale spacing (`min-h-11`, `h-14`, `w-11`) — bless 44/56
   as named touch-target tokens is the defensible option.
5. `@axe-core/playwright` smoke specs: landing + PIN screens, both themes,
   zero violations (needs a running dev server; use `pnpm dev` or a static
   preview — document the command in the log; do not wire CI).

## Implementation Phase 6 — Performance, Test-Coverage Gaps & Final Hardening

From `docs/audit/phase-6-performance-testgaps.md`:

1. Verify Phase 1 streaming GET keeps CPU bounded: integration test with a
   10+ chunk file through the pool-workers harness (no 1102; the existing
   12-chunk byte-equality test is evidence — extend it with timing/rows
   assertions if useful, or document it as sufficient).
2. Missing unit tests: `orderedEntries` (out-of-order, ties, system messages)
   and seq-order rendering under out-of-order relays (store-level).
3. Confirm remaining Section 8 rows are green (phase-6 matrix is the
   checklist); anything still Missing from phases 1–5 gets written here.
4. Run live Lighthouse against a served build (desktop + mobile), record
   scores + the font fix's effect in the log. If headless Chrome is
   unavailable, run `pnpm dlx lighthouse` against `wrangler dev` of the
   built `.output` — if that is impossible in the environment, do a
   build-output analysis like the audit did and SAY SO in the log.

## Final Step

After Phase 6's log: produce `docs/implementation/SUMMARY.md` — every change
across all six phases, current test status (exact counts), and exact Free-plan
deploy commands: SQLite DO migration (already `new_sqlite_classes` v1),
`wrangler secret put HUSK_TICKET_SECRET`, `ALLOWED_ORIGINS`,
`wrangler deploy` from `worker/`, frontend `pnpm build` with
`VITE_WORKER_URL` set, redeploy, then the spec Section 8 manual QA checklist
(desktop create / mobile join / messages both ways / file both ways /
background >8s / host force-close / confirm no server-side trace after close)
as a fill-in record.
