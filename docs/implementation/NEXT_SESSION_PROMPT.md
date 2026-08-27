# HUSK — Implementation Prompt (Session 6: Phase 6 only, then final summary)

You are continuing the phased hardening of the Husk project (ephemeral,
end-to-end encrypted chat and file sharing; React + TanStack Start frontend;
Cloudflare Workers + SQLite Durable Objects backend).

Implementation Phases 1–5 are complete and were re-tested immediately before
this hand-off. **This session's scope is Implementation Phase 6 only.** Phase 6
is the final phase: performance verification, remaining test-coverage gaps, and
the cross-phase summary. When Phase 6 is complete, write its log, produce the
top-level `docs/implementation/SUMMARY.md`, and commit all Phase 6 changes
plus the summary.

## Read these files FIRST, in full

Read every file below completely before writing code:

```text
C:\Users\Ns8pc\Pictures\HUSK\docs\implementation\NEXT_SESSION_PROMPT.md
C:\Users\Ns8pc\Pictures\HUSK\docs\implementation\phase-1-log.md
C:\Users\Ns8pc\Pictures\HUSK\docs\implementation\phase-2-log.md
C:\Users\Ns8pc\Pictures\HUSK\docs\implementation\phase-3-log.md
C:\Users\Ns8pc\Pictures\HUSK\docs\implementation\phase-4-log.md
C:\Users\Ns8pc\Pictures\HUSK\docs\implementation\phase-5-log.md

C:\Users\Ns8pc\Pictures\HUSK\docs\audit\IMPLEMENTATION_PROMPT.md
C:\Users\Ns8pc\Pictures\HUSK\docs\audit\phase-1-backend-architecture.md
C:\Users\Ns8pc\Pictures\HUSK\docs\audit\phase-2-security-crypto.md
C:\Users\Ns8pc\Pictures\HUSK\docs\audit\phase-3-reliability-races.md
C:\Users\Ns8pc\Pictures\HUSK\docs\audit\phase-4-frontend-pwa.md
C:\Users\Ns8pc\Pictures\HUSK\docs\audit\phase-5-design-accessibility.md
C:\Users\Ns8pc\Pictures\HUSK\docs\audit\phase-6-performance-testgaps.md
```

The audit files are the ground truth for the intended fixes. If current code
already addresses an audit item, verify it and record that fact; do not
duplicate it or silently omit it.

## Verified baseline before this hand-off

These commands were run successfully at the end of the Phase 5 session:

- `pnpm test` — 14 test files, **100/100 pass** (including the workerd project;
  95 prior + 5 new contrast tests).
- `cd worker && pnpm test` — **19/19 pass**.
- `pnpm exec tsc --noEmit -p tsconfig.json` — pass.
- `pnpm exec tsc --noEmit -p worker/tsconfig.json` — pass.
- `cd worker && pnpm typecheck` — pass.
- `pnpm build` — pass; production `.output` verified free of any a11y-mode
  worker URL (the `.env.a11y` build input only applies to `--mode a11y`).
- `pnpm test:a11y` — **12/12 pass**: the production build served under
  wrangler/workerd, axe zero-violation sweeps of the landing / PIN-entry /
  room screens in both themes, plus 6 modal E2E specs (Tab trap, wrap at both
  ends, Escape/scrim close with focus restoration) in both themes.

## What is already implemented and carried forward

### Phase 1 — backend/storage

- R2 and the KV placeholder were removed. `HuskRoom` and `HuskGatekeeper` use
  SQLite Durable Object migrations; rate limiting is fail-closed through the
  gatekeeper DO.
- Files use membership-gated grants, write-once 1 MiB chunk rows, per-room
  100 MB accounting, streamed GETs, cancel cleanup, and alarm purge.
- The client uploads and downloads incrementally, carries download capability
  only inside encrypted file messages, and shows upload failure/retry UI.
- `MAX_FILE_BYTES` is 25 MB in both configs; `MAX_ROOM_FILE_BYTES` is 100 MB.
- The workerd harness covers real file byte equality, forged/expired/replayed
  tickets, membership, budget, unsigned GET, cancel cleanup, alarm cleanup,
  capacity, PIN collision, and related security cases.

### Phase 2 — security

- SSR responses have hashed inline-script CSP plus `frame-ancestors 'none'`,
  `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, and
  static security headers in `public/_headers`.
- Socket connections require a one-time, rate-limited, IP-bound join token;
  replay and untokenized probes return generic failure responses.
- Production builds exclude Lovable telemetry. Security tests cover frame
  contents, join throttling, token replay, unsigned file GET, and filename XSS.

### Phase 3 — reliability

- Reconnect attempts terminate on refused joins, repeated failed handshakes,
  or the bounded retry budget; terminal `closed_disconnected` has a retry UI.
- Sending entries time out after 10 seconds, become `failed`, and can be
  retried under the same local ID. ACKs and buffered frames are covered by
  store/connection tests.
- Relay deduplication exists in both the client store and the DO, malformed
  server frames are shape-validated and counted, grace state is deadline data,
  late decrypts are guarded, close events are deduplicated, and outbox size/

### Phase 4 — PWA, frontend runtime & cross-platform

- **PWA plugin decision:** `vite-plugin-pwa` was deliberately NOT adopted
  (reasoning documented in `phase-4-log.md`): its workbox
  `navigateFallback`/app-shell model is incompatible with the TanStack Start
  SSR setup — the nitro `cloudflare-module` output has no static `index.html`,
  and every page (including `/`) is per-request SSR with dehydrated state, so
  a NavigationRoute serving a precached URL would be either broken or
  useless. The hand-off's sanctioned alternative was taken: a hand-authored,
  real service worker with an explicit precache list.
- `public/sw.js` — versioned caches `husk-shell-<CACHE_VERSION>` and
  `husk-bundles-<CACHE_VERSION>` (bump `CACHE_VERSION` to invalidate):
  - install precaches exactly: `/`, `/manifest.webmanifest`, `/favicon.ico`,
    `/robots.txt`, the five `/icons/*` files, `/fonts/inter-latin.woff2`;
    `activate` purges prior versions and `clients.claim()`s.
  - fetch policy: GET-only, same-origin only (the Worker relay — API,
    WebSocket, file chunks — is a separate origin in production and is never
    intercepted), plus explicit never-cache guards for `/room/` and `/api/`.
  - navigations: only `/` is handled — network-first, with the cached landing
    shell as offline fallback; `/r/<pin>` navigations and everything else are
    network-only; precached static assets are cache-first; `/assets/*`
    (content-hashed) is cache-first with fill-on-miss; all else passes
    through untouched.
- Registration: `RootComponent` in `src/routes/__root.tsx`, production-only
  (`import.meta.env.PROD` guard), non-fatal on failure.
- Manifest: `public/manifest.webmanifest` — standalone display,
  `id`/`start_url`/`scope` `/`, theme/background `#f6f7f8` (light `--canvas`
  token), regular + maskable 192/512 PNGs and `husk-mark.svg`.
  `public/_headers` keeps `/sw.js: no-cache`, `/assets` + `/fonts` immutable,
  `/icons` 7-day.
- Font: `public/fonts/inter-latin.woff2` — Inter v20 variable latin subset,
  weights 400–600, with the full SIL OFL 1.1 license in
  `public/fonts/OFL.txt`; declared by the `@font-face` in `src/styles.css`
  with `font-display: swap` and a matching latin unicode-range. No Google
  Fonts requests or CSP allowlist entries exist anywhere.
- IME: the Enter submit guard is the exported `shouldSubmitOnEnter` predicate
  in `src/components/husk/chat.tsx`, pinned by `chat.enter.test.ts` (5 tests).
- Online/offline: the room store exposes `notifyOffline()`/`notifyOnline()`;
  `window` `online`/`offline` listeners are registered inside
  `createRoomStore` (window-guarded, SSR/Node-safe; the default store is a
  page-lifetime singleton). `notifyOnline` resets the connection backoff,
  reconnects immediately, and — new in Phase 4 — auto-reconnects a room that
  reached terminal `closed_disconnected`. The initial value is
  `navigator.onLine !== false`. The UI distinguishes "You are offline —
  messages can't send while offline" from "Reconnecting"
  (`room-info.tsx`). Pinned by 3 store tests.
- Theme flash: the constant pre-paint `themeBootstrap` inline script in
  `RootShell` applies `dark` before paint; verified empirically that every
  inline script on `/` and `/r/<pin>` (3/3 on each) is covered by
  `src/server.ts`'s per-response CSP hashes.
- 404/error screens and message rendering (`memo`-ized `MessageItem`,
  near-bottom-only auto-scroll) were verified token-clean and intact.

### Phase 5 — design system & accessibility

- **AA contrast (fixed + pinned by CI):** light `--warn` → `oklch(0.5 0.09 78)`
  (canvas 5.65 / surface 6.08 / raised 5.99 / sunken 5.33), light
  `--ink-faint` → **`oklch(0.535 0.006 250)`** (canvas 4.81 / surface 5.17 /
  raised 5.09 / sunken 4.53 — a deliberate deviation from the audit's ~0.56
  sketch, which computes to only 4.33:1 on canvas), dark `--ink-faint` →
  `oklch(0.64 0.005 250)` (worst pair 4.83 on `surface-raised`).
- **Contrast test:** `src/lib/husk/contrast.test.ts` (5 tests) parses the
  `:root`/`.dark` blocks out of `src/styles.css` itself, converts oklch →
  linear sRGB, and asserts ≥4.5:1 for `ink`/`ink-muted`/`ink-faint`/`warn`/
  `danger`/`ok`/`info` on `canvas`/`surface`/`surface-raised`/
  `surface-sunken`, plus `accent-ink` on `accent`/`accent-hover`, in both
  themes; a third test pins the three fixed values. Disabled-state text is
  exempt (WCAG 1.4.3 inactive components).
- **Modal focus management** (`src/components/husk/primitives.tsx`): Tab is
  trapped in the dialog and wraps at both ends (and out-of-dialog focus is
  pulled back in); focus is restored to the invoking element on close via the
  open-effect cleanup; Escape cancels through a `cancelRef` (so a re-rendered
  `onCancel` never restarts the effect); scrim click closes (panel stops
  propagation). Confirming genuinely leaves the room, so focus-restore is
  contractually scoped to the dismissive closes (Escape/scrim).
- **`--scrim` token:** `--scrim: oklch(0 0 0 / 0.45)` (same both themes),
  mapped as `--color-scrim`; Modal backdrop is `bg-scrim` (raw oklch literal
  removed).
- **Spacing decision — BLESSED as named tokens:** `--spacing-touch: 44px` and
  `--spacing-touch-lg: 56px` in `@theme inline`; `touch-target` utility reads
  `var(--spacing-touch)`. All off-scale numeric hits replaced: composer
  `min-h-11` → `min-h-touch`, keypad `h-14` → `h-touch-lg` (×3), `PinDisplay`
  `h-14 w-11` → `h-touch-lg w-touch`, Switch track `w-11` → `w-touch`. No
  untracked off-scale spacing remains in shipped Husk components.
- **Axe/E2E harness:** `@playwright/test` + `playwright` + `@axe-core/playwright`
  (all at 1.62.x/4.13.0); `playwright.config.ts` serves the real production
  nitro output under wrangler/workerd on port 8787; `.env.a11y` +
  `build:a11y` (`vite build --mode a11y`) bake the app's own origin as
  `VITE_WORKER_URL`; `pnpm test:a11y` = `build:a11y && playwright test`
  (deliberately NOT part of `pnpm test`). `e2e/a11y.spec.ts`: zero axe
  violations (`wcag2a/2aa/21a/21aa`) on landing, PIN-entry (keypad) and
  room screens, light + dark (6 specs). `e2e/modal.spec.ts`: the real Modal
  driven through the real app with relay endpoints intercepted via
  `page.route`/`routeWebSocket` (6 specs). The harness found and the phase
  fixed two extra defects: `PinDisplay`'s `aria-label` on a bare `<div>` (now
  `role="group"`) and the `sr-only` file input's missing accessible name (now
  `aria-label="File to send"`).
- **CRITICAL regression fix (discovered by the harness, `src/server.ts`):**
  TanStack Start serializes literal U+0000 characters into the
  `$tsr-stream-barrier` inline script; the HTML tokenizer replaces NUL with
  U+FFFD (WHATWG parse-error rule), so the browser-executed script text never
  matched the Phase 2 hash-CSP computed from raw response bytes → the
  framework's hydration bootstrap was CSP-blocked and every page blanked
  after hydration, in every browser, since Phase 2. `stabilizeInlineScriptBytes()`
  re-encodes NUL as the lossless JS escape `\u0000` before hashing and
  emitting; verified in Chromium (hydration completes, zero CSP violations).
  Husk's own code is not the source of the NULs (no loaders, no
  `params.parse` — they are framework-internal dehydrated match IDs).
- **Incidental:** `public/_headers` comment block converted from `/* … */`
  (invalid in the `_headers` format; wrangler warned about 4 invalid rules on
  every serve) to `#` lines; the 7 real rules are unchanged.

### Manual/browser verification performed in Phase 4

- The built `.output/public` contains `sw.js`, `manifest.webmanifest`,
  `fonts/inter-latin.woff2`, `fonts/OFL.txt`, and all icons.
- `.output/server` was served with the worker's wrangler (workerd, local
  mode): all PWA static assets 200, `/r/<pin>` renders SSR 200, the socket
  route 404s as expected without a relay, and CSP hash coverage was 3/3
  inline scripts on both pages. Full details in `phase-4-log.md`.


## Known residuals that must not be falsely reported as fixed

- `worker/src/room.ts` still polls its alarm every 60 seconds rather than
  scheduling only the next meaningful deadline. Carry to Phase 6 (final
  hardening) unless the user explicitly expands Phase 6's scope.
- The outbox drops its oldest frame silently when capped; it does not create
  the audit's suggested plaintext system note because unsent plaintext is not
  retained. Preserve this as a documented residual for the final summary.
- **Phase 5 CSP residual:** the NUL→`\u0000` escape in `src/server.ts` is a
  verified mitigation of a TanStack Start serialization property, not an
  upstream fix. The cleaner long-term architecture is `ssr.nonce`-based CSP
  (`createStart` middleware + `getGlobalStartContext()` +
  `router.options.ssr.nonce`; nonce plumbing for the barrier script confirmed
  present in our versions via TanStack/router#5511/#5522/#5870). Out of Phase
  5 scope; Phase 6 may scope it or record it in the summary as future work.
  Also recommended hygiene: `@tanstack/react-router` 1.170.18 → 1.170.32+.
- **Axe coverage is bounded:** landing, PIN-entry, room-no-key screens and the
  open-modal room state, both themes. Not swept: message list with content,
  toasts, remaining closed states. Do not claim "every screen axe-clean" in
  the summary; claim exactly what `e2e/a11y.spec.ts` covers.
- `wrangler dev`/Cloudflare deployment has not been performed (no
  credentials); local serving used workerd via wrangler dev with
  `--compatibility-date 2026-08-01`, because nitro stamps the build date into
  `.output/server/wrangler.json` and the installed wrangler 4.126.0 rejects
  it as "in the future".
- Repository-wide lint has a pre-existing large failure baseline. Keep touched
  files formatted and clean; do not reformat the repository.
- PWA offline fallback serves the last-cached landing shell; room pages are
  never cached (deliberate). There is no custom install-prompt UI.
- The `theme-color` meta is statically light; a dark `media=` variant is
  optional polish, carried to Phase 6/summary as cosmetic-only.

## Rules

- Work on Phase 6 only. It is the final phase.
- Implement → run all relevant tests and checks → hunt for regressions → write
  `docs/implementation/phase-6-log.md` → produce
  `docs/implementation/SUMMARY.md` → commit the session's intended changes.
- Required verification before declaring Phase 6 complete:
  `pnpm test`, `pnpm build`, `pnpm exec tsc --noEmit -p tsconfig.json`,
  `pnpm exec tsc --noEmit -p worker/tsconfig.json`, and
  `cd worker && pnpm test`. Additionally `pnpm test:a11y` must stay green if
  anything touched could affect rendering.
- Use `pnpm` exclusively. Do not use `npm install` or `pip install`.
- Do not deploy or use credentials. Stop only for a decision that genuinely
  requires the user.
- Keep tests deterministic and focused. Add regression tests for behavior
  changed in this phase where a reliable seam exists.
- Keep touched files Prettier-formatted. Do not fix the repository-wide lint
  baseline or create unrelated diff noise.
- Kill any `wrangler dev`, `vite preview`, or workerd process you start; a
  leftover process can lock `.output` and break the next `pnpm build` on
  Windows. (Check with `Get-Process workerd` before rebuilding.)
- Before committing, inspect `git diff` and `git status`; stage only intended
  files. Do not amend or rewrite earlier commits, and do not push unless asked.


## Implementation Phase 6 — Performance, Test-Coverage Gaps & Final Hardening

Use `C:\Users\Ns8pc\Pictures\HUSK\docs\audit\phase-6-performance-testgaps.md`
as the source of the requirements (its Section 8 coverage matrix is the
checklist). Finish and verify all four items below:

1. **Streaming-GET CPU bound (HIGH verification):** prove the Phase 1
   streaming file GET keeps the Worker's CPU bounded — integration test with a
   10+ chunk file through the `@cloudflare/vitest-pool-workers` harness (and/
   or `wrangler dev` if needed); assert the full round-trip completes without
   the "Worker exceeded CPU time" (1102) class of failure. The harness in
   `worker/tests/` already round-trips real bytes; extend it to a >10 MiB
   multi-chunk file with byte equality asserted chunk-wise.
2. **Missing unit tests:** `orderedEntries` (src/lib/husk/store.ts) —
   out-of-order input, seq ties (ts tiebreak), and system messages; plus a
   store-level test that out-of-order `relay` frames render in seq order
   (`createRoomStore(spawnConnection?)` injection makes this seam testable
   without jsdom).

3. **Section 8 coverage matrix close-out:** walk the full matrix in
   `docs/audit/phase-6-performance-testgaps.md` row by row against the
   current suites (phases 1–5 added: workerd integration harness, security
   tests, XSS/filename render contract, IME tests, online/offline store
   tests, contrast gate, axe/Playwright E2E, modal E2E). Mark each row's
   status with evidence; anything still Missing or Present-but-weak gets a
   fix or an explicit residual-risk entry in `phase-6-log.md` with the
   reason. Known candidates: manual QA pass (see SUMMARY below),
   keyboard-only navigation (now partially covered by the modal E2E specs).
4. **Live Lighthouse:** run real Lighthouse against the served production
   build (`wrangler dev`/workerd serving `.output/server`, as in the
   a11y/Phase 4 setups) — desktop and mobile profiles — and record the
   scores plus the effect of the Phase 4 Inter self-hosting fix in the log.
   Chrome is already available via Playwright's chromium; if a Lighthouse
   runner cannot be wired in this environment, record exactly what was
   attempted and keep the residual honest (no estimates presented as
   measurements).

## Phase 6 definition of done

- Every Phase 6 item above is done and tested, or explicitly listed as
  residual risk in `phase-6-log.md` with the reason.
- The Section 8 matrix has no unexplained Missing rows.
- All required verification commands pass (see Rules), and `pnpm test:a11y`
  is still green.
- `docs/implementation/phase-6-log.md` records exact changes, commands,
  results, and the final test counts.

## Final step — SUMMARY.md and commit

After the Phase 6 log exists and all checks pass:

- Produce the top-level `docs/implementation/SUMMARY.md` containing:
  - every change made across Phases 1–6 (condensed per phase, pointing at the
    phase logs for detail, including the Phase 5 CSP/NUL hydration fix and
    the concrete Phase 5 decisions: token values, contrast test, modal
    focus/scrim behavior, `--scrim: oklch(0 0 0 / 0.45)`, blessed
    `--spacing-touch`/`--spacing-touch-lg` tokens, axe harness layout);
  - current test status with exact counts (`pnpm test`, `cd worker && pnpm
    test`, `pnpm test:a11y`, typechecks);
  - exact Free-plan Cloudflare deployment commands: `wrangler deploy` from
    `worker/` with the single `new_sqlite_classes` v1 migration (rate limits
    live in the `HuskGatekeeper` SQLite DO — no KV namespace needed),
    `wrangler secret put HUSK_TICKET_SECRET`, set `ALLOWED_ORIGINS`,
    `pnpm build` the frontend (nitro → Cloudflare) with `VITE_WORKER_URL`,
    deploy the frontend worker, then the spec Section 8 manual QA checklist
    (desktop create / mobile join / messages both ways / file both ways /
    background >8s / host force-close / confirm no server-side trace after
    close) with a results table;
  - the carried residuals (alarm polling, outbox drop note, `ssr.nonce`
    migration, static `theme-color`, lint baseline, etc.).
- Review the diff, stage only the Phase 6 implementation/log, `SUMMARY.md`,
  and any hand-off cleanup, and create one commit. Do not push it.
