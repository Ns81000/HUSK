# HUSK — Live Deployment Test Session (Session 7): Adversarial Verification of the Deployed App

You are continuing the Husk project (ephemeral, end-to-end encrypted chat and
file sharing; React + TanStack Start frontend; Cloudflare Workers + SQLite
Durable Objects relay). Phases 1–6 of the hardening plan are complete, the app
is **deployed live on the Cloudflare Free plan**, and two critical
post-deployment defects were already found and fixed by testing the real
deployment. **This session's mission: adversarially test the live deployment
in every way you can imagine — every scenario, edge case, race condition,
timing window, and failure mode — and fix everything you find.**

## Read these files FIRST, in full

```text
prompts/implementation/SUMMARY.md            (all phases condensed + live-deploy facts + gotchas)
prompts/implementation/phase-6-log.md        (coverage matrix, Lighthouse, CPU analysis)
prompts/implementation/phase-3-log.md        (reliability design: reconnect, dedup, grace)
prompts/implementation/phase-4-log.md        (PWA/SW cache policy)
prompts/implementation/phase-1-log.md        (storage/ticket design)
prompts/implementation/phase-2-log.md        (CSP, join tokens, security tests)
worker/src/index.ts, worker/src/room.ts, worker/src/gate.ts, worker/src/config.ts, worker/src/rate-limit.ts, worker/src/tickets.ts
src/lib/husk/store.ts, src/lib/husk/connection.ts, src/lib/husk/files.ts, src/lib/husk/protocol.ts, src/lib/husk/room-machine.ts, src/lib/husk/api.ts
src/routes/r.$pin.tsx, src/components/husk/chat.tsx, src/components/husk/room-info.tsx
public/sw.js, src/server.ts
```

The docs in `prompts/implementation/` are ground truth for intended behavior.
If live behavior contradicts them, that is a bug — fix the code or fix the
doc, and say which in the log.

## The deployed environment (facts)

- Relay Worker: `https://husk.ns8pc1.workers.dev`
- Frontend Worker (SSR): `https://ns81000-husk.ns8pc1.workers.dev`
- Cloudflare account: `ns8pc1@gmail.com` (Free plan; wrangler is logged in on
  this machine — `cd worker && pnpm exec wrangler whoami` to confirm).
- `HUSK_TICKET_SECRET` is set as a wrangler secret (never print it).
- Storage: both DO classes are SQLite (`v1` / `new_sqlite_classes`); rate
  limits live in the single `HuskGatekeeper` DO. No KV, no R2.
- Server-side limits in effect: Free plan 10 ms CPU/request (NOT declarable —
  a `[limits]` block fails deploys with error 100328), 25 MB max file,
  100 MB max per room, 10 participants, 10 joins / 5 min per IP+PIN with
  escalating backoff, rooms purge after 31 min idle / 24 h max lifetime.
- **Deploy quirks (already hit, documented):** relay deploy must run from
  `worker/` with `<root>/.wrangler/deploy/config.json` deleted first; frontend
  deploy must run from repo root using
  `worker\node_modules\.bin\wrangler.cmd deploy --compatibility-date 2025-01-01`
  (nitro stamps the build date into `.output/server/wrangler.json` and the
  pinned wrangler rejects "future" dates). Build the frontend with
  `$env:VITE_WORKER_URL = "https://husk.ns8pc1.workers.dev"` set first.

## Verified baseline (do not re-litigate; re-run to confirm)

- `pnpm test` — 14 files, **107/107** (includes 22 workerd integration tests).
- `pnpm exec tsc --noEmit -p tsconfig.json` and
  `pnpm exec tsc --noEmit -p worker/tsconfig.json` — pass.
- `pnpm test:a11y` — 12/12 (local production build under workerd).
- Live-verified before this session: create/join/socket/relay/ack; join after
  real isolate eviction (75 s idle); seq continuity across eviction; file
  grant → 3-chunk upload → streamed GET byte equality (node + real-browser
  Playwright runs); CORS (allowed origin gets ACAO, disallowed gets none);
  CSP hashes present on the live frontend.
- Lighthouse (13.4.1, local workerd): `/` mobile 97 / desktop 100; room page
  mobile 96 / desktop 100; a11y 100 everywhere.

## Already-fixed post-deploy bugs (do not re-report as new)

1. Room lifecycle state was isolate-memory-only → DO eviction broke joins,
   reconnects, and file grants ("Room unavailable" everywhere). Fixed by
   persisting `room-state` to SQLite; regression test simulates the cold
   reconstruct (wipe fields + `restoreVolatileState()`).
2. Chunk PUT cap rejected the 16-byte AES-GCM tag overhead → every upload
   over ~1 MiB failed with 400. Fixed with `CIPHER_OVERHEAD_BYTES`; tests pin
   cap-exact accepted / cap+1 rejected.
3. File input usable while room not open → doomed grant with empty member.
   Fixed: input disabled pre-open + `onSendFile` guard into the Retry state.

## Rules

- **Find bugs by testing the live deployment. When you find one: root-cause
  it, fix it, add a regression test at the most local reliable seam (extend
  the workerd harness — see the eviction-sim pattern — for live-only
  behaviors), redeploy, and re-verify live.** A bug is not done until the
  regression test exists or the log explains why no seam exists.
- Live testing artifacts (scratch scripts, screenshots, JSON dumps) are
  working files: keep them in a `live-tests/` scratch directory and delete
  them before committing (or commit genuinely reusable harness scripts if
  they are deterministic and useful — your call, but never commit secrets or
  room-key fragments).
- **Mind the rate limiter while testing:** 10 joins / 5 min per IP+PIN, and
  the backoff escalates (60 s → 1 h). Read `rate-limit.ts`/`gate.ts` keying
  first, then design tests to use fresh PINs; hammer only expendable PINs —
  a 1 h strike against a PIN you still need blocks further tests on it.
- Rooms are ephemeral: test rooms purge after ~31 min idle. Do not rely on
  state across long gaps; never "clean up" server state manually.
- `pnpm` exclusively. Do not push commits. Do not touch Cloudflare dashboard
  settings. Do not print the ticket secret. Kill any `workerd`/`wrangler dev`
  process you start (leftovers lock `.output` and break the next build).
- Do not break the existing suite; keep touched files Prettier-formatted; the
  repo-wide lint baseline is red by design — leave it.
- Keep logs factual. No estimates presented as measurements; every claim in
  the log gets its evidence (status codes, `wrangler tail` output,
  screenshots, request bodies).

## Test toolbox (build these first, reuse across scenarios)

1. **Playwright driver against production** (`live-tests/live-drive.mjs` —
   the Phase 6 session's throwaway version caught the chunk-cap bug):
   - real browser, real relay, no route mocking;
   - capture console/pageerror/requestfailed/all ≥400 responses/POST bodies;
   - `page.waitForURL(/\/r\//)` with hydration settle (clicks before
     hydration are silent no-ops — retry up to 3×);
   - `setInputFiles` for file scenarios (note: it bypasses `disabled` —
     a failed-composer path can be the correct observed behavior);
   - mobile emulation + CPU/network throttling via CDP
     (`Network.emulateNetworkConditions`, `Emulation.setCPUThrottlingRate`,
     `Network.emulateOffline`).
2. **Two isolated identities:** two `browser.newContext()` instances (the
   incognito equivalent) — A creates, B joins via the link; extract the key
   fragment from A's URL (`#/fragment`) and give it to B's page URL.
3. **Raw protocol driver** (`live-tests/ws-probe.mjs`): Node ≥24 has global
   `fetch`/`WebSocket`; call `/room/create`, `/room/join`, open the socket
   with `?jt=`, send client frames, assert server frames (welcome / relay /
   ack / presence / closed). This reaches behaviors the UI cannot trigger.
4. **Server-side observation:** `cd worker && pnpm exec wrangler tail husk
--format pretty` in a separate process while tests run — correlate client
   failures with exceptions/log lines. This is your only server visibility.
5. **Frame injection:** send raw strings / malformed JSON / oversized fields
   over the WebSocket to exercise the malformed-frame path.

## Scenario matrix — work through ALL of it; log a row for each

### A. Core flows, two identities

1. A creates, B joins via link in a second context: both see 2 participants.
2. Messages both directions; ordering identical on both sides; delivery
   `sending → sent` on both.
3. File both directions (small ~10 KB, mid ~3 MB, large ~10 MB, exactly
   25 MB): upload → sent bubble → download on the other side → **byte
   equality** asserted in the page (fetch the downloaded Blob, compare).
4. Third through 10th participant join; the 11th refused (in-room `error`
   frame path — public probes 404).
5. Invite link in a fresh context: key only in the fragment; verify via
   `wrangler tail` that no fragment ever reaches the server.

### B. Lifecycle, eviction, reconnect

6. **Isolate eviction mid-room:** create + connect, close sockets, wait 60–90
   s (real eviction), rejoin from both contexts — room alive, seq continues.
7. Send, wait 60–90 s with sockets open (hibernation wake), send again — seq
   continues, no duplicate localIds.
8. Background a tab >8 s → return → "Reconnecting" → auto-reconnect → no
   duplicate bubbles → an unacked send flips to `failed` with working Retry.
9. Kill A's context entirely (no leave) → B sees the grace window ("peer may
   be reconnecting") → then "waiting for peer" + system note (verify copy).
10. Reconnect termination: abort all relay requests (route/CDP offline) past
    the attempt budget → terminal `closed_disconnected` + Reconnect button →
    unblock → manual Reconnect works; browser `online` auto-recovers it.
11. Both peers offline simultaneously → both recover on `online` → seq
    continuity across the double reconnect.
12. Host leaves via the modal → guests get `closed` → terminal state; the
    room stays joinable for fresh joins until the idle purge.

### C. Races and concurrency

13. Two contexts join simultaneously at the capacity edge (9 in, both at
    once) → never more than 10 participants, atomic behavior.
14. Rapid double-send (spam Enter) → one bubble per send, all acked.
15. Duplicate-tab: same room in two tabs of one context → distinct
    participants, both relays, count includes both (documented intended
    behavior — verify and note).
16. Send while reconnecting (outbox buffering) → frames flush on reconnect →
    exactly one relay each (DO resend dedup), original seq re-acked.
17. Missed-message semantics: A sends while B is disconnected → B does NOT
    receive it after reconnect (no backfill by design — verify the UI does
    not pretend otherwise, flag if it feels like silent data loss).
18. Cancel an upload mid-flight (close tab during a big upload) → cancel
    frame or alarm purge frees the budget → the next 25 MB grant succeeds.

### D. File edge cases (raw probe AND browser)

19. 0-byte file → EmptyFileError path, no request sent.
20. 1-byte; exactly 1 MiB; 1 MiB + 1; exactly 25 MB (~24 chunk PUTs); 25 MB
    - 1 (client-side rejection, no network request); room budget via
      multiple files from two peers → 507 surfaced in UI.
21. Concurrent uploads from two peers (interleaved grants) → both succeed,
    budget intact (fileOpQueue serialization).
22. Download by a peer AFTER the sender closed their socket (files outlive
    the sender within the room lifetime).
23. Cancel mid-upload → rows deleted, budget refunded (prove by an
    immediate full-size grant succeeding).
24. GET replay within room lifetime (documented, deliberate) → both
    downloads succeed.
25. Tampered `sig`/`exp` → 403; wrong-pin file GET → 404/403.

### E. Security and abuse (live)

26. 11 rapid joins on one expendable PIN → 429 with `retryAfter`; observe
    escalation; then abandon that PIN.
27. Join-token replay → generic 404 byte-identical to a nonexistent room's.
28. Forged/expired token; tokenless socket probe → same generic 404.
29. Unsigned file GET; forged `sig`; expired `exp` → 403/404.
30. CORS matrix on every route: allowed origin (ACAO), disallowed origin
    (none), no origin at all (served without ACAO — document the safety
    rationale: browsers are the threat model).
31. XSS live: `javascript:`/`data:` link payloads, `<img onerror>` filename,
    quote-breakout — all inert in the real browser.
32. CSP: zero console violations on every screen; recount inline-script
    hashes on the live page; iframe the frontend → must not render.
33. Malformed WS frames (garbage strings, huge strings, wrong shapes) →
    connection survives, other peers unaffected, client `malformedCount`
    grows; server stays healthy in `wrangler tail`.

### F. Network adversity

34. CDP offline mid-typing → distinct "You are offline" banner → online →
    auto reconnect → queued text sends.
35. Offline → PWA: landing loads from the cache shell; `/r/<pin>` never
    served stale; SW policy holds (relay never intercepted).
36. Throttled 3G + packet loss → bounded reconnects, no infinite spinner, no
    duplicate bubbles.
37. Throttle to ~50 kB/s mid-3 MB upload → PUTs complete (no client timeout
    races them), progress advances, message sends.

### G. Frontend, PWA, a11y on the live site

38. Axe sweep live: landing, PIN-entry, room, open-modal; both themes; zero
    wcag2a/2aa/21a/21aa violations.
39. Keyboard-only walkthrough: create → keypad → composer → attach → modal
    (trap, wrap, Escape/scrim, focus restore) on the live build.
40. Manifest/SW live: manifest + icons 200; SW registers; versioned caches
    present; `/sw.js` no-cache; `/assets/*` immutable.
41. Mobile emulation (Pixel + iPhone): layout, keypad, attach, safe-area,
    theme toggle; note the static light `theme-color` residual if visible.
42. IME: real CJK composition via CDP `Input.imeSetComposition` if feasible,
    else rely on the unit-tested predicate (say so in the log).
43. Error paths: link without fragment ("This link has no key"); garbage PIN
    shape; 404 page; error screen.

### H. Data integrity

44. Alternating sends across a reconnect window → both sides agree on the
    final order (seq is monotonic; gaps are fine, misordering is not).
45. Wrong-key link (fragment of another room) → "message could not be
    verified" state, no crash.
46. Multi-chunk byte equality between two contexts, including a download
    performed after the downloading peer reconnected.
47. F5 mid-room: new participant id, prior messages gone (by design) —
    verify the UI is honest about it; flag if it reads as silent data loss.

### I. Deployment/ops behavior

48. Redeploy the relay WHILE a room is active with connected sockets →
    clients reconnect → room still exists and works (post-fix behavior);
    watch for the create-during-deploy-churn anomaly documented in
    SUMMARY.md and characterize it if it reappears.
49. `wrangler tail` runs clean for the whole session; note every exception
    that appears with its request.
50. Live `_headers`: all 7 rules valid, no wrangler warnings on serve.

## Protocol per found bug

1. Reproduce minimally (script + `wrangler tail` evidence).
2. Root-cause in code (name the exact line/mechanism).
3. Fix at the right layer without weakening the security model (never
   loosen the generic-404 oracles, membership checks, or the CSP just to
   "make it work").
4. Regression test: workerd harness for server logic (extend the eviction-
   sim pattern for live-only state), node unit for client logic, Playwright
   spec for deterministic UI behavior.
5. Redeploy (respect both deploy quirks above), re-run the failing scenario
   plus the surrounding matrix rows.
6. Log: symptom, cause, fix, test, evidence.

## Deliverables and definition of done

- `prompts/implementation/live-test-log.md`: one row per matrix scenario
  (PASS / FIXED / RESIDUAL with reason), full evidence for every fix, final
  test counts, deployed version IDs before and after.
- `prompts/implementation/SUMMARY.md` updated if behavior or residuals
  change.
- All fixes committed with focused messages. **Do not push.**
- Done when: every matrix row has a logged verdict with evidence; every
  fixed bug has a regression test (or a written reason why none is
  possible); `pnpm test`, both `tsc` runs, and (if the frontend was
  touched) `pnpm test:a11y` are green; no stray processes or test artifacts
  remain; and the deployment is left in a strictly better state than you
  found it.
