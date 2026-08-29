# Session 7 Log — Adversarial Live-Deployment Testing

Live adversarial session against the deployed app. Every matrix row has a
verdict; every fix has a regression test and a live re-verification.

## Deployment facts at session start

- Relay `husk`: version `57ff2f58-7707-445c-a05e-1b170bebbfb4` (2026-08-27)
- Frontend `ns81000-husk`: deployed 2026-08-27 build
- Baseline re-verified before testing: `pnpm test` 107/107 (14 files, incl. 22
  workerd integration tests); both `tsc --noEmit` runs clean.
- Server observation: `wrangler tail husk --format pretty` captured for the
  duration (the tail websocket died twice with client-side `ECONNRESET` and was
  restarted; see Environment notes). Final relay version after all fixes:
  `0a0bd9f9-98cd-42dd-932f-902882d23ba0`; final frontend version:
  `12493349-d658-4ea4-8cf5-4a2e05793bab`.

## Fixes shipped this session (all committed, all with regression tests)

### Fix 1 — Same-second join tokens collided (relay, HIGH) — commit `97d1f76`

- **Symptom (live):** raw two-peer probe: join ×2 → 200 with tokens, socket A
  opened, socket B hung until timeout. `wrangler tail` showed **four** socket
  GETs carrying the _same_ `jt=` value (2× Ok, 2× Canceled): both joins
  happened within the same second, so `tokenExpiresAt` (seconds granularity)
  was identical and the HMAC over `join|pin|ip|exp` minted **byte-identical
  tokens** for two legitimate peers. The DO's one-time burn (Phase 2) consumed
  the token on A's upgrade; B's upgrade got the generic 404.
- **Fix:** token format `exp.nonce.sig`; the nonce (`crypto.randomUUID()`,
  hex-stripped) is folded into the HMAC input
  (`join:${pin}|${ip}|${exp}|${nonce}`) and the DO verifies the 3-part token.
  One-time burn semantics, IP binding, TTL, and the generic-404 oracle are
  unchanged (forged 2-part and tokenless probes still 404 identically; replay
  still refused).
- **Regression test:** `worker/tests/integration.test.ts` — "regression: two
  joins from one IP within the same second mint distinct tokens and both
  sockets open" (parallel joins, distinct-token assertion, both upgrades 101).
  The existing capacity test was updated to mint 3-part tokens directly.
- **Live re-verify:** distinct tokens, both sockets welcome ×2, full
  relay/ack/presence/dedup/malformed suite green. (First post-deploy retry
  still hit the old version — deploy propagation; a minute later the new code
  served. Not a code issue.)

### Fix 2 — 0-byte / over-cap attachments sent a doomed grant request (frontend, LOW) — commit `852e2b0`

- **Symptom:** `onSendFile` called `requestFileUpload` _before_ any size
  check; the EmptyFileError/FileTooLargeError checks ran only inside
  `encryptAndUpload`, i.e. after the grant POST — which the relay always
  answers 400 for size ≤ 0 / > 25 MB. Live monitor showed the POST going out
  for a 0-byte pick.
- **Fix:** extracted `assertFileSendable(size)` in `src/lib/husk/files.ts`
  (throws EmptyFileError / FileTooLargeError), called by `onSendFile` _before_
  the grant request and re-checked inside `encryptAndUpload`.
- **Regression test:** new `src/lib/husk/files.test.ts` — 4 boundary tests
  (0 rejected, cap+1 rejected, 1 byte accepted, exactly cap accepted).
- **Live re-verify (frontend `78d5b6af`):** 0-byte file → failed-upload
  banner, grant-request count unchanged (0 → 0); >25 MB → rejected
  client-side, no request.

### Fix 3 — Half-open sockets: no liveness detection (frontend, HIGH) — commit `a093d15`

- **Symptom (live, ~50 kB/s throttled 3 MB upload):** all 3 chunk PUTs
  returned 200, no failure banner, no ≥400 responses — but the file message
  never reached the peer, and A's entry sat at "Not sent" while A showed
  **Connected**. Status polling caught `Reconnecting → Connected` mid-upload:
  in the failing runs a socket whose TCP peer vanished (ECONNRESET-class,
  which this machine's link to the Cloudflare edge exhibits under load — the
  wrangler tail websocket died twice the same way) stays `readyState === OPEN`
  forever. `send()` writes into the void; no `close`/`error` ever fires; the
  ack timeout flips the message to `failed`; recovery never happens.
- **Root cause:** the protocol defines `ping`/`pong` (the relay answers ping,
  `worker/src/room.ts`), but **no client code ever sent a ping**.
- **Fix:** client-side liveness in `RoomConnection`: after `open`, a ping is
  sent after `PING_INTERVAL_MS = 20 s` of silence; if no server frame arrives
  within `PONG_TIMEOUT_MS = 10 s`, the client itself closes the socket, which
  feeds the standard reconnect flow (backoff, budget, termination). Any
  inbound frame — not just pong — resets the timer; timers cleared on
  close/end/dispose.
- **Regression tests:** `src/lib/husk/connection.test.ts` +3 (answered ping
  keeps the socket alive; unanswered ping closes the zombie and reconnects;
  any server frame counts as liveness). Suite total 115/115.
- **Live re-verify (frontend `12493349`):** throttled 3 MB upload → grant 200,
  3 PUTs 200 (~64 s), file card at the peer 0.5 s after the last PUT,
  throttled download byte-identical, text send under throttle OK.

## Matrix results

Legend: PASS = verified live as documented. FIXED = bug found live, fixed,
regression-tested, re-verified live. COVERED = verified by the workerd/unit
suites at the same seam (live variant not reachable without burning the shared
per-IP rate-limit budget; noted per row).

### A. Core flows, two identities

| #   | Scenario                                           | Verdict | Evidence                                                                                                                                                                                                                                                                                                                                                                                    |
| --- | -------------------------------------------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | A creates, B joins via link, both see 2            | PASS    | `drive-a.mjs`: participant count 2/2                                                                                                                                                                                                                                                                                                                                                        |
| 2   | Messages both directions, ordering, sending→sent   | PASS    | `drive-a.mjs` + `probe-a-core.mjs`: bidirectional delivery, ack seq == relay seq, monotonic seq                                                                                                                                                                                                                                                                                             |
| 3   | Files both directions (10 KB, 3 MB), byte equality | PASS    | `drive-a.mjs`: download-event bytes vs source — `Buffer.compare === 0` both directions                                                                                                                                                                                                                                                                                                      |
| 4   | 3rd–10th join; 11th refused                        | PASS    | `probe-capacity.mjs`: 9 paced joins → 9 participants; two simultaneous edge joins both mint tokens, 10th socket opens (10 participants), **11th upgrade refused** (DO atomic 403). Trailing "relay at full capacity" micro-check skipped after a harness typo (`tenth.send`) — the relay path is capacity-independent and verified at 2 peers; not re-run (would repeat the 13-minute fill) |
| 5   | Key only in fragment; never reaches server         | PASS    | POST-body capture on all relay requests: only `{pin}` / `{size, member}` / sealed `{iv, ct}`; the fragment lives in `location.hash` and is never sent                                                                                                                                                                                                                                       |

### B. Lifecycle, eviction, reconnect

| #   | Scenario                                                | Verdict                     | Evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| --- | ------------------------------------------------------- | --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 6   | Isolate eviction mid-room                               | PASS                        | `probe-eviction.mjs`: close sockets, 80 s idle, rejoin → 200, welcome seq continues, send works (seq 1→2)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| 7   | Hibernation wake (sockets open, 75 s idle)              | PASS                        | same probe: post-wake send relays+acks, exactly one relay per localId, payload intact                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| 8   | Background >8 s → Reconnecting → recover                | COVERED                     | background-timer socket death is not reproducible in headless Chromium; the same mechanism (silently dead socket) is produced and fixed via liveness pings (Fix 3), and the reconnect lifecycle is pinned by `connection.test.ts` + live B10                                                                                                                                                                                                                                                                                                                                                                                 |
| 9   | Kill A's context (no leave) → grace → note              | PASS                        | `drive-b.mjs`: "Connected · peer may be reconnecting" within 8 s, then "A participant left the room." system note; B's status stays Connected (its own socket is fine — honest)                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| 10  | Reconnect termination → terminal + Reconnect + recovery | PASS                        | `drive-b10.mjs`: real socket drop + route-aborted join mints → attempt budget exhausts → "Disconnected" screen + Reconnect button in 163–165 s → unroute + synthetic `online` event → auto-recovers → post-recovery delivery exactly once                                                                                                                                                                                                                                                                                                                                                                                    |
| 11  | Both peers offline simultaneously → recover             | COVERED                     | each side's recovery is the same tested path (B10 + drive-reconnect); a synchronized double-drop adds no new server surface; not run separately to conserve the shared per-IP join budget                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| 12  | Host leaves via modal → guests…                         | PASS (deviation documented) | `drive-b.mjs` room 2: modal leave → guest sees grace → "A participant left the room." → waiting-for-peer. Guests do **not** get a terminal `closed` frame: a graceful leave is indistinguishable server-side from a crash (no leave frame exists; `RoomCloseReason "host_closed"` is protocol surface the relay never emits), and grace-then-note is the documented intent (phase-6 row 6). Emitting `closed(host_closed)` on any graceful leave would terminate the room UI for every remaining participant — wrong for a 10-person room. Scenario 12's "guests get closed" expectation is superseded by the shipped design |

### C. Races and concurrency

| #   | Scenario                                  | Verdict | Evidence                                                                                                                                                                                                                                                                                                      |
| --- | ----------------------------------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 13  | Simultaneous joins at the capacity edge   | PASS    | folded into row 4: two parallel joins+upgrades at 9-filled → exactly one admitted                                                                                                                                                                                                                             |
| 14  | Rapid double-send (spam Enter)            | PASS    | `drive-c.mjs`: 3 rapid sends → exactly one bubble per text per side, zero "Not sent"                                                                                                                                                                                                                          |
| 15  | Duplicate tab = distinct participant      | PASS    | `drive-c.mjs`: second tab → count 3, its relay reaches both other views exactly once (documented intended behavior)                                                                                                                                                                                           |
| 16  | Send while reconnecting (outbox)          | COVERED | the composer is deliberately `disabled` while status ≠ open, so the UI cannot send mid-reconnect; the outbox path (enqueue → flush on open, expiry prune, 50-cap) is pinned by `connection.test.ts`; live outbox flushing was additionally exercised by drive-reconnect's queued send under offline emulation |
| 17  | Missed messages not backfilled; UI honest | PASS    | `probe-reconnect.mjs`: real socket close, peer sends, rejoin → welcome seq equals last acked seq, zero relays of the missed message after 3 s; UI shows no fake delivery ("Not sent" + Retry)                                                                                                                 |
| 18  | Cancel upload mid-flight frees budget     | PASS    | `probe-d-files.mjs`: fill the 100 MB budget → 507 → cancel frame → immediate new grant succeeds (refund proven)                                                                                                                                                                                               |

### D. File edge cases

| #   | Scenario                                        | Verdict | Evidence                                                                                                                                                                                                                                                                                                                                  |
| --- | ----------------------------------------------- | ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 19  | 0-byte file → EmptyFileError, no request        | FIXED   | was: doomed 400 grant POST (Fix 2); live re-verify: no request, failed banner                                                                                                                                                                                                                                                             |
| 20  | 1 B; 1 MiB; 1 MiB+1; 25 MB; 25 MB−1; budget 507 | PASS    | 1 MiB±tag cap pinned by workerd tests (cap-exact 200 / +1 400, unchanged); 0 B and >25 MB rejected client-side with no request (Fix 2, live); exactly-25 MB grant → 200 with **25** chunk URLs (the prompt's "~24" is off by one: ceil(25 MiB / 1 MiB) = 25 — server and client agree); 507 at the budget edge live (`probe-d-files.mjs`) |
| 21  | Concurrent uploads from two peers               | PASS    | interleaved out-of-order chunk PUTs (3-chunk file uploaded as 1,0,2) → streamed GET byte-identical; grant serialization pinned by workerd tests                                                                                                                                                                                           |
| 22  | Download after sender socket closed             | PASS    | `probe-d-files.mjs`: sender closes → download 200, byte-identical                                                                                                                                                                                                                                                                         |
| 23  | Cancel mid-upload refunds budget                | PASS    | see row 18 (refund proven by post-cancel grant success)                                                                                                                                                                                                                                                                                   |
| 24  | GET replay within room lifetime                 | PASS    | two sequential GETs both 200, byte-identical (documented, deliberate)                                                                                                                                                                                                                                                                     |
| 25  | Tampered sig/exp; wrong-pin GET                 | PASS    | tampered sig → 403; expired exp → 403 (PUT and GET); forged sig → 403; unsigned → 403; wrong-pin GET with a valid other-pin sig → 403                                                                                                                                                                                                     |

### E. Security and abuse (live)

| #   | Scenario                              | Verdict             | Evidence                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| --- | ------------------------------------- | ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 26  | 11 rapid joins → 429 + escalation     | PASS (bounded live) | 429 with `{"error":"rate_limited","retryAfter":51}` observed live, then a second exhaustion with `retryAfter: 34` inside a 120 s penalty — strikes 1 (60 s) and 2 (120 s) both observed, matching `evaluate()`. The full ladder to 1 h is pinned by `rate-limit.test.ts` (5 unit tests); deliberately not burned further — the gate keys on `ip:<ip>` too, so each live strike blocks **all** scenarios from this machine for the penalty duration |
| 27  | Join-token replay → generic 404       | PASS                | replayed token never opens a socket (raw WS upgrade attempt); byte-identical 404 equality pinned by the workerd suite                                                                                                                                                                                                                                                                                                                              |
| 28  | Forged/expired token; tokenless probe | PASS                | forged `9999999999.AAAA.BBBB` and tokenless upgrades never open; workerd suite asserts identical generic 404 bodies                                                                                                                                                                                                                                                                                                                                |
| 29  | Unsigned/forged/expired file GET      | PASS                | all 403 live (`probe-e-security.mjs`)                                                                                                                                                                                                                                                                                                                                                                                                              |
| 30  | CORS matrix on every route            | PASS                | allowed origin → ACAO; disallowed → **no** ACAO header at all; no-Origin → served 200 without ACAO (safe: browsers are the threat model — non-browser callers need no CORS permission); OPTIONS → 204 + ACAO; chunk PUT carries ACAO for allowed origin                                                                                                                                                                                            |
| 31  | XSS live                              | PASS                | `drive-a.mjs` + `drive-h.mjs`: `javascript:`/`data:` text never renders as hrefs (tokenize allows only http/https); `<img onerror>` text payload never executes (`window.__xss === undefined`); XSS-named file rendered inert, zero pageerrors                                                                                                                                                                                                     |
| 32  | CSP: zero violations; hashes; iframe  | PASS                | per-response `script-src 'self' 'sha256-…'` verified on live HTML; `frame-ancestors 'none'` + `X-Frame-Options: DENY`; iframe of the frontend renders nothing; zero console violations on every exercised screen (landing, PIN-entry, room, modal, both themes)                                                                                                                                                                                    |
| 33  | Malformed WS frames                   | PASS                | `probe-a-core.mjs`: garbage string, wrong shapes, unknown tag, 200 KB string → 4 × `{t:"error",code:"bad_request"}` returned, connection survives (answers ping), peer unaffected; `wrangler tail` shows no exceptions                                                                                                                                                                                                                             |

### F. Network adversity

| #   | Scenario                                          | Verdict | Evidence                                                                                                                                                                                                                                                                                          |
| --- | ------------------------------------------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 34  | CDP offline mid-typing → banner → reconnect       | PASS    | `drive-reconnect.mjs`: distinct "You are offline — messages can't send while offline" (warn) vs "Reconnecting"; status recovers on unblock. Caveat documented: CDP emulation does **not** kill an established WebSocket, so the true dead-socket path is Fix 3's liveness + `probe-reconnect.mjs` |
| 35  | Offline PWA: landing shell cached, /r never stale | PASS    | `drive-f.mjs`: offline `/` serves the cached shell (h1 "Husk"); offline `/r/<pin>` navigation fails (network-only, never a stale room shell); SW registered, caches `husk-shell-v1` / `husk-bundles-v1`                                                                                           |
| 36  | 3G + loss → bounded reconnects, no dupes          | PASS    | B10 (163 s to terminal, bounded) + drive-reconnect (order agreement, no duplicate bubbles)                                                                                                                                                                                                        |
| 37  | ~50 kB/s mid-3 MB upload                          | FIXED   | first live run exposed the zombie-socket gap (Fix 3); after the fix: upload completes ~64 s, no timeout races, byte-identical download, text sends under throttle                                                                                                                                 |

### G. Frontend, PWA, a11y on the live site

| #   | Scenario                          | Verdict | Evidence                                                                                                                                                                                                                      |
| --- | --------------------------------- | ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 38  | Axe sweep live, both themes       | PASS    | `probe-g-live.mjs` + `drive-g.mjs`: landing, PIN-entry, no-key room, **active room with content, open leave-modal** — zero wcag2a/2aa/21a/21aa violations, light and dark                                                     |
| 39  | Keyboard-only walkthrough         | PASS    | `drive-g.mjs`: keyboard compose+Enter delivers; attach opens the chooser via keyboard and uploads; leave modal opens by keyboard, traps Tab (focus cycles Cancel↔Leave only), Escape closes, focus restored to a page element |
| 40  | Manifest/SW live                  | PASS    | manifest 200; `/sw.js` 200 `no-cache`; icons 200; font `immutable`; SW registers with both versioned caches                                                                                                                   |
| 41  | Mobile emulation (Pixel + iPhone) | PASS    | no horizontal overflow on landing; keypad taps complete a PIN; join feedback renders; room error path renders. Static light `theme-color` residual noted (unchanged, carried)                                                 |
| 42  | IME CJK composition               | COVERED | CDP `Input.imeSetComposition` is not exposed by Playwright's API; the `shouldSubmitOnEnter` predicate is unit-tested (5 tests incl. `isComposing` and keyCode-229 paths) — the prompt's sanctioned fallback                   |
| 43  | Error paths                       | PASS    | no-fragment link → "This link has no key"; garbage fragment → "Room unavailable" (importRoomKey fails → closed_not_found copy); garbage PIN shape rejected client-side; unknown route → 404                                   |

### H. Data integrity

| #   | Scenario                                                | Verdict | Evidence                                                                                                                                        |
| --- | ------------------------------------------------------- | ------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| 44  | Alternating sends across a reconnect window             | PASS    | `drive-reconnect.mjs`: 5-message sequence across offline/online — both sides' final order identical, no dupes                                   |
| 45  | Wrong-key link                                          | PASS    | `drive-h.mjs`: third peer with a random fragment joins fine, sees "A message could not be verified and was discarded.", zero pageerrors         |
| 46  | Multi-chunk byte equality incl. post-reconnect download | PASS    | 3-chunk out-of-order upload → byte-identical download after the sender's socket closed (`probe-d-files.mjs`) and under throttle (`drive-f.mjs`) |
| 47  | F5 mid-room                                             | PASS    | `drive-h.mjs`: reload → no prior messages rendered (nothing pretend-loaded), honest empty state, fresh participant rejoins the live room        |

### I. Deployment/ops behavior

| #   | Scenario                   | Verdict           | Evidence                                                                                                                                                                                                                                                                                                       |
| --- | -------------------------- | ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 48  | Redeploy while room active | PASS              | `drive-i48.mjs`: relay redeployed (`0a0bd9f9…`) with both sockets connected → both clients reconnect (≤30 s), pre-deploy message exactly once (no replay), post-deploy message flows; a room created seconds after deploy worked normally — the create-during-churn anomaly did **not** reproduce this session |
| 49  | Tail clean                 | PASS (with notes) | no exceptions in any tail capture across all scenarios; the only server-side refusals were the intended 429/403/404 oracles. Operational note: two tail websocket sessions died with client-side `ECONNRESET` (local network), restarted                                                                       |
| 50  | Live `_headers`            | PASS              | `/sw.js` → `no-cache`; icons → `public, max-age=604800`; font → `public, max-age=31536000, immutable`; manifest → `no-cache`; static assets carry `X-Frame-Options: DENY` + `nosniff`; no wrangler warnings on serve                                                                                           |

## Environment notes / honest limitations

- **Shared IP rate-limit budget:** the gate keys on `ip:<ip>` AND `pin:<pin>`,
  so every scenario from this machine draws from one 10-joins/5-min budget,
  and exhaustions escalate (60 s → 120 s → …). Scenarios were paced around
  this (the capacity fill took ~13 minutes of deliberate spacing); rows 8 and
  11 are logged COVERED rather than burned live for this reason.
- **Local network flakiness:** ECONNRESET on long-lived TLS to the edge killed
  two `wrangler tail` sessions and produced the intermittent "both connected"
  failures early in the session (immediate retry passed without any app
  change). This is also exactly the condition that exposed Fix 3 — the app now
  detects and recovers from it automatically.
- **CDP offline emulation does not kill established WebSockets** (Chromium
  behavior). Dead-socket tests therefore use real socket closes (an
  init-script WebSocket tracker) plus route-aborted join mints.

## Final test counts

- `pnpm test` — **15 files, 115/115** (was 107/107: +1 token-collision
  regression [workerd], +4 `assertFileSendable` boundaries, +3 liveness tests)
- `pnpm exec tsc --noEmit -p tsconfig.json` — pass
- `pnpm exec tsc --noEmit -p worker/tsconfig.json` — pass
- `pnpm test:a11y` — **12/12** (production build under workerd; re-run because
  the frontend was touched)
- Deployed versions at end: relay `0a0bd9f9-98cd-42dd-932f-902882d23ba0`,
  frontend `12493349-d658-4ea4-8cf5-4a2e05793bab`
- Live-test harness kept in `live-tests/*.mjs` (deterministic, no secrets —
  only public worker URLs; all logs/screenshots deleted)
