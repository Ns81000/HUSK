# HUSK — Phase-Based Paranoid Audit Prompt (Session 1: Analysis Only)

> Paste this entire file into a fresh Claude Code session opened at the root of the downloaded Husk project (the folder containing `package.json`, `src/`, and `worker/`). This session does **analysis only** — no code changes, no `git commit`, no `wrangler deploy`. Its only output is a set of markdown findings files plus one final generated prompt for a *second*, separate implementation session.

---

## 0. Who You Are Right Now

You are a paranoid, adversarial senior engineer doing a pre-launch audit of a security-sensitive application. Your working assumption is: **every comment, every README claim, every "this is handled" note in this codebase is unverified until you personally trace the code path and prove it.** The project's own spec document (`HUSK-lovable-prompt.md`) says this explicitly about the app's predecessor — an earlier project that claimed to be encrypted and zero-storage while actually being neither. Treat the current codebase with the same suspicion. Lovable-generated code frequently looks correct at a glance and is wrong in the details (race conditions, unhandled promise rejections, off-by-one lifecycle bugs, security checks that exist on paper but are bypassable).

Rules of engagement:
- **Never accept a comment or docstring as proof of behavior.** Read the actual implementation. If a comment says "rate limited" and the code doesn't actually reject anything, that's a finding, not a fact.
- **Never accept a test passing as proof of correctness** if the test doesn't actually exercise the hazardous path. A green test suite with weak assertions is worse than no test suite because it creates false confidence — call this out explicitly when you see it.
- **Trace, don't skim.** For every claim in `HUSK-lovable-prompt.md` (the original spec), find the exact file and line that implements it, or mark it UNVERIFIED / NOT IMPLEMENTED.
- **When in doubt, downgrade your confidence, don't upgrade it.** If you can't prove something is safe, record it as a risk, not as "probably fine."
- **This session does not fix anything.** You are building an evidence file. Fixing happens in a separate session (see Section 5). Do not edit source files in this session except to create the audit output files themselves.

---

## 1. Ground Truth About This Project

- **Stack:** React 18 + TypeScript + Vite, TanStack Router + TanStack Query, Zustand, Tailwind (custom tokens only). Backend: Cloudflare Workers + Durable Objects (one DO per room), WebSocket relay, client-side AES-256-GCM via Web Crypto API. Package manager: **pnpm** (root and `worker/` are a pnpm workspace — check `worker/pnpm-workspace.yaml`).
- **Non-negotiables from the original spec, in priority order:** Secure > Reliable > Simple > Scalable. The server must be architecturally incapable of reading plaintext. Full spec is in `HUSK-lovable-prompt.md` at the project root — read it in full before Phase 1.
- **Deployment target has changed since the spec was written:** the project must run on the **Cloudflare Workers Free plan with no credit card on file.** This rules out R2 (bucket creation requires billing verification even on the free tier). The fix in progress is to replace R2 file storage with **SQLite-backed Durable Object storage** (`new_sqlite_classes` in `wrangler.toml`), which is available on the Free plan with no billing requirement.
- **Known current-state facts to verify, not assume** (Cloudflare's docs and limits change — re-check them live rather than trusting this list, but use it as your starting hypothesis, current as of Aug 2026):
  - Workers Free plan: 100,000 requests/day, **10ms CPU time per invocation** (this is very tight — pure network/storage I/O wait time does not count against it, but any nontrivial synchronous work, e.g. large JSON parsing or base64 encode/decode of file chunks, can blow this budget), 50 external subrequests/request, 128MB memory, request body size limit up to 100MB on the Free Cloudflare plan.
  - Durable Objects are available on the Free plan with **zero commitment / no credit card** (this changed in April 2025 — confirm it is still true).
  - SQLite-backed DO storage: 5GB storage per account on Free plan, 10GB per individual Durable Object, but **each stored value (row/blob) is capped at 2MB**, and each key+value pair for the storage API is also capped at 2MB — meaning **any file bigger than ~2MB must be chunked** before being written to DO storage.
  - WebSocket message size limit is 32MiB per message (raised from 1MiB in Oct 2025) — check the actual chunking strategy against this, not the old 1MiB figure some tutorials still quote.
  - Durable Object WebSocket **Hibernation API** exists specifically so idle rooms don't burn compute — confirm the code actually uses it (`ctx.acceptWebSocket()` / hibernatable handlers), not a naive `addEventListener` pattern that would keep the DO pinned in memory (and billed) the whole time a room is open.
- **Do not trust the numbers above blindly.** Cloudflare limits change. In Phase 1, explicitly re-verify current limits via web search against `developers.cloudflare.com` before finalizing any finding that depends on them.

---

## 2. Required Reading Before Phase 1 (do this first, every time, fresh context or not)

1. `HUSK-lovable-prompt.md` — the full original spec. This is your source of truth for *intended* behavior.
2. `README.md`
3. `worker/wrangler.toml`, `worker/r2-lifecycle.json` (if still present), `worker/package.json`
4. Full directory listing of `src/`, `src/lib/husk/`, `src/components/husk/`, `worker/src/` — confirm the manifest below still matches reality; if files have moved or been renamed since this prompt was written, note that as your first log entry.
5. `package.json` (root) — confirm the actual test/build/lint commands (do not guess `pnpm test`; read the `scripts` block).

Known file map at time of writing (verify against the live tree — do not assume it's unchanged):
```
src/lib/husk/           crypto.ts, files.ts, protocol.ts, connection.ts, store.ts,
                         room-machine.ts, pin.ts, backoff.ts, config.ts, api.ts, linkify.ts, theme.ts
                         + matching *.test.ts for crypto, backoff, pin, linkify, room-machine
src/routes/             __root.tsx, index.tsx, r.$pin.tsx
src/components/husk/    chat.tsx, keypad.tsx, primitives.tsx, room-info.tsx, icons.tsx
worker/src/             index.ts, room.ts, rate-limit.ts (+ .test.ts), tickets.ts (+ .test.ts), config.ts, types.ts, globals.d.ts
```

---

## 3. Token-Efficiency Rules (follow strictly — this audit must not blow the context budget)

- Never paste an entire large file into your reasoning if a targeted `grep`/`rg` search or a specific line range answers the question. Use `view` with `view_range` instead of full-file reads once you know roughly where something lives.
- Read each file **once** per phase unless it changed. If Phase 3 needs the same file Phase 1 already fully read, refer to your own Phase 1 notes/log file instead of re-reading, unless you specifically need to re-verify something.
- When quoting code in a findings file, quote the **minimum snippet** needed (a few lines), never a whole function, unless the whole function is the actual bug.
- Batch related greps into one command (`grep -rn "pattern1\|pattern2"`) rather than issuing many single-pattern searches.
- Summarize test output (pass/fail counts, specific failure messages) rather than pasting full verbose logs.
- Do not re-run the full test suite more than once per phase unless you changed something (you shouldn't be changing anything in this session) or a prior run was inconclusive.

---

## 4. The Six Audit Phases

For **every** phase:
- Create the output file at the path given, using the findings-table format in Section 4.0.
- End every phase file with a one-paragraph **Phase Verdict**: is this area "audit-clean," "needs minor fixes," or "has blocking issues," and why.
- Do not move to the next phase until the current phase's markdown file is fully written to disk.
- Cite exact `file:line` for every finding. If you cannot pin a line number, say so — that itself is worth noting (means the issue is diffuse/architectural).

### 4.0 Findings Table Format (use this exact structure in every phase file)

```markdown
# Phase N — <Name>

## Summary
<2-4 sentences: what you inspected, what commands you ran, overall impression>

## Findings

### [SEVERITY] Short title (file:line)
- **Category:** Security / Reliability / Race Condition / Performance / UX / Accessibility / PWA / Test Gap / Architecture
- **Evidence:** <exact code snippet or command output proving the issue — minimum needed>
- **Why it matters:** <concrete failure scenario, not generic risk language>
- **Confidence:** High / Medium / Low
- **Recommended fix:** <specific, e.g. "add sequence-number dedup check in room.ts handleMessage()" not "improve error handling">

(repeat for each finding, ordered Critical → High → Medium → Low)

## Verified-Correct (things you checked and are actually fine — say so, don't only report bad news)
- <item> — verified by <how>

## Phase Verdict
<one paragraph>
```

Severity definitions:
- **Critical** — breaks the E2EE/zero-storage security promise, or crashes/data-loss for all users, or blocks deployment entirely.
- **High** — exploitable security weakness in a realistic scenario, or a reliability bug that loses messages/files or corrupts room state under normal (not adversarial) conditions.
- **Medium** — real bug/gap but requires unusual conditions, or a significant UX/PWA/a11y defect.
- **Low** — polish, minor inefficiency, style/consistency issue.

---

### Phase 1 — Backend, Architecture & R2→Durable-Object Migration
**Output:** `docs/audit/phase-1-backend-architecture.md`

Objective: determine the exact current state of the R2 dependency, and produce a precise, evidence-based migration plan to SQLite-backed Durable Object storage — without writing any code yet.

Checklist:
1. Read `worker/wrangler.toml` in full. List every binding (`[[r2_buckets]]`, KV namespaces, DO bindings, `compatibility_date`, `compatibility_flags`). Confirm whether `new_sqlite_classes` is present or whether the DO class is still KV-backed (`migrations` block matters here — check for existing `[[migrations]]` entries, since switching an *existing deployed* DO class from KV-backed to SQLite-backed requires a new migration tag, not just changing the class).
2. Read `worker/src/room.ts` end-to-end. Map every place it touches `env.HUSK_FILES` (or whatever the R2 binding is actually named — verify the name, don't assume) or any R2 API (`.put`, `.get`, `.delete`, `.createMultipartUpload`, presigned URLs).
3. Read `worker/src/index.ts` for any additional R2 usage (e.g., route handlers that construct signed URLs directly).
4. Read `src/lib/husk/files.ts` — map exactly how the client currently uploads/downloads (direct-to-R2 presigned PUT/GET, or proxied through the Worker/DO?). This determines how much of the client code needs to change vs. just the endpoint URL.
5. Check `worker/r2-lifecycle.json` — confirm what lifecycle policy it encodes (this logic needs an equivalent replacement: DO-side purge-on-close/expire, not an external lifecycle rule).
6. Re-verify current Cloudflare facts via web search (don't trust this prompt's numbers as final): DO Free plan availability, SQLite storage per-value size cap, WebSocket message size cap, Workers Free CPU-per-request cap. Cite the actual `developers.cloudflare.com` pages you found them on.
7. Given the 2MB-per-value SQLite storage cap, work out and document the exact chunking scheme needed for files (e.g., "split ciphertext into N KB chunks, store as rows keyed by `file:<id>:chunk:<n>`, store a manifest row with chunk count + total size + mime type"). Do the arithmetic: what's the realistic max file size Husk can support under Free-plan storage-per-account (5GB) and per-DO (10GB) caps, accounting for the fact that many rooms may be open concurrently, each holding files in the *same* DO's storage.
8. Check `worker/src/rate-limit.ts` and `worker/src/tickets.ts` — do these depend on KV, and is KV usage (also billing-free on the free tier, confirm) staying as-is or does it need changes too?
9. Check whether the WebSocket handling in `room.ts` uses the Hibernation API (`ctx.acceptWebSocket`, `webSocketMessage`/`webSocketClose`/`webSocketError` handlers on the DO class) or a plain in-memory `WebSocketPair` with `.accept()` + `addEventListener` (the latter defeats hibernation and keeps the DO — and its cost — always-on while a room is open).
10. Confirm the exact idle-timeout/room-expiry mechanism (Durable Object Alarms — `ctx.storage.setAlarm`) actually exists and actually purges both message state and any file chunk storage, not just closes the WebSocket.
11. Run `pnpm --filter worker exec tsc --noEmit` (or the correct equivalent — check `worker/package.json` scripts first) and record any type errors as findings.
12. Produce a concrete "R2 Removal Plan" subsection at the end of this file: exact list of files to change, exact new wrangler.toml shape, exact new DO methods needed, exact client-side `files.ts` changes, and the realistic file-size ceiling you calculated in step 7. This plan feeds directly into the implementation prompt in Phase 6 — write it as if a future engineer with zero other context needs to implement it from this section alone.

---

### Phase 2 — Security & Cryptography
**Output:** `docs/audit/phase-2-security-crypto.md`

Objective: verify the "server is architecturally incapable of reading plaintext" claim is actually true in code, not just in the README.

Checklist:
1. Read `src/lib/husk/crypto.ts` and `crypto.test.ts` fully. Verify: AES-256-GCM is actually used (correct algorithm name, correct key length, correct IV/nonce generation — **must be a fresh random IV per message, never reused** — this is the single most common catastrophic AES-GCM bug: IV reuse under the same key leaks plaintext). Check IV storage/transmission: is it sent alongside ciphertext (fine) or derived predictably (bug)?
2. Confirm the room key `K` genuinely never leaves the URL fragment — grep the entire `src/` and `worker/` trees for anything that could transmit it: query params, POST bodies, `console.log`, error reporting (`src/lib/error-capture.ts`, `src/lib/lovable-error-reporting.ts` — **these are exactly the kind of code that accidentally logs sensitive state**, read them carefully), analytics, `localStorage`/`sessionStorage` (a key persisted here could survive tab close in ways that violate "ephemeral").
3. Check `src/routes/r.$pin.tsx` and `src/routes/index.tsx` for exactly how the key is read from `location.hash` and whether it's ever accidentally included in a navigation, a `fetch` URL, or re-serialized into router state that could end up in browser history as a full URL (TanStack Router state, not just the hash).
4. Verify the Worker/DO genuinely never receives the key: read every `fetch`/WebSocket message the client sends (`src/lib/husk/connection.ts`, `protocol.ts`) and confirm none of them include `K` in any form (raw, base64, hash of it used as an auth token, etc. — even a hash of the key sent to the server for "verification" would be a design flaw against the spec).
5. Check `worker/src/rate-limit.ts`: does it actually throttle, or does it just track counts without enforcing? Trace the exact code path from "too many requests" being detected to a response actually being rejected (correct HTTP status, not silently allowed through).
6. Check `worker/src/tickets.ts`: what problem do "tickets" solve (likely join-auth) — verify tickets can't be replayed, guessed, or brute-forced, and that they expire.
7. PIN entropy: read `src/lib/husk/pin.ts` and `pin.test.ts`. Confirm actual randomness source (`crypto.getRandomValues`, not `Math.random`), actual space (spec says 6-digit/900,000 combinations — verify the real range, check for excluded PINs, e.g. leading zeros stripped changing the real space).
8. XSS: grep for `dangerouslySetInnerHTML`, `innerHTML`, or any raw HTML injection anywhere messages/filenames/usernames flow through rendering (`chat.tsx`, `linkify.ts` — link auto-detection is a classic XSS vector if it ever builds an href from unsanitized input or matches `javascript:` URIs). Verify `linkify.ts`'s regex/parsing can't be tricked into producing a dangerous `href`.
9. Check CORS configuration and security headers in `worker/src/index.ts` / `src/server.ts` — is CSP present, is it meaningfully restrictive or just `default-src *`, are frame-ancestors/X-Frame-Options set to prevent clickjacking on a chat app.
10. Dependency audit: run `pnpm audit` (root and `worker/`) and record any high/critical CVEs in direct or transitive dependencies relevant to crypto, XSS, or the server runtime.
11. Check `.env`/config files aren't accidentally committed with real secrets (`worker/src/config.ts`, `src/lib/husk/config.ts`) — and that `.gitignore` actually excludes them (it's listed in the manifest — read it).
12. Security test coverage: does anything in the test suite actually attempt any of the above attacks (captured-frame plaintext read, brute-force join, XSS payload), or does the spec's Section 8 "Security tests" requirement exist only on paper? Report honestly if these tests don't exist yet — that's a Critical-category test gap, not a pass.

---

### Phase 3 — Reliability, Concurrency & Race Conditions
**Output:** `docs/audit/phase-3-reliability-races.md`

Objective: find every place simultaneous or out-of-order events can corrupt state, referencing every edge case explicitly listed in Section 6 of the original spec.

Checklist:
1. Read `src/lib/husk/room-machine.ts` + test file fully — enumerate every state and every transition. For each transition, ask: what happens if this event fires twice in a row, or fires while another transition is mid-flight (React state updates are not synchronous — check for stale-closure bugs in any WebSocket event handler that reads Zustand/router state).
2. Read `src/lib/husk/connection.ts` and `backoff.ts` — verify reconnect/backoff logic: does it cap max retries or backoff time (unbounded exponential backoff without jitter can cause thundering-herd reconnect storms against the DO after any brief edge outage)? Confirm a genuinely dead connection eventually reaches a terminal "disconnected, here's what to do" UI state rather than retrying forever silently (spec explicitly forbids infinite unexplained spinners).
3. Duplicate-tab-same-identity: trace exactly what happens server-side (in `room.ts`) when two WebSocket connections authenticate as the same room — is message ordering/broadcast handled correctly for N connections, not just 2? Any assumption anywhere that hardcodes "exactly 2 participants"?
4. Host crash / no graceful disconnect: verify the DO Alarm-based idle-timeout is the only mechanism relied on (not a client-side "beforeunload" that malicious or crashed clients simply won't fire). Confirm timer duration matches spec (or note the discrepancy) and that it fires even if literally zero further requests reach the DO.
5. File upload interrupted mid-transfer: given the Phase 1 R2-removal plan, what does "interrupted" mean under the new DO-storage chunked scheme — is there partial-chunk cleanup, or could an interrupted upload leave orphaned chunk rows in DO storage forever (this is a **new** race/leak risk introduced by the R2 removal — explicitly flag it even though the original spec's answer, "R2 lifecycle policy," no longer applies).
6. Room PIN collision on creation: find the actual collision-handling code path in `worker/src/index.ts` or wherever room creation happens. Confirm it actually retries with a new PIN and never surfaces the collision to the user, and confirm there's a retry limit (infinite retry loop under DO namespace contention is itself a hazard).
7. Message sequence numbers: read `protocol.ts` — is there an actual sequence number / ordering guarantee, and what happens if a message arrives out of order or is dropped by the WebSocket transport? Any dedup logic for a message the client might resend after a reconnect?
8. Check `store.ts` (Zustand) for any place multiple async callbacks can write to the same slice of state without any check for staleness (e.g., a slow file-decrypt promise resolving after the user has already left the room and the store has been reset — does it defensively no-op, or does it throw/corrupt state?).
9. Clipboard/share fallback: verify `room-info.tsx` actually has a working fallback UI (selectable text field) when `navigator.clipboard` is unavailable or rejects, not just a try/catch that silently swallows the error.
10. Run the actual test suite (`pnpm test` — confirm exact command from `package.json` first) and separately `pnpm --filter worker test` for the worker package. Record pass/fail counts and specifically flag any test that is skipped, `.only`'d (meaning other tests are being silently excluded), or has weak assertions (e.g., only checks something didn't throw, not that the resulting state is correct).

---

### Phase 4 — Frontend Runtime, PWA & Cross-Platform Native Feel
**Output:** `docs/audit/phase-4-frontend-pwa.md`

Objective: verify the app is actually a robust, installable, offline-tolerant PWA with genuinely native-feeling behavior on Android and desktop — not just styled to look that way.

Checklist:
1. Locate the PWA manifest and service worker (search for `manifest.json`/`manifest.webmanifest`, any `vite-plugin-pwa` config in `vite.config.ts`, any `sw.ts`/`sw.js`). If none exists, this is a Critical/High finding against the user's explicit PWA requirement — do not assume it exists because the user mentioned wanting one.
2. If a service worker exists: what's the actual caching strategy for the app shell vs. for the WebSocket connection (a WebSocket cannot be cached/served offline — verify the app degrades gracefully, e.g. shows a clear "you're offline" state, rather than a broken blank chat when the SW serves a stale shell but the live connection can't establish).
3. Check installability: valid manifest icons (multiple sizes, maskable icon present for Android adaptive icons), `theme_color`/`background_color` set, `display: standalone` or equivalent, HTTPS (Workers deployment gives this by default — confirm no mixed-content issues).
4. Safe-area handling: grep for `env(safe-area-inset-*)` usage — confirm it's actually applied to the bottom action bar and any fixed-position elements described in spec Section 7 ("Mobile-native feel"), not just declared once and unused.
5. Touch targets: spot-check `keypad.tsx` and the primary action bar components against the spec's 44×44px minimum.
6. Verify the numeric keypad in `keypad.tsx` is genuinely a custom component (per spec, explicitly *not* the OS native number pad) and works correctly with keyboard input too (accessibility — a touch-only custom keypad with no keyboard equivalent fails WCAG).
7. Desktop-specific layout: confirm `chat.tsx`/routes actually render a distinct sidebar+main-pane desktop layout via responsive logic, not a single mobile-first layout just stretched with CSS (check for actual breakpoint-driven structural differences, not only width changes).
8. Keyboard shortcuts: verify Enter-to-send / Shift+Enter-for-newline actually work and don't conflict with IME composition (important for non-Latin input methods — a common overlooked bug: sending on Enter mid-IME-composition).
9. Background/foreground handling: check for `visibilitychange` or `document.hidden` handling — does the WebSocket connection get intentionally suspended/resumed on backgrounding (mobile browsers throttle/kill background tabs), and does state resync correctly on foreground per the spec's ">8 seconds background" reconnect requirement?
10. Bundle size and code-splitting: run `pnpm build` and inspect the actual output size (`dist/` or equivalent) — flag anything unreasonably large (unsplit vendor chunk, unused UI library components from `src/components/ui/` bloating the bundle if many are unused — cross-reference which `ui/*.tsx` files are actually imported anywhere vs. dead weight from the shadcn scaffold).
11. Check `src/routes/__root.tsx` for error boundary coverage — does a runtime error in one route crash the whole app to a blank white screen, or is there a real fallback UI (`error-page.ts` — verify it's wired up, not just defined and unused).

---

### Phase 5 — Design System & Accessibility Compliance
**Output:** `docs/audit/phase-5-design-accessibility.md`

Objective: audit against the exact constraints in spec Section 7 (design tokens, no unstyled native controls, dual-theme, WCAG AA) — this is a compliance check against a written contract, treat deviations as findings even if they look fine visually.

Checklist:
1. Confirm all colors/spacing/radii genuinely come from a custom token file (check `src/styles.css` and Tailwind config) — grep for any raw hex codes, `rgb()`, or default Tailwind palette classes (`bg-blue-500`, `text-gray-700`, etc.) used directly in component files instead of token-based classes. Every hit is a spec violation.
2. Confirm no emoji anywhere in UI copy or code comments — grep the emoji Unicode ranges across `src/`.
3. Verify dark and light themes are both fully implemented (not one theme + a naive CSS `invert()` or incomplete token overrides) — check `theme.ts` and confirm every token has both variants defined.
4. Confirm every native control the spec lists as forbidden-if-unstyled is actually custom: `<select>`, date inputs, checkboxes, radios — grep for raw `<select`, `<input type="date"`, `<input type="checkbox"` outside of the `ui/checkbox.tsx` wrapper itself.
5. Confirm no `alert()`/`confirm()`/`prompt()` anywhere (grep) — spec explicitly forbids these; a custom modal/toast system must be used instead.
6. Run an automated accessibility audit (axe-core or equivalent — check if already a dependency; if not, note that as a test gap and describe exactly how to add it rather than skipping the check entirely) against the main room-create, PIN-entry, and chat screens in both themes. Record every violation with its WCAG success criterion.
7. Keyboard-only navigation: manually trace tab order through the join/create flow and the chat screen — can every interactive element (including custom keypad, custom modals, toasts) be reached and activated without a mouse? Check for focus traps in modals (`alert-dialog.tsx`, `dialog.tsx`) and focus restoration on close.
8. Color contrast: spot-check the defined token values (from `theme.ts`/`styles.css`) against WCAG AA (4.5:1 body text, 3:1 large text/UI components) for both themes — do the actual math on at least the primary text/background and accent-on-background pairs, don't eyeball it.
9. Connection-status indicator: confirm per spec it's "always visible, never hidden" — find the actual component and verify there's no code path (e.g., a specific route or narrow viewport) where it's conditionally unmounted.

---

### Phase 6 — Performance, Test-Coverage Gaps & Final Synthesis
**Output:** `docs/audit/phase-6-performance-testgaps.md` **and** `docs/audit/IMPLEMENTATION_PROMPT.md`

Objective: close out with performance findings, a full test-coverage gap analysis against spec Section 8, and — as the final act of this session — synthesize everything from Phases 1–6 into one ready-to-paste implementation prompt.

Checklist (performance + test gaps):
1. Re-read spec Section 8 line by line. For each required test category (unit: crypto round-trip, PIN entropy/format, sequence ordering, state machine transitions, rate-limit logic; integration: full create→join→message→file flow; edge cases: the 6 rows explicitly listed; security tests: 4 explicitly listed; accessibility: axe + keyboard + contrast; manual QA pass) — mark it Present-and-Adequate / Present-but-Weak / Missing, with evidence (file + what it actually asserts).
2. Check for obvious runtime performance issues: unnecessary re-renders in `chat.tsx` (missing memoization on message list items causing full-list re-render per keystroke in the composer), unbounded message history in memory (does a very long-running room's message list ever get virtualized, or will a multi-hour room with thousands of messages degrade?).
3. Check WebSocket message handling for any synchronous heavy work on the main thread that should be off-loaded (large file decrypt blocking UI — is a Web Worker or at least chunked/yielding async decrypt used for large files?).
4. Estimate real-world token/compute efficiency of the *Worker* side specifically against the Free plan's 10ms CPU/request budget from Phase 1 — flag anything (JSON stringify/parse of large payloads, synchronous chunking loops) that could realistically approach or exceed it under a large file transfer.
5. Produce a final measured or estimated Lighthouse-style assessment if tooling is available (`pnpm build` + a static analysis is fine if a live Lighthouse run isn't feasible in this environment — say explicitly which you did).

**Final synthesis task — do this last:**

Read every file in `docs/audit/phase-1-*.md` through `phase-6-*.md` (skip re-reading source files themselves; your own findings files are the input now). Produce `docs/audit/IMPLEMENTATION_PROMPT.md` using the exact template in Section 5 below, filled in with the *actual* findings you generated — grouped, deduplicated, and ordered by dependency and severity, not by which phase found them. This file is the entire deliverable of this session that matters most to the user — it is what gets pasted into a brand-new Claude Code session to do the real fixing.

---

## 5. Template for the Generated Implementation Prompt

Use this structure verbatim as the skeleton for `docs/audit/IMPLEMENTATION_PROMPT.md`, replacing every `<...>` with real content drawn from your Phase 1–6 findings files. Do not leave placeholder text in the final output.

```markdown
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
  (`pnpm test`, `pnpm --filter worker test`, `pnpm build`, `tsc --noEmit`, and any
  manual verification steps the phase specifies) -> hunt HARD for new bugs your
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

## Implementation Phase 1 — <e.g. "R2 Removal / SQLite Durable Object Storage Migration (BLOCKING)">
<Exact scope pulled from the Phase 1 audit's "R2 Removal Plan" subsection: files to
change, new wrangler.toml shape, new DO methods, client changes, file-size ceiling.>

## Implementation Phase 2 — <e.g. "Critical & High Security Fixes">
<Every Critical/High finding from Phase 2 audit, each as a concrete task.>

## Implementation Phase 3 — <e.g. "Reliability & Race-Condition Fixes">
<Every Critical/High finding from Phase 3 audit, plus the new orphaned-chunk-cleanup
risk introduced by the R2 migration, as a concrete task.>

## Implementation Phase 4 — <e.g. "PWA, Frontend Runtime & Cross-Platform Fixes">
<Findings from Phase 4 audit.>

## Implementation Phase 5 — <e.g. "Design System & Accessibility Compliance">
<Findings from Phase 5 audit.>

## Implementation Phase 6 — <e.g. "Performance, Test-Coverage Gaps & Final Hardening">
<Findings from Phase 6 audit, including writing any Missing tests identified in the
Section 8 gap analysis.>

## Final Step
After Phase 6's log is written and all tests pass, produce a top-level
`docs/implementation/SUMMARY.md` listing every change made across all phases,
current test status, and exact commands to deploy to Cloudflare Workers on the
Free plan (from the Phase 1 R2-removal plan's deployment steps).
```

---

## 6. Reference Resources (read the ones relevant to whichever phase you're on; don't front-load all of them into context at once)

- Cloudflare Workers overview & limits: `https://developers.cloudflare.com/workers/`, `https://developers.cloudflare.com/workers/platform/limits/`
- Durable Objects (core concepts, SQLite storage, limits, WebSocket Hibernation, Alarms): `https://developers.cloudflare.com/durable-objects/`, `https://developers.cloudflare.com/durable-objects/platform/limits/`, `https://developers.cloudflare.com/durable-objects/best-practices/websockets/`, `https://developers.cloudflare.com/durable-objects/api/alarms/`
- Wrangler configuration reference (for the `new_sqlite_classes` / `migrations` block syntax): `https://developers.cloudflare.com/workers/wrangler/configuration/`
- Workers KV (for rate-limit/ticket storage, if it stays): `https://developers.cloudflare.com/kv/`
- Workers pricing (confirm current Free vs Paid boundaries before finalizing the R2 plan): `https://developers.cloudflare.com/workers/about/pricing/`
- Web Crypto API (AES-GCM correctness reference): `https://developer.mozilla.org/en-US/docs/Web/API/Web_Crypto_API`, `https://developer.mozilla.org/en-US/docs/Web/API/SubtleCrypto/encrypt`
- PWA installability & service worker guidance: `https://developer.chrome.com/docs/workbox/`, `https://vite-pwa-org.netlify.app/`
- WCAG 2.1 quick reference (for Phase 5): `https://www.w3.org/WAI/WCAG21/quickref/`
- TanStack Router / Query docs (for Phase 3/4 correctness checks): `https://tanstack.com/router/latest`, `https://tanstack.com/query/latest`

When any finding depends on a specific numeric limit or platform behavior, fetch the live page above rather than trusting this prompt's cached numbers — Cloudflare's free-tier terms have changed multiple times in the past year and will likely change again.

---

## 7. What "Done" Means for This Session

This session is complete when all of the following exist on disk:
- `docs/audit/phase-1-backend-architecture.md` through `docs/audit/phase-6-performance-testgaps.md`
- `docs/audit/IMPLEMENTATION_PROMPT.md`, fully filled in (no placeholder text), ready to paste into a new session

Do not stop early. Do not skip a phase because it "looks fine at a glance" — that is exactly the failure mode this audit exists to catch.