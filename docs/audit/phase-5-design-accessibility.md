# Phase 5 — Design System & Accessibility Compliance

## Summary

Read `styles.css` in full (token definitions, both theme palettes, base layer, utilities), `primitives.tsx`, `keypad.tsx`, `chat.tsx`, `room-info.tsx`, both routes. Grepped for emoji, Tailwind default-palette classes, native form controls, and `alert/confirm/prompt` (all clean). Computed WCAG contrast ratios by converting every oklch token pair to sRGB relative luminance in a script (not eyeballed). No axe dependency exists; the automated-audit requirement is recorded as a test gap with an exact remediation path. The design system itself is genuinely compliant with the spec's contract — the deviations are two contrast failures at caption sizes and missing focus management in the one modal the app has.

## Findings

### [MEDIUM] `warn` and `ink-faint` fail WCAG AA (1.4.3) at body/caption size — light theme (src/styles.css:83,89)
- **Category:** Accessibility
- **Evidence (computed, oklch→sRGB luminance):**

| Pair | Ratio | Verdict |
|---|---|---|
| LIGHT `warn` on `surface` | 3.99:1 | fails 4.5:1 body |
| LIGHT `ink-faint` on `surface` | 3.36:1 | fails 4.5:1 body |
| LIGHT `ink-faint` on `canvas` | 3.13:1 | fails 4.5:1 body |
| DARK `ink-faint` on `surface` | 4.09:1 | fails 4.5:1 body |

  `ink-faint` is used for 12.5px caption text throughout: "Sending"/timestamps (chat.tsx:105,110), hint paragraphs (r.$pin.tsx:96-97, index.tsx:157), composer hints (chat.tsx:258). `warn` carries the "Reconnecting" connection indicator (room-info.tsx:31) and the "message could not be verified" notice (chat.tsx:155) — both small caption-size text, i.e. *state-critical information* in the failing color.
- **Why it matters:** Spec Section 8 requires WCAG AA in both themes. The failures sit exactly on the statuses a user must read when something is wrong (reconnecting, unverified message). (For reference, all other pairs pass: primary text 15.7:1, muted 5.6:1, accent-on-surface 5.8:1, danger 5.9:1, dark theme all ≥7:1 except ink-faint.)
- **Confidence:** High (computed)
- **Recommended fix:** Darken light-theme `warn` to ~`oklch(0.5 0.09 78)` and `ink-faint` to ~`oklch(0.56 0.006 250)` (≥4.5:1 on surface/canvas), mirror the dark bump for `ink-faint`; re-run the contrast script as a unit test (the oklch math is ~30 lines) so regressions are caught in CI.

### [MEDIUM] Modal has no focus trap and no focus restoration (src/components/husk/primitives.tsx:146-187)
- **Category:** Accessibility
- **Evidence:** `Modal` focuses the confirm button on open and handles Escape, but Tab moves focus out of the dialog to the background page (no keydown intercept of Tab), and nothing returns focus to the invoking button on close.
- **Why it matters:** WCAG 2.4.3 (Focus Order) / best practice for `aria-modal="true"`: with `aria-modal` declared, screen readers *hide* the background, but keyboard sighted users can still land on invisible-context controls — worst case, a keyboard user in the leave-room dialog tabs onto "Attach a file" behind the scrim without seeing it.
- **Confidence:** High
- **Recommended fix:** Trap Tab within the dialog (query focusable descendants, wrap at ends), restore focus to the previously-focused element on close, and close on scrim click (currently only Escape and Cancel do).

### [MEDIUM] 404/error screens use token classes that don't exist — renders unstyled (src/routes/__root.tsx:17-75)
- **Category:** Design-system compliance (full evidence in Phase 4 finding 5)
- **Why it matters here:** Spec Section 7's contract is "every component built from the token file." The 404 and crash screens reference `--foreground`/`--primary`/`--muted-foreground`/`--background`/`--input`, none of which exist in `styles.css` — Tailwind v4 generates no utilities for them, so these screens ship with browser-default styling in both themes, violating the no-default-look rule precisely on the screens shown when things go wrong.
- **Confidence:** High
- **Recommended fix:** Port both screens to Husk tokens + `Button`/`Panel` primitives.

### [LOW] No automated accessibility audit exists — spec Section 8 requirement unimplemented
- **Category:** Test Gap
- **Evidence:** No axe-family dependency in package.json; no a11y test file anywhere.
- **Why it matters:** The spec requires an automated audit (axe) against every screen in both themes. Nothing enforces even the basics; the contrast failures above went undetected precisely because of this gap.
- **Confidence:** High
- **Recommended fix:** Add `@axe-core/playwright` with two smoke specs (landing/PIN screen, and a mock-connected room screen) × both themes, asserting zero violations; ~1 hour of work, catches contrast/labels/roles automatically from then on.

### [LOW] Modal scrim is a raw color literal (src/components/husk/primitives.tsx:165)
- **Category:** Design-system consistency
- **Evidence:** `bg-[oklch(0_0_0/0.45)]` — the only raw color value in a shipped component.
- **Why it matters:** Technically a token-file violation; practically it's a neutral alpha scrim, theme-invariant by intent. Worth fixing for consistency, low stakes.
- **Confidence:** High
- **Recommended fix:** Add `--scrim` token (same value both themes) and use it.

### [LOW] Spacing/radius values occasionally bypass the documented scale (chat.tsx:246 `min-h-11`, keypad `h-14`, various `p-3`/`gap-2`)
- **Category:** Design-system consistency
- **Evidence:** Spec scale is 4/8/12/16/24/32/48/96; `styles.css` defines those `--spacing-*` tokens, but components also use default Tailwind steps (12px=3 ✓ is in-scale, but `h-14`=56px, `min-h-11`=44px, `h-11`, `w-11` are off-scale).
- **Why it matters:** Cosmetic drift against the written contract; the 44px hits are touch-target driven and defensible.
- **Confidence:** High (factual), Low (impact)
- **Recommended fix:** Either bless 44/56 as named touch-target tokens or snap to the scale; do not silently accumulate off-scale values.

## Verified-Correct

- **All shipped colors come from the token file** — grep for Tailwind default-palette classes across `components/husk/` and `routes/` is clean; the token set (`@theme inline` + `:root`/`.dark` variables) is complete and both themes are fully authored palettes (styles.css:74-114), not an inversion trick. The only raw value is the modal scrim above; the only undefined-token usage is the 404/error screens above.
- **No emoji anywhere** — grep across `src/`, `worker/src/`, and README for emoji Unicode ranges: zero hits.
- **No unstyled native controls** — zero `<select>`, `type="date"`, `type="checkbox"`, `type="radio"` outside the unused `components/ui/` scaffold; the theme toggle is a custom `role="switch"` button with `aria-checked` (primitives.tsx:101-106); file input is a styled `sr-only` input triggered by a labeled button.
- **No `alert()`/`confirm()`/`prompt()`** — grep clean; the leave-room confirmation is a custom modal, transient feedback is a custom toast system with `aria-live="polite"` (primitives.tsx:212).
- **Keyboard reachability of the core flows** — every interactive element is a real `<button>`, `<input>`, `<textarea>`, or `<a>`; the custom keypad is focusable buttons with `aria-label`s; global `:focus-visible` outline uses a dedicated `--focus` token with offset (styles.css:135-138); Escape closes the modal. The gaps are the trap/restoration in the modal above — reachability itself is fine.
- **Connection indicator is always visible** — `ConnectionIndicator` renders unconditionally in the room header (`r.$pin.tsx:179`), has an `aria-live="polite"` region, uses color *plus* a status dot *plus* text (not color alone — passes 1.4.1 Use of Color), and appends "peer may be reconnecting" during grace.
- **Type system matches spec** — Inter everywhere, weights capped at 600, display/title/body/caption tiers with specified line-heights and letter-spacing (styles.css:53-69); radius scale exactly 6/8/12/16/24/pill (styles.css:37-42).
- **Contrast of the main reading surfaces passes comfortably** — body ink on canvas 15.7:1 (light) / 15.8:1 (dark); accent bubbles with `accent-ink` text 5.67:1 (light) / 7.88:1 (dark); danger and ok both ≥5.3:1 in light, ≥6.2:1 in dark.

## Phase Verdict

The design system is real and largely honors its own contract: complete dual-theme token palettes, zero default-palette usage, zero native controls, zero emoji, zero browser dialogs, custom keypad/switch/modal/toasts with honest ARIA, and comfortably passing contrast on all primary reading surfaces. The failures are localized: two token colors miss AA at caption size in light theme (and they're used for exactly the "something is wrong" statuses), the modal lacks focus trapping/restoration, the 404/error screens are written against a token set that doesn't exist, and the spec's automated-audit requirement has never been implemented. **Verdict: needs minor fixes** — nothing here is architectural; the contrast tweak, modal focus management, screen token port, and the axe scaffold are all small, bounded tasks.
