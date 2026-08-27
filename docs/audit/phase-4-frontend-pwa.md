# Phase 4 — Frontend Runtime, PWA & Cross-Platform Native Feel

## Summary

Read `chat.tsx`, `keypad.tsx`, `primitives.tsx`, `room-info.tsx`, `__root.tsx`, `theme.ts`, `router.tsx` context via routes, and `styles.css` token/utility definitions. Verified PWA assets in `public/` (favicon.ico and robots.txt only). Ran a full production build (`pnpm build`, 243 modules, succeeds in ~0.2s server-side) and measured output: client entry 307 KB raw / ~95 KB gzip, route-level code splitting present, total `.output/public` 495 KB. The custom-component quality is high (genuine keypad, custom switch/modal/toasts, real desktop layout), but **the PWA requirement is entirely unimplemented** — no manifest, no service worker — and the IME Enter bug the spec-audit brief predicted is present.

## Findings

### [CRITICAL] No PWA manifest and no service worker — the installable/offline-tolerant requirement is unimplemented (public/, vite.config.ts)
- **Category:** PWA
- **Evidence:** `public/` contains exactly `favicon.ico` and `robots.txt`. No `manifest.json`/`manifest.webmanifest` anywhere, no `vite-plugin-pwa` in package.json or vite config, no `sw.js`/`sw.ts`, no `beforeinstallprompt` handling, no `theme_color`/`display`/icons of any kind. The generated `.output/public/_headers` sets only cache-control.
- **Why it matters:** The project requirement is an installable, offline-tolerant PWA with native feel on Android/desktop. Today the app is a plain website: not installable (no manifest → no A2HS prompt, no maskable icon, no standalone display, no theme color for the Android status bar), and offline it shows the browser's dinosaur page. There is no "degrades gracefully" story because there is nothing to degrade — the audit brief's step-1 instruction ("if none exists, this is a Critical finding; do not assume it exists") applies verbatim.
- **Confidence:** High
- **Recommended fix:** Add `vite-plugin-pwa` (manifest: standalone, maskable + regular 192/512 icons, theme/background colors from the token file, `orientation: portrait-primary` on mobile is optional) with a minimal workbox precache of the app shell; register the SW in `__root.tsx`; add an explicit "You are offline — messages can't send while offline" banner state (the connection store already has the right signal). Decide deliberately what the SW must never cache (nothing sensitive — the app holds no persisted state, so precache-only + network-only for everything else is safe and simple).

### [MEDIUM] Enter-to-send fires mid-IME-composition (src/components/husk/chat.tsx:240-245)
- **Category:** UX / Accessibility
- **Evidence:**
  ```ts
  onKeyDown={(event) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      void submit();
    }
  }}
  ```
  No `event.nativeEvent.isComposing` / `keyCode === 229` check.
- **Why it matters:** With Japanese/Chinese/Korean IMEs, pressing Enter to *commit* the composition sends a half-converted message instead. The audit brief called this exact bug; it is present.
- **Confidence:** High
- **Recommended fix:** `if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing)`.

### [MEDIUM] No visibilitychange/foreground handling and no offline affordance (grep: zero hits for `visibilitychange|document.hidden|pageshow|beforeunload` in src/)
- **Category:** UX / PWA
- **Evidence:** No intentional suspend/resume of the WebSocket on backgrounding; the client relies entirely on the browser killing the socket and the `close` handler's reconnect loop. There is also no "you're offline" UI state distinct from "Reconnecting" (the `navigator.onLine` signal is never consulted).
- **Why it matters:** The spec's ">8 seconds background → reconnect behavior" requirement is met only incidentally (socket death triggers reconnect-with-backoff, which is the correct core behavior). But on Android, a backgrounded tab's reconnect attempt can be throttled for minutes with no user-visible explanation beyond "Reconnecting", and a device that goes fully offline spins the reconnect loop (see Phase 3 finding 1) with no terminal message. Fixing Phase 3's terminal-state gap plus an `online`/`offline` listener covers this.
- **Confidence:** High
- **Recommended fix:** Add `window.addEventListener("online"/"offline")` mapping to the connection status; on `online`, force an immediate reconnect attempt (reset backoff) rather than waiting out the current backoff delay.

### [MEDIUM] Third-party Google Fonts request on every page load (src/routes/__root.tsx:100-105)
- **Category:** Security / Privacy
- **Evidence:** `preconnect` + stylesheet to `fonts.googleapis.com`/`fonts.gstatic.com`.
- **Why it matters:** For an app whose selling point is metadata minimization, every visitor's IP, UA, and timing leak to Google on first paint — and the strict CSP demanded by spec Section 5 (Phase 2 finding) cannot be written without either allowlisting Google Fonts or self-hosting. Inter is a single variable-weight family; there is no excuse for the remote dependency.
- **Confidence:** High
- **Recommended fix:** Self-host Inter (woff2, `font-display: swap`) via `public/fonts/` or a vendored package; delete the preconnects.

### [LOW] 404 and error screens reference token classes that don't exist (src/routes/__root.tsx:19-75)
- **Category:** UX / Design-system consistency
- **Evidence:** `text-foreground`, `bg-primary`, `text-primary-foreground`, `text-muted-foreground`, `bg-background`, `border-input` — none of `--foreground`, `--primary`, `--muted-foreground`, `--background`, `--input` are defined in `src/styles.css` (verified by grep; the Husk token set uses `--ink*`, `--surface*`, `--accent*`, `--line*`). In Tailwind v4 an undefined token means the utility is never generated.
- **Why it matters:** The 404 and crash screens render with browser-default styles (plain black-on-white, default buttons) in both themes — jarring and off-brand exactly when the app is at its worst. Full detail in Phase 5.
- **Confidence:** High
- **Recommended fix:** Rewrite both screens with Husk tokens (`text-ink`, `bg-surface`, `Button` primitive).

### [LOW] Message list: full re-render per store change, no virtualization, auto-scroll fights the user (src/components/husk/chat.tsx:113-182)
- **Category:** Performance / UX
- **Evidence:** `orderedEntries(entries)` allocates a sorted copy on every render; no per-entry `memo`; `scrollIntoView` fires on every `entries.length` change unconditionally (scrolls the user back down even if they scrolled up to read); entries grow unbounded for the room's life.
- **Why it matters:** Rooms are ephemeral (24h max, ≤10 peers), so unbounded growth is bounded in practice — a chatty 10-person room over hours is thousands of entries, each decrypt+insert re-rendering the whole list (O(n) React reconciliation per message). Auto-scroll is the more visible defect: reading history while a peer chats yanks you to the bottom.
- **Confidence:** High (mechanism), Low/Medium (practical impact)
- **Recommended fix:** Extract a memoized `MessageItem`; auto-scroll only when already near-bottom (check `scrollTop + clientHeight >= scrollHeight - threshold`); defer virtualization until real usage shows need — don't add it speculatively (spec's "Simple" priority).

### [LOW] Dark-theme users get a light flash on first paint (src/lib/husk/theme.ts:20-33)
- **Category:** UX
- **Evidence:** Theme is read from localStorage only in a `useEffect` after hydration; the docstring acknowledges "read after hydration only, so server and client markup match."
- **Why it matters:** Every dark-mode user sees white background flash on navigation loads. With a future CSP banning inline scripts (Phase 2), the classic pre-paint inline snippet needs a nonce — coordinate the two fixes.
- **Confidence:** High
- **Recommended fix:** Nonce'd inline script in `RootShell` head that sets the `dark` class from localStorage before CSS paint, or serve the theme as a cookie the SSR shell reads.

## Verified-Correct

- **Build is healthy** — `pnpm build` succeeds; client entry ~95 KB gzip (React 19 + TanStack Router + Query + Zustand), route chunks split (`r._pin` 7–12 KB gzip), no unused shadcn component made it into the bundle (243 modules; `ui/chart.tsx`/`ui/sidebar.tsx` etc. are imported by nothing). The 665 KB router chunk is server-side SSR only. No dead-weight vendor problem.
- **Safe-area is real, not decorative** — `@utility safe-top/safe-bottom` use `max(spacing, env(safe-area-inset-*))` (styles.css:146-152), applied to the composer bar (`chat.tsx:207`) and both screens' top containers (`r.$pin.tsx:176`, `index.tsx:96`); viewport has `viewport-fit=cover` (`__root.tsx:81`).
- **The keypad is genuinely custom and accessible** — grid of real `<button>`s, 56px tall with a `touch-target` utility (min 44px), `aria-label`s, an `aria-live` PIN display, no OS picker anywhere (`keypad.tsx`); hardware-keyboard users can Tab/Enter through it. (A "paste PIN" affordance is a nice-to-have, not a gap.)
- **Desktop layout is structurally distinct** — `lg:` breakpoint swaps a sidebar `aside` (room info, share, leave) plus main pane for the mobile single column with compact bottom info bar (`r.$pin.tsx:165-193`); this is breakpoint-driven structure, not stretched CSS.
- **Enter/Shift+Enter works** (minus the IME bug above); hint text documents the behavior.
- **Error boundaries are wired end-to-end** — root `errorComponent` with retry/reset, `notFoundComponent`, plus the SSR-level wrapper in `server.ts` that converts h3-swallowed 500s into a rendered error page. A route crash does not blank the app. `error-page.ts` is genuinely used (via `renderErrorPage` in server.ts).
- **No mixed-content risk** — `roomSocketUrl` upgrades `https:`→`wss:` explicitly (connection.ts:30-32); Workers deployment is HTTPS by default.
- **No raw default-palette classes in shipped Husk components** — grep for Tailwind default colors across `components/husk/` and `routes/` is clean (the violations are the token-name ones above, which are absent tokens rather than default-palette classes).

## Phase Verdict

As a React app this is well-built: healthy bundle, real code splitting, custom components done properly, correct safe-area and layout responsiveness, working error boundaries. As a PWA it is **nothing yet** — that entire requirement exists only on paper, which is the phase's one Critical finding. The IME bug and missing offline/foreground affordances are the remaining pre-launch items; everything else is polish. **Verdict: has blocking issues** (PWA absence), with the rest "needs minor fixes."
