# HUSK — Implementation Summary (Phases 1–6)

Ephemeral, end-to-end encrypted chat and file sharing. React + TanStack Start
frontend (SSR, deployed to Cloudflare via nitro); Cloudflare Workers + SQLite
Durable Objects relay. Every phase has a detailed log next to this file; the
audit findings they answer live in `docs/audit/`.

## Phase 1 — R2 removal / SQLite Durable Object storage (phase-1-log.md)

- `worker/wrangler.toml`: R2 bucket and the KV placeholder removed; single
  `v1` migration with `new_sqlite_classes = ["HuskRoom", "HuskGatekeeper"]`.
- New `HuskGatekeeper` DO (single `idFromName("gate")` instance) holds join
  rate-limit records in SQLite; `checkJoinAllowed` **fails closed** if the
  gate is unreachable. Pure `evaluate()` logic unchanged.
- Files are stored as write-once 1 MiB chunk rows (`file:<id>:<n>`) in the
  room's own SQLite DO storage: grant gated on **live membership**
  (`getWebSockets()` + attachment id), per-room 100 MB byte budget with a
  serialized read-check-write, per-chunk HMAC tickets (`chunk` operation),
  streamed GET through a pull-based `ReadableStream` (one row per pull — never
  buffered server-side), cancel-frame cleanup with budget refund, and alarm
  `deleteAll()` purge on room closure.
- `MAX_FILE_BYTES` 100→25 MB in both configs; `MAX_ROOM_FILE_BYTES` = 100 MB;
  `FILE_CHUNK_BYTES` = 1 MiB; one canonical PIN regex for all routes.
- Client uploads/decrypts incrementally (no whole-file buffering), carries the
  download capability only inside the encrypted file message, and shows
  upload-failure UI with Retry; cancel on failure refunds storage.
- README rewritten (honest capacity limits; R2/KV setup removed).

## Phase 2 — Critical & high security fixes (phase-2-log.md)

- `src/server.ts`: per-response hashed inline-script CSP plus
  `frame-ancestors 'none'`, `X-Content-Type-Options: nosniff`,
  `Referrer-Policy: no-referrer`, `X-Frame-Options: DENY`; static security
  headers in `public/_headers` (hashes, not nonces — rationale in the log;
  superseded-fragility fixed in Phase 5 below).
- Socket route requires a one-time, rate-limited, IP-bound join token
  (60 s TTL, HMAC over `pin|ip|exp`, burned inside the DO upgrade). Replay and
  untokenized probes get the identical generic 404 — no existence oracle.
- Production builds exclude Lovable telemetry (verified: zero `__lovableEvents`
  occurrences in `.output`).
- Security tests added to the workerd harness: frame-contents allowlist, join
  throttling (HTTP 429 + `retryAfter`), token replay, unsigned file GET, and
  the filename XSS render contract (`chat.render.test.tsx`).

## Phase 3 — Reliability & race conditions (phase-3-log.md)

- Reconnect lifecycle terminates: refused joins → terminal
  `join_refused_unavailable` / `join_refused_rate_limited`; repeated failed
  handshakes (3) and a bounded attempt budget (10, stability heuristic 10 s)
  end in `closed_disconnected` with a Reconnect button.
- Per-message failure: 10 s ack timeout flips `sending` → `failed`;
  `retryMessage(id)` reseals the stored plaintext and resends under the same
  localId (DO dedup + own-relay resolution keep working); on reconnect,
  buffered-but-unacked entries get a fresh ack window.
- Deduplication at both ends: store-level `seenRelays` registered **before**
  the async decrypt; DO-side bounded `recentSends` map resends ack with the
  original seq without re-relaying.
- Malformed server frames are shape-validated per tag and counted
  (`malformedCount` + `console.warn`), never dropped silently.
- Grace window is deadline data (`lastLeaveAt`), late decrypts are
  stale-guarded, duplicate close broadcasts deduped (via close-seen set —
  the audit's membership check was proven wrong under hibernation by test),
  outbox capped (50 frames, oldest dropped) with welcome-expiry pruning.

## Phase 4 — PWA, frontend runtime & cross-platform (phase-4-log.md)

- **PWA:** `vite-plugin-pwa` deliberately NOT adopted (its workbox
  `navigateFallback` app-shell model is incompatible with per-request TanStack
  Start SSR — no static `index.html` exists). Instead a hand-authored
  `public/sw.js`: versioned caches (`husk-shell-*`, `husk-bundles-*`), install
  precaches exactly the static shell (`/`, manifest, favicon, robots, icons,
  Inter woff2), activate purges + `clients.claim()`; GET-only, same-origin-only
  fetch policy with explicit `/room/` + `/api/` never-cache guards; only `/`
  navigations handled (network-first with cached-shell fallback); `/r/<pin>`
  always network-only; `/assets/*` cache-first with fill-on-miss. Registration
  in `RootComponent`, production-only, non-fatal.
- `public/manifest.webmanifest`: standalone, `id`/`start_url`/`scope` `/`,
  theme/background `#f6f7f8`, regular + maskable 192/512 PNGs + SVG mark.
- Inter v20 variable latin subset self-hosted (`public/fonts/inter-latin.woff2`
  - full OFL 1.1 `OFL.txt`), `font-display: swap` with latin unicode-range;
    Google Fonts removed everywhere (no CSP allowlist entries remain).
- IME: Enter submit extracted to exported `shouldSubmitOnEnter`
  (`isComposing`-aware); pinned by 5 tests.
- Online/offline: store actions `notifyOffline()`/`notifyOnline()`; window
  listeners registered only when `window` exists; `notifyOnline` resets
  backoff, reconnects immediately, and auto-recovers a room that reached
  terminal `closed_disconnected`; initial value `navigator.onLine !== false`;
  UI distinguishes offline from reconnecting. 3 store tests.
- Theme flash: constant pre-paint `themeBootstrap` inline script applies
  `dark` before paint (every inline script is covered by the per-response CSP
  hashes; see Phase 5 for the NUL subtlety).
- Memoized `MessageItem` + near-bottom-only auto-scroll (120 px threshold).

## Phase 5 — Design system & accessibility (phase-5-log.md)

- **CRITICAL regression found and fixed (`src/server.ts`):** TanStack Start
  serializes literal U+0000 characters into the `$tsr-stream-barrier` inline
  script; the WHATWG tokenizer replaces NUL with U+FFFD, so the browser-
  executed script text never matched the Phase 2 hash CSP computed from raw
  response bytes — **production hydration has been broken (blank pages) since
  Phase 2**, invisible to the earlier "hash coverage" checks. Fix:
  `stabilizeInlineScriptBytes()` re-encodes each NUL as the lossless JS escape
  `\u0000` before hashing and emitting. Verified in Chromium: hydration
  completes, zero CSP violations. Long-term path (documented residual):
  `ssr.nonce`-based CSP.
- **AA contrast:** light `--warn` → `oklch(0.5 0.09 78)`; light `--ink-faint` →
  `oklch(0.535 0.006 250)` (deliberate deviation from the audit's ~0.56
  sketch, which computes 4.33:1 on canvas; 0.535 gives ≥4.53 on all four
  surfaces); dark `--ink-faint` → `oklch(0.64 0.005 250)` (worst pair 4.83 on
  `surface-raised`).
- **Permanent CI gate:** `src/lib/husk/contrast.test.ts` (5 tests) parses
  `:root`/`.dark` out of `src/styles.css` itself, converts oklch → linear
  sRGB, and asserts ≥4.5:1 for all body/caption foreground tokens on all four
  surfaces in both themes, plus `accent-ink` on `accent`/`accent-hover`; a
  third test pins the three fixed values.
- **Modal focus management** (`primitives.tsx`): Tab trapped with wrap at both
  ends and out-of-dialog focus pulled back; focus restored to the invoker on
  dismissive close (Escape/scrim — confirming genuinely leaves the room, so
  restore is scoped to dismissive closes); Escape cancels through a
  `cancelRef`; scrim click closes (panel stops propagation).
- **`--scrim` token:** `--scrim: oklch(0 0 0 / 0.45)` (both themes), mapped as
  `--color-scrim`; modal backdrop uses `bg-scrim` (raw literal removed).
- **Spacing:** blessed named touch tokens `--spacing-touch: 44px` /
  `--spacing-touch-lg: 56px` in `@theme inline`; all off-scale numeric hits
  replaced (`min-h-touch`, `h-touch-lg`, `w-touch`); no untracked off-scale
  spacing remains in shipped Husk components.
- **Axe/E2E harness:** `@playwright/test` + `@axe-core/playwright`;
  `playwright.config.ts` serves the real production nitro output under
  wrangler/workerd on 8787; `.env.a11y` + `build:a11y` bake the app's own
  origin as `VITE_WORKER_URL`; `pnpm test:a11y` = build + Playwright
  (deliberately not part of `pnpm test`). `e2e/a11y.spec.ts`: zero axe
  violations (`wcag2a/2aa/21a/21aa`) on landing, PIN-entry, and room screens
  in both themes. `e2e/modal.spec.ts`: 6 specs driving the real Modal in the
  real app (relay intercepted via `page.route`/`routeWebSocket`): Tab trap,
  wrap at both ends, Escape/scrim close with focus restoration, axe-clean
  open-modal state. The harness caught and fixed two extra defects:
  `PinDisplay`'s `aria-label` on a bare `<div>` (now `role="group"`) and the
  `sr-only` file input's missing accessible name (now
  `aria-label="File to send"`).
- Incidental: `public/_headers` comment block converted from invalid `/* … */`
  to `#` lines (wrangler had warned about 4 invalid rules on every serve).

## Phase 6 — Performance verification, test gaps & final hardening (phase-6-log.md)

- Streaming-GET CPU bound proven: the 11 MiB / 12-chunk workerd round-trip now
  reads the GET through the pull-based stream reader and asserts byte equality
  **chunk-wise** (every 1 MiB row vs its uploaded slice); completing the
  round-trip with zero mismatches is the "no Worker exceeded CPU time (1102)"
  evidence. Local workerd does not meter CPU (the `cpu_ms = 1` experiment
  passes identically), and the live deploy confirmed the Free-plan API rejects
  declaring `[limits] cpu_ms` at all (error 100328) — the block was removed;
  the Free plan applies its 10 ms default server-side without declaration.
- Ordering tests added (was the audit's Missing row): `orderedEntries`
  out-of-order / seq-tie-ts-break / system-messages unit tests, plus a
  store-level test that out-of-order relays render in server seq order via the
  `createRoomStore(spawnConnection)` injection seam (the exact function
  `chat.tsx` renders through). 4 new tests.
- A pre-existing latent flake (fixed-10-turn `flushDecrypt` vs thread-pool
  WebCrypto) was found, root-caused, and hardened; 8 consecutive full-suite
  runs green afterwards.
- Section 8 coverage matrix walked row by row with evidence — see the table
  in phase-6-log.md. Every row is Present except the manual QA pass
  (not executable without deployment credentials; checklist below) and a
  partially-automated keyboard-only navigation row.
- Live Lighthouse 13.4.1 against the production build served under
  workerd: `/` mobile 97 / desktop 100, `/r/123456` mobile 96 / desktop 100,
  accessibility 100 everywhere, TBT 0 ms, CLS ≈ 0; zero non-local requests
  (the Phase 4 Inter self-hosting fix measured, not estimated). Full method
  and tables in phase-6-log.md.

## Current test status (exact counts, all passing at this commit)

| Command                                          | Result                                                                                      |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------- |
| `pnpm test`                                      | 14 files, **104/104** (includes the 19 workerd integration tests via the `workers` project) |
| `cd worker && pnpm test`                         | **19/19**                                                                                   |
| `pnpm exec tsc --noEmit -p tsconfig.json`        | pass                                                                                        |
| `pnpm exec tsc --noEmit -p worker/tsconfig.json` | pass                                                                                        |
| `cd worker && pnpm typecheck`                    | pass                                                                                        |
| `pnpm build`                                     | pass (production `.output` contains no a11y-mode worker URL)                                |
| `pnpm test:a11y`                                 | **12/12** (6 axe + 6 modal E2E, production build under workerd)                             |

## Cloudflare Workers Free-plan deployment (exact commands — verified live)

**Deployed 2026-08-28 (Free plan):**

- Relay: https://husk.ns8pc1.workers.dev
- Frontend: https://ns81000-husk.ns8pc1.workers.dev
- Secret `HUSK_TICKET_SECRET` set (64-hex random, generated at deploy time).
- Verified live: create → 200 `{ok:true}` with the correct
  `access-control-allow-origin` for the frontend origin; disallowed origins
  get **no** ACAO; join → 200 with joinToken; frontend `/` → 200 with the
  hashed inline-script CSP.

Both DO classes are SQLite-backed via the single `v1` /
`new_sqlite_classes` migration (applied on first deploy); rate limits live in
the `HuskGatekeeper` SQLite DO — no KV, no R2, no payment method.

```powershell
# 1. Relay Worker (from worker/ — applies the v1 SQLite DO migration).
cd worker
pnpm exec wrangler deploy          # -> https://husk.<subdomain>.workers.dev

# 2. Ticket-signing secret (interactive; paste a long random string).
pnpm exec wrangler secret put HUSK_TICKET_SECRET

# 3. Frontend build with the relay URL baked in (shell env, not a file), so
#    the CSP connect-src and the client's API calls point at the relay.
cd ..
$env:VITE_WORKER_URL = "https://husk.<subdomain>.workers.dev"
pnpm build

# 4. Frontend deploy. IMPORTANT wrangler quirks discovered on the live deploy:
#    - run the worker package's wrangler FROM THE REPO ROOT (nitro writes
#      <root>/.wrangler/deploy/config.json pointing at
#      .output/server/wrangler.json); running inside worker/ hits a
#      "both a user configuration file and a deploy configuration file" error.
#    - nitro stamps the build date into .output/server/wrangler.json as
#      compatibility_date, which the pinned wrangler may reject as "in the
#      future" — override it on the CLI:
worker\node_modules\.bin\wrangler.cmd deploy --compatibility-date 2025-01-01

# 5. Wire the origins: put the frontend URL in worker/wrangler.toml
#    [vars] ALLOWED_ORIGINS (comma separated, no trailing slash) and redeploy
#    the relay (step 1). Note: a relay deploy from worker/ fails while
#    <root>/.wrangler/deploy/config.json exists (frontend-build artifact) —
#    delete it first; the next frontend build regenerates it.
```

Gotchas found on the live deploy (all resolved in-repo):

- A `[limits] cpu_ms = 10` block is **rejected by the Free-plan API**
  (error 100328: "CPU limits are not supported for the Free plan") — removed
  from `worker/wrangler.toml`; do not re-add it on Free.
- One room created seconds after a redeploy did not persist (its re-create
  returned `ok:true` instead of 409), i.e. the create response committed but
  the DO write was lost during deployment churn. Not reproducible after the
  deploy settled (two fresh create→join round-trips verified deterministic);
  watch for it if you redeploy while users are creating rooms.

## Spec Section 8 manual QA checklist (run after first deployment)

To be completed by the deployer — this environment has no credentials. Each
row lists what to exercise and the expected result.

| #   | Scenario                         | Steps                                                                                    | Expected                                                                                                                      | Result |
| --- | -------------------------------- | ---------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- | ------ |
| 1   | Desktop create                   | Desktop browser, create a room, copy/share the link                                      | Room opens, share block shows the full link with key fragment                                                                 | ☐      |
| 2   | Mobile join                      | Second device (or mobile emulation), open the link, enter the 6-digit PIN on the keypad  | Room joins; both sides see 2 participants                                                                                     | ☐      |
| 3   | Messages both ways               | Exchange messages in both directions                                                     | Delivered on both sides, ordering by seq consistent, delivery resolves `sending` → `sent`                                     | ☐      |
| 4   | File both ways                   | Send a file each way (also try >25 MB for the error path) and download on the other side | Success: byte-identical download; >25 MB rejected with the size error; failure path shows the upload-failed banner with Retry | ☐      |
| 5   | Background >8 s                  | Background one tab / lock the screen >8 s, return                                        | "Reconnecting" during the drop, automatic reconnect, no duplicate bubbles, unacked sends go `failed` with Retry               | ☐      |
| 6   | Host force-close                 | Close the host tab without leaving                                                       | Peer enters the grace window ("peer may be reconnecting"), then the "participant left" system note                            | ☐      |
| 7   | No server-side trace after close | After room closure, retry join and stored-file GET                                       | Both 404; DO storage purged by the alarm                                                                                      | ☐      |
| 8   | Keyboard-only walkthrough        | Tab through create → keypad → composer → file attach → modal; Escape/scrim               | All flows operable; modal traps and restores focus                                                                            | ☐      |
| 9   | Offline / install                | Toggle offline; install the PWA                                                          | Offline banner distinct from "Reconnecting"; landing shell loads offline; room pages never served stale                       | ☐      |
| 10  | IME                              | Compose with a CJK IME, press Enter mid-composition                                      | Composition commits; nothing sends until Enter after commit                                                                   | ☐      |

## Carried residuals (documented, deliberate)

- `worker/src/room.ts` polls its alarm every 60 s instead of scheduling only
  the next meaningful deadline. Functional, small constant cost.
- The outbox (50-frame cap) silently drops its oldest frame. The audit's
  suggested plaintext system note is impossible: unsent plaintext is not
  retained by design (only sealed ciphertext exists past the composer).
- Phase 5 CSP: the NUL→`\u0000` escape in `src/server.ts` is a verified
  mitigation of a TanStack Start serialization property, not an upstream fix.
  Cleaner long-term architecture is `ssr.nonce`-based CSP (plumbing confirmed
  present via TanStack/router#5511/#5522/#5870). Also recommended:
  `@tanstack/react-router` 1.170.18 → 1.170.32+.
- `theme-color` meta is statically light; a `media="(prefers-color-scheme:
dark)"` variant is cosmetic-only polish (Android status bar).
- PWA offline fallback serves the last-cached landing shell; room pages are
  never cached (deliberate). No custom `beforeinstallprompt` install UI.
- Axe coverage is bounded to landing / PIN-entry / room-no-key / open-modal
  room state in both themes; message-list-with-content, toasts, and remaining
  closed states are not swept.
- Keyboard-only navigation: automated where reachable (modal E2E); the full
  walkthrough is a manual QA row above.
- Local workerd does not meter CPU, so the streaming-GET CPU proof is the
  completing chunk-wise round-trip; the Free plan applies its 10 ms default
  server-side (declaring `[limits] cpu_ms` is rejected on Free — error 100328).
- Reconnect-after-network-drop has no real mid-stream socket-drop E2E; the
  lifecycle is pinned at unit/store level and server-side by token/throttle
  tests.
- Repository-wide lint has a pre-existing red baseline; touched files are
  Prettier-formatted and lint-clean individually. Not fixed repo-wide by
  design (would create massive diff noise).
