# Phase 5 Log — Design System & Accessibility Compliance

## What changed

### 0. CRITICAL regression fix (found by this phase's axe harness): CSP hash
mismatch broke production hydration (src/server.ts)

- **Symptom:** the axe/E2E harness ran against the real production build in a
  real browser; every page loaded blank after hydration with
  `PAGEERROR: Invariant failed`, and one inline script was CSP-blocked on
  every load with a different hash each time.
- **Root cause (established with byte-level evidence, not guesswork):**
  TanStack Start serializes dehydrated route-match IDs containing **literal
  U+0000 characters** into the emitted `$tsr-stream-barrier` inline script
  (`{i:"__root__\u0000",...}`, `lastMatchId:"\u0000\u0000"`). Per the WHATWG
  HTML tokenizer (script data state), a NUL is a parse error and is replaced
  with U+FFFD, so the script text the browser executes is not the text in the
  response bytes. The Phase 2 per-response hash CSP hashes the raw bytes → the
  hash can never match → the framework's own hydration bootstrap is blocked →
  React hydration throws and the DOM is wiped. **The production app has been
  hydration-broken in real browsers since Phase 2**; the Phase 2/4 "hash
  coverage" checks recomputed hashes from the served HTML only, so the
  divergence between served bytes and parsed bytes was invisible. Husk's own
  code is clean here: no loaders, no `params.parse` — the NULs are
  framework-internal.
- **Fix:** `stabilizeInlineScriptBytes()` in `src/server.ts` re-encodes each
  NUL in the buffered HTML as the six-character JS string escape `\u0000`
  before hashing and re-emitting. Semantically lossless (a JS/JSON string
  literal `"\u0000"` is the same string as a raw NUL, so the dehydrated
  payload the router reads is unchanged) and parser-stable (plain ASCII passes
  the tokenizer untouched), so per-response hashes now hold. Verified in
  Chromium: zero CSP violations, hydration completes, DOM persists.
- **Long-term path (documented, not implemented):** migrate to `ssr.nonce`-based
  CSP (`createStart` middleware + `getGlobalStartContext()` +
  `router.options.ssr.nonce`), which removes the served-bytes vs executed-bytes
  fragility entirely. The nonce plumbing (issues #5511/#5522, plus #5870 which
  nonces the barrier script) is present in our versions. Residual for Phase 6
  consideration.

### 1. AA contrast (src/styles.css + new src/lib/husk/contrast.test.ts)

- Light `--warn`: `oklch(0.6 0.09 78)` → **`oklch(0.5 0.09 78)`**
  (ratio vs canvas 5.65, surface 6.08, raised 5.99, sunken 5.33).
- Light `--ink-faint`: `oklch(0.64 0.006 250)` → **`oklch(0.535 0.006 250)`**.
  **Deliberate deviation from the audit's ~0.56 sketch:** at 0.56 the pair on
  `canvas` computes to only 4.33:1 (and 4.08 on `surface-sunken`), i.e. the
  audit's suggested value fails the requirement on real caption backgrounds.
  0.535 gives canvas 4.81 / surface 5.17 / raised 5.09 / sunken 4.53 — all ≥4.5.
- Dark `--ink-faint`: `oklch(0.58 0.005 250)` → **`oklch(0.64 0.005 250)`**
  (canvas 5.59 / surface 5.21 / raised 4.83 / sunken 5.81; the worst pair is on
  the lighter `surface-raised`, which is where the composer placeholder sits).
- **Permanent CI gate: `src/lib/husk/contrast.test.ts` (5 tests, ~30 lines of
  oklch→linear-sRGB math).** It parses the `:root` and `.dark` blocks out of
  `src/styles.css` itself (so a token edit that breaks contrast fails CI
  without the test being edited), converts oklch→oklab→LMS→linear RGB, and
  asserts ≥4.5:1 for every foreground token rendered as body/caption text
  (`ink`, `ink-muted`, `ink-faint`, `warn`, `danger`, `ok`, `info`) on every
  surface it can sit on (`canvas`, `surface`, `surface-raised`,
  `surface-sunken`), plus `accent-ink` on `accent`/`accent-hover`, in both
  themes. Disabled-state text (`disabled:text-ink-faint`) is deliberately not
  asserted (WCAG 1.4.3 exempts inactive UI components); a third test pins the
  three fixed values so they cannot silently regress.

### 2. Modal focus management (src/components/husk/primitives.tsx)

- Tab is trapped inside the dialog: focusable descendants are queried with the
  standard selector list (links, enabled buttons/inputs/textarea/select,
  explicit `tabindex`), Tab at the last element wraps to the first, Shift+Tab
  at the first wraps to the last, and focus that lands outside the dialog is
  pulled back in (WCAG 2.4.3).
- Focus is restored to the invoking element on close (the open-effect's
  cleanup refocuses `document.activeElement` as it was when the dialog
  opened). Escape still cancels, now through a `cancelRef` so a re-rendered
  `onCancel` identity does not restart the effect (which would re-save the
  invoker mid-interaction).
- Scrim click closes the modal: the overlay calls `onCancel`, the dialog panel
  stops propagation.
- Regression-pinned in a real browser by `e2e/modal.spec.ts` (see item 5).

### 3. `--scrim` token (src/styles.css)

- Added `--scrim: oklch(0 0 0 / 0.45)` (same value both themes, as the audit
  allows), mapped through `@theme inline` as `--color-scrim`. The Modal
  backdrop's raw `bg-[oklch(0_0_0/0.45)]` literal is now `bg-scrim`.

### 4. Spacing decision — BLESSED as named tokens (recorded)

- **Decision: bless 44/56 as named touch-target tokens**, snapped into the
  token file rather than the numeric scale. Rationale: the 44px hits are
  WCAG-driven touch targets (2.5.8) and 56px is the keypad key size; snapping
  them to 48px would shrink real touch targets to satisfy a cosmetic rule.
- `--spacing-touch: 44px` and `--spacing-touch-lg: 56px` added to
  `@theme inline`; the `touch-target` utility now reads `var(--spacing-touch)`.
- All off-scale numeric hits replaced: composer `min-h-11` → `min-h-touch`
  (chat.tsx), keypad keys `h-14` → `h-touch-lg` (keypad.tsx ×3),
  `PinDisplay` digit boxes `h-14 w-11` → `h-touch-lg w-touch`,
  Switch track `w-11` → `w-touch` (primitives.tsx).
- No untracked off-scale spacing values remain in shipped Husk components.

### 5. Axe smoke specs (Playwright + @axe-core/playwright)

- New dev dependencies: `@playwright/test@1.62.1`, `playwright@1.62.1`,
  `@axe-core/playwright@4.13.0`. The machine's cached chromium build (1234)
  matches 1.62.1, so no browser download was needed here; on a fresh machine
  run `pnpm exec playwright install chromium` once.
- `playwright.config.ts` (repo root): serves the **real production nitro
  output** under wrangler/workerd (`--config ../.output/server/wrangler.json
  --compatibility-date 2026-08-01 --port 8787` — same serving method as the
  Phase 4 manual verification), single chromium project, `webServer`
  lifecycle managed by Playwright.
- `.env.a11y` (`VITE_WORKER_URL=http://127.0.0.1:8787`) + `build:a11y` script
  (`vite build --mode a11y`): bakes the app's own origin as the relay URL so
  the CSP `connect-src` allows the endpoints the modal spec intercepts.
- `test:a11y` script = `pnpm build:a11y && playwright test`. **Deliberately
  not part of `pnpm test`** (it builds and starts wrangler; keep unit/integration
  runs fast and hermetic).
- `e2e/a11y.spec.ts` — 6 specs, zero-violation assertion (`wcag2a`, `wcag2aa`,
  `wcag21a`, `wcag21aa`): landing screen, PIN-entry screen (keypad view), and
  the `/r/<pin>` room screen — each in light and dark (theme forced through
  the same `husk-theme` localStorage key the pre-paint bootstrap reads). The
  room screen without a relay renders its "This link has no key" closed state,
  which is the only room state reachable server-side without a live relay.
- `e2e/modal.spec.ts` — 6 specs exercising the real Modal in the real app:
  relay endpoints (`/room/create`, `/room/join`, the socket) are intercepted
  with Playwright route/`routeWebSocket` mocks, so the full create→room→modal
  flow runs without a Worker. Asserts: focus starts on confirm; Tab wraps
  forward to Cancel; Shift+Tab wraps back to confirm; Escape closes and
  restores focus to the invoker; scrim click closes and restores focus; and
  axe reports zero violations in the open-modal room state.
- **Two real a11y defects the harness caught and this phase fixed:**
  `PinDisplay` had `aria-label` on a bare `<div>` (prohibited — now
  `role="group"`), and the composer's `sr-only` file input had no accessible
  name (now `aria-label="File to send"`).
- Scope note (honest): confirming the leave modal genuinely leaves the room
  (`closed_by_host`), unmounting the invoker, so the focus-restore assertion
  intentionally covers the dismissive closes (Escape/scrim) where a restore
  target exists.

### 6. Incidental cleanup surfaced by serving (public/_headers)

- The static `_headers` file used a CSS-style `/* … */` comment block, which
  the `_headers` format does not support; wrangler logged "Found 4 invalid
  header rules" on every serve. Converted to `#` comment lines (semantics of
  the 7 real rules unchanged, warnings gone).

## Commands and results

| Command | Result |
|---|---|
| `pnpm test` | **14 files, 100/100 pass** (was 95; +5 contrast tests) |
| `pnpm exec tsc --noEmit -p tsconfig.json` | pass |
| `pnpm exec tsc --noEmit -p worker/tsconfig.json` | pass |
| `pnpm --dir worker exec tsc --noEmit` (`cd worker && pnpm typecheck`) | pass |
| `cd worker && pnpm test` | **19/19 pass** |
| `pnpm build` | pass; verified `.output` contains no a11y-mode worker URL (production mode is unaffected by `.env.a11y`) |
| `pnpm test:a11y` | **12/12 pass** (6 axe + 6 modal E2E), production build served under wrangler/workerd |

Touched files are Prettier-clean (`prettier --check`); repo-wide lint baseline
unchanged (pre-existing red).

## Residual risk

- The NUL-escape is a server-side mitigation of a framework serialization
  property, not a fix of it. If TanStack changes the dehydrated payload shape
  the escape remains harmless (it only rewrites raw NUL code points). The
  cleaner long-term fix is `ssr.nonce`-based CSP (mechanism confirmed present
  in our versions); recorded for Phase 6 scoping. Also recommended as general
  hygiene: `@tanstack/react-router` 1.170.18 → 1.170.32+.
- The axe sweep covers the landing, PIN-entry and room-no-key screens plus the
  open-modal room state, in both themes, against WCAG 2.0/2.1 A+AA rules. Not
  swept: message-list states with content, toasts, and the remaining closed
  states (their building blocks — Panel/Button/closed screen — are the same
  components the swept screens use).
- `pnpm test:a11y` needs a cached Playwright chromium matching the installed
  `@playwright/test` (fresh machines: `pnpm exec playwright install chromium`),
  and it starts a local workerd; on Windows, ensure no stray workerd process
  holds `.output` before running (it builds first).
- The `theme-color` meta is still statically light (pre-existing residual from
  Phase 4, carried below).
- Pre-existing residuals carried unchanged: outbox cap drops frames silently;
  `worker/src/room.ts` alarm polling; no live deployment; repo-wide lint
  baseline.