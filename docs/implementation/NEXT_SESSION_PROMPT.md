# HUSK — Implementation Prompt (Session 5: Phase 5 only, then hand off)

You are continuing the phased hardening of the Husk project (ephemeral,
end-to-end encrypted chat and file sharing; React + TanStack Start frontend;
Cloudflare Workers + SQLite Durable Objects backend).

Implementation Phases 1–4 are complete and were re-tested immediately before
this hand-off. **This session's scope is Implementation Phase 5 only.** Do not
implement Phase 6 in this session. When Phase 5 is complete, write its log,
create the Phase 6-only hand-off prompt by rewriting this file, and commit all
Phase 5 changes plus the new hand-off prompt.

## Read these files FIRST, in full

Read every file below completely before writing code:

```text
C:\Users\Ns8pc\Pictures\HUSK\docs\implementation\NEXT_SESSION_PROMPT.md
C:\Users\Ns8pc\Pictures\HUSK\docs\implementation\phase-1-log.md
C:\Users\Ns8pc\Pictures\HUSK\docs\implementation\phase-2-log.md
C:\Users\Ns8pc\Pictures\HUSK\docs\implementation\phase-3-log.md
C:\Users\Ns8pc\Pictures\HUSK\docs\implementation\phase-4-log.md

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

These commands were run successfully at the end of the Phase 4 session:

- `pnpm test` — 13 test files, **95/95 pass** (including the workerd project).
- `cd worker && pnpm test` — **19/19 pass**.
- `pnpm exec tsc --noEmit -p tsconfig.json` — pass.
- `pnpm exec tsc --noEmit -p worker/tsconfig.json` — pass.
- `cd worker && pnpm typecheck` — pass.
- `pnpm build` — pass (no missing-asset warnings; the Inter font warning is gone).
- The production build was served locally under wrangler dev (workerd) and the
  PWA/CSP checks recorded in `docs/implementation/phase-4-log.md` were performed.

## What is already implemented

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
  hardening) unless the user explicitly expands Phase 5's scope.
- The outbox drops its oldest frame silently when capped; it does not create
  the audit's suggested plaintext system note because unsent plaintext is not
  retained. Preserve this as a documented residual for the later phase.
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
  optional polish, not a Phase 5 requirement.

## Current Phase 5 groundwork present in the tree (verify before editing)

- `src/styles.css` has the full dual-theme token palettes. The audit's
  failing pairs are still at their old values: light `--warn`
  oklch(0.6 0.09 78), light `--ink-faint` oklch(0.64 0.006 250), dark
  `--ink-faint` oklch(0.58 0.005 250). Radius/spacing/type tokens are
  documented in the same file.
- `src/components/husk/primitives.tsx` `Modal` (~lines 121–181) still has no
  focus trap, no focus restoration, and no scrim click; its backdrop is the
  raw literal `bg-[oklch(0_0_0/0.45)]` — the `--scrim` finding is still open.
- Off-scale spacing is still present: `min-h-11` (composer textarea in
  `chat.tsx`), `h-14` keypad keys, `touch-target` (44px) utilities, and any
  `h-11`/`w-11` hits.
- No `@axe-core/playwright` (and no Playwright) dependency exists anywhere.
- The 404/error screens already use Husk tokens (Phase 4) — do not re-port.

## Rules

- Work on Phase 5 only. Do not begin Phase 6.
- Implement → run all relevant tests and checks → hunt for regressions → write
  `docs/implementation/phase-5-log.md` → rewrite this file as the Phase 6-only
  hand-off → commit the session's intended changes.
- Required verification before declaring Phase 5 complete:
  `pnpm test`, `pnpm build`, `pnpm exec tsc --noEmit -p tsconfig.json`,
  `pnpm exec tsc --noEmit -p worker/tsconfig.json`, and
  `cd worker && pnpm test`.
- Use `pnpm` exclusively. Do not use `npm install` or `pip install`.
- Do not deploy or use credentials. Stop only for a decision that genuinely
  requires the user.
- Keep tests deterministic and focused. Add regression tests for behavior
  changed in this phase where a reliable seam exists.
- Keep touched files Prettier-formatted. Do not fix the repository-wide lint
  baseline or create unrelated diff noise.
- Kill any `wrangler dev`, `vite preview`, or workerd process you start; a
  leftover process can lock `.output` and break the next `pnpm build` on
  Windows.
- Before committing, inspect `git diff` and `git status`; stage only intended
  files. Do not amend or rewrite earlier commits, and do not push unless asked.


## Implementation Phase 5 — Design System & Accessibility Compliance

Use `C:\Users\Ns8pc\Pictures\HUSK\docs\audit\phase-5-design-accessibility.md`
as the source of the requirements. Finish and verify all five items below:

1. **AA contrast:** darken light-theme `warn` to ~`oklch(0.5 0.09 78)` and
   `ink-faint` to ~`oklch(0.56 0.006 250)` (≥4.5:1 on `surface`/`canvas`),
   and mirror the dark-theme `ink-faint` bump. Add the oklch→sRGB contrast
   conversion as a permanent vitest unit test (~30 lines of math) asserting
   every token pair used for body/caption text clears 4.5:1 in both themes,
   so regressions are caught in CI.
2. **Modal focus management** (`src/components/husk/primitives.tsx`): trap
   Tab within the dialog (query focusable descendants, wrap at both ends),
   restore focus to the invoking element on close, and close on scrim click
   (currently only Escape and Cancel close it).
3. **`--scrim` token:** add it to `src/styles.css` (same value both themes is
   acceptable, per the audit) and replace the raw `bg-[oklch(0_0_0/0.45)]`
   literal in the Modal backdrop.
4. **Spacing decision:** bless or snap the off-scale values (`min-h-11`,
   `h-14`, `w-11`, `h-11`). Either bless 44/56 as named touch-target tokens
   or snap them to the documented scale — do not silently accumulate
   off-scale values. Record the decision explicitly in the log.
5. **Axe smoke specs:** add `@axe-core/playwright` smoke specs for the
   landing and PIN screens in both themes with zero violations. If a real
   browser harness cannot run in this environment, do not fake results — set
   up exactly what runs, and record what remains as residual risk with the
   reason and next phase.

## Phase 5 definition of done

- The phase-5 audit findings are either fixed and tested or explicitly listed
  as residual risk in `phase-5-log.md` with the reason and next phase.
- The contrast test is permanent in `pnpm test` and green in both themes.
- The modal traps/restores focus and closes on scrim click; the backdrop uses
  the `--scrim` token.
- The spacing decision is recorded; no untracked off-scale values remain in
  shipped Husk components.
- All required verification commands pass.
- `docs/implementation/phase-5-log.md` records exact changes, commands,
  results, manual checks, residual risk, and the final test counts.

## After Phase 5 — create the Phase 6-only hand-off and commit

After the Phase 5 log exists and all required checks pass, rewrite this same
file as the next prompt. The new prompt must:

- Scope the next session to **Implementation Phase 6 only**.
- Begin with an absolute-path "Read these files FIRST, in full" block listing
  the new `NEXT_SESSION_PROMPT.md`, logs 1–5, and all seven audit files.
- Carry forward the Phase 1–5 decisions above plus concrete Phase 5 decisions:
  the exact new token values, the contrast-test file and what it asserts, the
  modal focus/scrim behavior, the `--scrim` value, the spacing decision, and
  the axe harness setup and its results.
- Include the full Phase 6 requirements from the audit:
  1. Verify the Phase 1 streaming GET keeps CPU bounded (integration test with
     a 10+ chunk file through `wrangler dev`/pool-workers; no 1102).
  2. Add the missing unit tests: `orderedEntries` (out-of-order, ties, system
     messages) and seq-order rendering under out-of-order relays.
  3. Confirm remaining Section 8 rows are green (the matrix in phase-6 is the
     checklist); anything still Missing from phases 1–5 gets written there.
  4. Run live Lighthouse against `wrangler dev` (desktop + mobile profiles)
     and record scores plus the font fix's effect in the log.
- Preserve the Rules, exact verification commands, Windows `.output` warning,
  known residuals, and the one-phase boundary.
- End by telling the Phase 6 agent to write its log, produce the top-level
  `docs/implementation/SUMMARY.md` (all changes across phases, current test
  status, exact Free-plan Cloudflare deployment commands, and the spec
  Section 8 manual QA checklist results), and commit before ending its
  session.

Finally, review the diff, stage only the Phase 5 implementation/log and the
rewritten hand-off prompt, and create one commit. Do not push it.

  expiry are bounded.
