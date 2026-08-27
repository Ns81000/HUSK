# Phase 4 Log — PWA, Frontend Runtime & Cross-Platform Fixes

## What changed

### 1. PWA (CRITICAL)

- **Plugin decision (documented):** `vite-plugin-pwa`'s peer range now includes
  Vite `^8.0.0`, but its workbox app-shell model does not fit the TanStack
  Start SSR setup: the nitro `cloudflare-module` output has no static
  `index.html`, and `generateSW`'s `navigateFallback` installs a
  `NavigationRoute` that serves a precached URL for same-origin navigations —
  for this app every page (including `/`) is per-request SSR with dehydrated
  state, so that is either broken or useless. Rather than fight
  rolldown-vite + nitro + the `@lovable.dev/vite-tanstack-config` wrapper for
  asset-only precaching, this phase took the hand-off prompt's sanctioned
  alternative ("an equally real Vite PWA integration"): a hand-authored
  service worker with an explicit precache list and strict cache policy.
- `public/sw.js` (new) — versioned caches (`husk-shell-<v>`,
  `husk-bundles-<v>`):
  - install precaches the static shell: `/`, manifest, favicon, robots, five
    icon files, the Inter woff2; `activate` purges previous versions and
    `clients.claim()`s.
  - fetch policy: **GET-only, same-origin only** (the Worker relay — API,
    WebSocket, file chunks — is a separate origin in production and is never
    intercepted), plus an explicit `/room/` and `/api/` never-cache guard.
  - navigations: only `/` is handled — network-first, a successful visit
    refreshes the offline fallback copy; failure falls back to the cached
    landing shell. `/r/<pin>` navigations are **always network-only** (they
    are per-request SSR state and must never be served stale).
  - precached static assets: cache-first; `/assets/*` (content-hashed
    bundles): cache-first with fill-on-miss; everything else: network-only
    (no `respondWith` at all).
- Registration in `src/routes/__root.tsx` already existed; added
  `import.meta.env.PROD` guard so a service worker never shadows dev/HMR.
  Failure stays non-fatal (progressive enhancement).
- Manifest/icons groundwork from the previous session was **verified, not
  duplicated**: `public/manifest.webmanifest` (standalone display, `#f6f7f8`
  theme/background derived from the light `--canvas` token, regular +
  maskable 192/512 PNGs, SVG mark) and `public/icons/*`. `public/_headers`
  already carries `/sw.js: no-cache` plus `/assets`, `/fonts`, `/icons`
  cache-control — unchanged.

### 2. IME Enter guard (MEDIUM)

- The guard existed (`!event.nativeEvent.isComposing`); this phase extracted
  it into an exported, testable predicate `shouldSubmitOnEnter` in
  `src/components/husk/chat.tsx` (Enter + not Shift + `isComposing !== true`,
  which also tolerates engines that omit the flag) and wired the Composer's
  `onKeyDown` to it.
- New `src/components/husk/chat.enter.test.ts` — 5 tests: plain Enter
  submits, Shift+Enter does not, other keys do not, an active IME composition
  does not, missing flag behaves as not-composing.

### 3. Online/offline awareness (MEDIUM)

- `src/lib/husk/store.ts` — the previously module-level handlers became store
  actions `notifyOffline()` / `notifyOnline()`; the `window` `online`/
  `offline` listeners now call them and are registered only when `window`
  exists (SSR- and Node-safe; the default store is a page-lifetime singleton,
  so the listeners intentionally live for the page's lifetime — commented in
  code). Listener count per store: exactly two, registered once.
- `notifyOnline()` now: sets `online: true`, calls
  `connection.resetBackoff()` (the real `RoomConnection.resetBackoff` clears
  the pending backoff timer and reconnects immediately — pre-existing), and
  — new — when the room already reached the terminal `closed_disconnected`
  state (connection disposed, retry budget exhausted), it calls `retry()`,
  creating a fresh connection. This delivers what the Phase 3 log promised:
  "recoverable via the explicit Reconnect button, or automatically when the
  browser fires `online` (Phase 4)".
- Initial `online` value is now `navigator.onLine !== false`: Node 21+ exposes
  a global `navigator` without `onLine`, which previously produced
  `undefined` under test/SSR instead of a sane default.
- `src/components/husk/room-info.tsx` already distinguishes "You are offline —
  messages can't send while offline" (warn tone) from "Reconnecting" —
  verified, unchanged.
- Tests (3 new in `store.test.ts`): offline event marks the store offline;
  coming online resets the backoff exactly once (new `resetBackoffCalls`
  counter on `FakeConnection`); coming online reconnects a room that ended as
  `closed_disconnected` (new connection spawned, state → `joining`).

### 4. Self-hosted Inter (MEDIUM)

- `public/fonts/inter-latin.woff2` (new) — Inter v20 **variable** latin
  subset, weights 400–600, fetched from Google's gstatic CDN; verified `wOF2`
  magic bytes; its `unicode-range` is byte-identical to the latin range
  already declared in `src/styles.css` (which keeps `font-display: swap`).
- `public/fonts/OFL.txt` (new) — full SIL Open Font License 1.1 text with the
  Inter copyright notice, as required when redistributing.
- No Google Fonts references exist anywhere in `src/` (grep clean), and the
  Phase 2 CSP already carried no Google allowlist entries
  (`style-src 'self' 'unsafe-inline'; font-src 'self'`) — verified.
- `pnpm build` no longer warns about the missing `/fonts/inter-latin.woff2`.

### 5. Error screens (LOW)

- Verified, no changes: `NotFoundComponent`/`ErrorComponent` in
  `src/routes/__root.tsx` use only Husk tokens (`border-line`, `bg-surface`,
  `text-ink`, `text-ink-muted`, `bg-accent`, `text-accent-ink`,
  `hover:bg-surface-sunken`, `text-title`) plus the existing `ErrorMark`
  icon. None of the audit's nonexistent `--foreground`/`--primary`/
  `--muted-foreground`/`--background`/`--input` utilities remain. Error
  boundary wiring (`errorComponent`, SSR 500 path in `server.ts`) untouched.

### 6. Theme flash (LOW)

- Verified, no code changes: the constant pre-paint `themeBootstrap` inline
  script in `RootShell` applies `dark` from `localStorage("husk-theme")` or
  `prefers-color-scheme: dark` before first paint; `useTheme` re-derives the
  same value after hydration and only toggles the class, so server and client
  markup match (no hydration error path).
- **Empirical CSP check:** served the production build under `wrangler dev`
  (workerd), fetched `/` and `/r/123456`, recomputed SHA-256 of every inline
  script in each served document: **3/3 covered** by the per-response CSP
  hashes on both pages (theme bootstrap + TanStack stream barrier + scroll
  restoration). The served HTML contains the theme bootstrap and the manifest
  link; the `theme-color` meta is `#f6f7f8`.

### 7. Message rendering (LOW)

- Verified, no changes needed: `MessageItem` is `memo`-ized; `MessageList`
  auto-scrolls only when the scroll position is within `NEAR_BOTTOM_PX`
  (120 px) of the bottom (tracked on the container's scroll event), so
  reading history is not yanked by incoming messages; `orderedEntries` seq
  ordering, delivery states, Retry, and the unverified-message notice all
  render through the memoized item.

## Test status

- `pnpm exec tsc --noEmit -p tsconfig.json` — pass
- `pnpm exec tsc --noEmit -p worker/tsconfig.json` — pass
- `cd worker && pnpm typecheck` — pass
- `pnpm test` — **13 files, 95/95 pass** (was 87: +3 store online/offline,
  +5 IME)
- `cd worker && pnpm test` — **19/19 pass**
- `pnpm build` — pass; the missing-font warning is gone
- Touched files are Prettier-clean; repo-wide lint baseline untouched

## Manual verification (production build, served)

- Built output `.output/public` contains `sw.js` (3.8 KB),
  `manifest.webmanifest`, `fonts/inter-latin.woff2` (48,256 bytes),
  `fonts/OFL.txt`, and all five icon files alongside the hashed `assets/`.
- Served `.output/server` with the worker's wrangler (workerd, local mode):
  `/` 200, `/sw.js` 200, `/manifest.webmanifest` 200,
  `/fonts/inter-latin.woff2` 200, `/icons/husk-icon-192.png` 200,
  `/icons/husk-maskable-512.png` 200, `/r/123456` 200 (SSR),
  `/room/123456/socket` 404 (expected — no relay bound in this harness).
- CSP per-response inline-script hash coverage verified on both pages (above).
- All processes killed; generated `.wrangler/` state and dev logs removed.

## Residual risk

- The offline fallback for `/` serves the last-cached landing SSR shell; if a
  deploy ships while the device is offline it can be one release behind (the
  fallback refreshes on the next successful visit, and bumping
  `CACHE_VERSION` in `sw.js` invalidates it explicitly).
- Room pages are never cached, so an offline visit to `/r/<pin>` gets the
  browser's network error rather than an app screen — deliberate (a stale
  room shell must never be served), but it means the PWA is
  "offline-tolerant for the shell", not offline-functional (rooms need the
  live relay by design).
- No `beforeinstallprompt` capture / custom install UI (not required by the
  audit; the manifest + SW make the app installable).
- The `theme-color` meta is statically light (`#f6f7f8`); a
  `media="(prefers-color-scheme: dark)"` variant was not added (cosmetic:
  Android status-bar tint in dark mode). Left for the design phase.
- Local serving required `--compatibility-date 2026-08-01`: nitro stamps the
  generated `.output/server/wrangler.json` with the build date, which the
  installed wrangler 4.126.0 rejects as "in the future". Deployment-side
  wrangler versions may need the same attention.
- `wrangler dev`/Cloudflare deployment has not been performed beyond the
  local verification above (no credentials).
- Lint repo-wide remains red (pre-existing baseline; untouched files).

  the pending backoff timer and reconnects immediately — pre-existing), and
  — new — when the room already reached the terminal `closed_disconnected`
  state (connection disposed, retry budget exhausted), it calls `retry()`,
  creating a fresh connection. This delivers what the Phase 3 log promised:
  "recoverable via the explicit Reconnect button, or automatically when the
  browser fires `online` (Phase 4)".
- Initial `online` value is now `navigator.onLine !== false`: Node 21+ exposes
  a global `navigator` without `onLine`, which previously produced
  `undefined` under test/SSR instead of a sane default.
- `src/components/husk/room-info.tsx` already distinguishes "You are offline —
  messages can't send while offline" (warn tone) from "Reconnecting" —
  verified, unchanged.
- Tests (3 new in `store.test.ts`): offline event marks the store offline;
  coming online resets the backoff exactly once (new `resetBackoffCalls`
  counter on `FakeConnection`); coming online reconnects a room that ended as
  `closed_disconnected` (new connection spawned, state → `joining`).
