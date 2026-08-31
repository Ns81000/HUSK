# HUSK Paranoid Audit — Phase 1 Findings
> Generated: 2026-08-31 (in progress)
> Auditor: Automated Paranoid Audit Agent

## Summary
**Audit executed 2026-08-31 against HUSK (commit d64dd49). All 11 sections filled; no source code modified (test-only changes: `probe-lib.mjs` fetch retry + socket timeout, 5 new `stress-*.mjs` scripts).**

### Headline results
- **Static analysis**: root + worker `tsc --noEmit` both CLEAN. Both lint gates BROKEN (4,670 prettier errors on unignored vendored dirs + CRLF; `lint:anti-slop` missing `oxlint-tsgolint`).
- **Unit tests**: 133/133 pass (110 root + 23 worker). Coverage gaps: api.ts untested; files.ts edge paths; store retry/double-connect paths.
- **Code review**: every Critical File Map file read in full. 3 HIGH, 10 MEDIUM, 9 LOW findings; 6 races analyzed (3 verified safe).
- **Live tests**: probe-a-core/capacity/d-files/eviction PASS; probe-e-security partial (network); probe-g-* partially stale/environmental; drive tests not runnable (rate budget + degraded network — documented, not skipped silently).
- **Custom stress (5 new scripts)**: ALL 5 scenarios ultimately PASS — 50-message ordering, file-ticket security matrix, 8-socket fanout, lifecycle boundaries, security probes. Two findings LIVE-CONFIRMED: `/room/create` unbounded (HIGH #2) and shared join-budget lockout (MEDIUM #6).
- **Security posture**: strong. Room key never crosses the client boundary (verified across all call sites); HMAC constant-time; CORS allow-list correct; XSS surfaces inert; CSP/XFO verified live. Main gaps are availability (create rate limit) and member-abuse (cancel ownership).
- **Performance**: main bundle 307 KB / 95.7 KB gzip (framework-dominated, acceptable); dead UI code tree-shaken; no unexpected hot paths.

### Environment caveats (documented honestly)
- Network to `*.workers.dev` was severely degraded during the audit (35 s/request, TLS connect drops). All flaky failures were re-run ≥2× and distinguished (environmental vs product) where possible.
- The per-IP join budget (10/5 min, escalating penalties) capped how many live scenarios could run; drive tests and three sub-scenarios are explicitly deferred to Phase 2 with instructions in `prompts/PARANOID_AUDIT_PHASE_2_KICKOFF.md`.

### Deliverables
- `prompts/findings/FINDINGS.md` (this file) — 11 sections, prioritized 22-item fix list (§11).
- `prompts/PARANOID_AUDIT_PHASE_2_KICKOFF.md` — self-contained Phase 2 prompt (fix → verify → deploy → re-verify).
- `live-tests/stress-{conn,msg,files,security,lifecycle}.mjs` — 5 new reusable stress scripts.
- Logs retained: `prompts/findings/logs/` (tsc, lint, test, live-probe, live-stress, build).



## 1. Static Analysis
> Ran: `pnpm exec tsc --noEmit` (root), `pnpm exec tsc --noEmit` (worker/), `pnpm run lint` (eslint), `pnpm run lint:anti-slop` (oxlint).

### 1.1 Type Errors
- **VERIFIED CLEAN**: Root `tsc --noEmit` → exit 0, zero errors. (`tsc-root.log`)
- **VERIFIED CLEAN**: Worker `tsc --noEmit` → exit 0, zero errors. (`tsc-worker.log`)

### 1.2 Lint Violations
- **eslint**: exit 1 — **4,678 problems (4,670 errors, 8 warnings)**. `lint.log` (full output retained at repo root).
- Breakdown by area:
  - `.agents\skills\install-anti-slop\**` and `tools\oxlint\anti-slop\**` (vendored skill/tool assets): thousands of `prettier/prettier` errors — these directories are **NOT ignored** by the eslint config, so `pnpm run lint` fails on files unrelated to the app.
  - `src/**` and `worker/**`: **every single error is `prettier/prettier` CRLF (`Delete ␍`) noise** on files saved with Windows line endings (e.g. `MoltenMetal.tsx`, `chat.tsx`, `primitives.tsx`, `room-info.tsx`, 6 `ui/*` shadcn files, `lib/husk/{protocol,room-machine}.ts` + tests, `routes/r.$roomId.tsx`, `worker/src/tickets.test.ts`).
  - **Zero non-prettier errors/warnings in src/ or worker/** — verified by filtering `src-lint-detail.log` for error lines not attributed to `prettier/prettier` → empty result.
- **FINDING [MEDIUM] `pnpm run lint` is red-broken**: the lint gate fails on 4,666 auto-fixable CRLF issues and vendored assets, meaning "lint passes" can never be a meaningful signal. Fix: add `.agents/` and `tools/` to eslint ignores + run `eslint --fix` / normalize line endings (`.gitattributes` with `* text=auto eol=lf`).
- **FINDING [MEDIUM] `pnpm run lint:anti-slop` is hard-broken**: `oxlint --type-aware` fails with `Failed to find tsgolint executable. You may need to add the oxlint-tsgolint package to your project?` — the `oxlint-tsgolint` dev dependency is missing. The anti-slop gate never runs. (`anti-slop.log`)

### 1.3 Dead Code
- Deferred to §10 (full inventory after code review).


## 2. Unit Test Results
> `pnpm test` (root, vitest run) → **EXIT 0: 14 files, 110/110 tests passed, 5.31s** (`test-root.log`)
> `pnpm test` (worker/) → **EXIT 0: 1 file, 23/23 tests passed, 4.99s** (`test-worker.log`)

### 2.1 Frontend Tests (vitest)
| File | Tests | Result |
|---|---|---|
| src/lib/husk/contrast.test.ts | 5 | ✓ pass |
| src/lib/husk/linkify.test.ts | 4 | ✓ pass |
| src/lib/husk/crypto.test.ts | 7 | ✓ pass |
| src/lib/husk/protocol.test.ts | 6 | ✓ pass |
| src/lib/husk/room-machine.test.ts | 9 | ✓ pass |
| src/lib/husk/files.test.ts | 4 | ✓ pass |
| src/lib/husk/connection.test.ts | 12 | ✓ pass (slowest case 350ms) |
| src/lib/husk/backoff.test.ts | 3 | ✓ pass |
| src/components/husk/chat.render.test.tsx | 4 | ✓ pass |
| src/lib/husk/store.test.ts | 18 | ✓ pass |
| src/components/husk/chat.enter.test.ts | 5 | ✓ pass |

### 2.2 Worker Tests (vitest)
| File | Tests | Result |
|---|---|---|
| worker/tests/integration.test.ts (via workers pool) | 23 | ✓ pass |
| worker/src/tickets.test.ts | 5 | ✓ pass (run in root suite) |
| worker/src/rate-limit.test.ts | 5 | ✓ pass (run in root suite) |

Note: root vitest suite already includes the worker tests; worker/ `pnpm test` re-runs only `integration.test.ts`.

### 2.3 Failing Tests
- **NONE.** All 133 test executions passed. Re-run not required (no flakes on first pass).

### 2.4 Missing Coverage
- `src/lib/husk/api.ts` — **no unit tests at all** (create/join HTTP error paths untested).
- `src/lib/husk/files.ts` — only 4 tests; no test for: chunk PUT failure/retry, room expiry mid-upload, concurrent upload abort, 0-byte file, >MAX_FILE_BYTES rejection.
- `src/lib/husk/theme.ts` — untested (trivial).
- `worker/src/index.ts` — CORS origin handling, ticket minting endpoint, and roomId validation are not directly unit-tested (only indirectly via integration tests).
- `worker/src/gate.ts` — no dedicated unit test (only exercised through rate-limit logic tests + integration).
- `worker/src/room.ts` — alarm/purge behavior, WebSocket close codes, and file-limit enforcement edge cases not covered by the 23 integration tests (verified against integration test list during §3 review).
- `store.ts` — 18 tests but no test for double-connect guard, retry() while joined, or late-ACK race (to be confirmed in §3/§4 review).
- `connection.ts` — no test for outbox flush on reconnect with >1 buffered frame order guarantee, or malformed JSON server frame handling.


## 3. Code Review Findings
> Every file in the Critical File Map was read IN FULL. Line numbers verified against current code.

### 3.1 Worker (worker/src/)
- **[HIGH] `/room/create` has NO rate limiting** (worker/src/index.ts:86-104). `/room/join` gates via `checkJoinAllowed`, but `/room/create` mints a new Durable Object + alarm with zero budget. An attacker can spam-create rooms (each a DO with SQLite) → resource-exhaustion DoS on a free-tier Worker. Verified by live test (§8.3).
- **[MEDIUM] Shared per-room join budget DoSes legitimate joiners** (worker/src/index.ts:111, worker/src/config.ts:18-19). `checkJoinAllowed(env, [ip:…, room:<id>])` counts the room key against JOIN_MAX_ATTEMPTS=10 per 5 min. Everyone joining a popular room shares one budget → the 11th joiner in 5 min gets 429 even though legitimate; one user can burn the budget for all other joiners of that room.
- **[MEDIUM] Join-token burn is not atomic (TOCTOU)** (worker/src/room.ts:231-235). `storage.get(burnKey)` then `storage.put(burnKey)` has an await between check and write, so two concurrent upgrades presenting the SAME token can both pass and both join. Single-use is best-effort, not strict.
- **[MEDIUM] `cancel` frame has no ownership check** (worker/src/room.ts:504-507 + 459-481). Any live member can cancel ANY fileId — including a file another member is uploading or already uploaded. Rows deleted silently. Fix: record owner id in FileMeta, reject non-owner cancels.
- **[MEDIUM] Cancel/upload race leaks orphan chunk rows** (room.ts:399-413 vs 504-507). PUT reads meta → awaits body → writes row; a concurrent cancel in that window deletes meta+rows, then the PUT writes an orphan row not counted in `bytesUsed` and never cleaned until room deleteAll(). Bounded ~1 MiB per race.
- **[LOW] Join token travels in URL query param** (index.ts:157, connection.ts:56-58) — log/history/Referer leak surface; mitigated by IP binding + 60 s TTL.
- **[LOW] `recentSends` eviction can re-assign seq on late resend** (room.ts:536-544): after 500 newer messages a resent old localId gets a NEW seq → duplicate bubble. Unlikely but real.
- **[LOW] Dead protocol surface**: server only sends `{t:"error",code:"bad_request"}` (room.ts:490) though protocol declares 4 codes (protocol.ts:51); `host_closed` close reason never sent (room.ts:588 sends only expired|idle); client maps `idle` → LEAVE → "closed_by_host" (store.ts:299), mislabeling idle-closed rooms.
- **[INFO] CORS VERIFIED**: allow-list only, no arbitrary-origin reflection, no ACAO for disallowed/absent Origin (index.ts:21-35).
- **[INFO] Tickets VERIFIED**: HMAC compare is constant-time (tickets.ts:61-68), expiry enforced (L57), chunk tickets single-use via row existence (room.ts:404-407), ticket binds roomId/fileId/chunkIndex — no cross-room forgery. Download ticket reusable until room expiry (documented design).
- **[INFO] Eviction-safety VERIFIED**: seq/createdAt/emptySince persisted per message and restored in constructor under `blockConcurrencyWhile` (room.ts:105-140, 519-523).
- **[INFO] Malformed frames VERIFIED**: bad JSON → `{t:"error",code:"bad_request"}`; binary frames → `String(ArrayBuffer)` → parse fail → same path (room.ts:59-89, 487-491). No crash.

### 3.2 Client Logic (src/lib/husk/)
- **[HIGH] Duplicate-socket race in `RoomConnection.resetBackoff()`** (connection.ts:120-134, open at 136-137). `resetBackoff` closes a non-OPEN socket and calls `connect()` immediately, but the closed socket's `close` event later fires → `scheduleReconnect()` starts a SECOND flow. Worse: if `connect()`'s `fetchJoinToken()` is still in flight when `resetBackoff` runs (e.g. `online` event right after joining), BOTH flows call `open()` and the second overwrites `this.socket` WITHOUT closing the first → two live sockets each delivering onMessage → duplicated relays/system events, doubled traffic. `open()` never closes a pre-existing socket.
- **[MEDIUM] `retry()` bypasses the state machine and wipes the transcript** (store.ts:415-422 → 369-377). `connect()` unconditionally sets `state:"joining"`, clears `entries:[]` and `seenRelays`. Nothing guards `retry()` against non-terminal states. One call from `active` destroys the in-memory chat history and respawns the connection.
- **[MEDIUM] Entries stuck in `sending` forever after terminal disconnect** (store.ts:170-181). `handleEnded` clears ack timers but never marks `delivery:"sending"` entries as `failed`. After attempts_exhausted / join_refused, those bubbles spin forever. (ACK timeout works for live sockets, not terminal-ended ones.)
- **[MEDIUM] Download buffers the FULL decrypted file in memory** (files.ts:215-244). `plaintexts: BlobPart[]` accumulates every decrypted chunk before `new Blob(...)` — contradicts the header comment's "never buffering more than the chunk being completed". 25 MB file → ~25 MB RAM spike.
- **[MEDIUM] No fetch timeouts anywhere in client logic** (api.ts:51,72; files.ts:77,130,205). A hung connection stalls create/join/upload/download indefinitely; a stalled chunk PUT leaves reserved storage occupied with no cancel path.
- **[LOW] `seenRelays` grows unbounded** (store.ts:82,247) — one entry per received message for page lifetime.
- **[INFO] Outbox VERIFIED** (connection.ts:283-300): 50-frame cap, oldest-drop, expired-frame pruning against room expiresAt, flush on open. `send()` during CLOSING enqueues (frame survives reconnect) — matches spec.
- **[INFO] Ping/pong liveness VERIFIED** (connection.ts:199-247): ping after 20 s idle, 10 s pong window, ANY inbound frame = liveness, `stopLiveness` in close/end/dispose — no post-teardown timer fires.
- **[INFO] Late-ACK race VERIFIED safe**: ack after markFailed flips back to `sent` (authoritative); receiver dedup registers localId BEFORE the async decrypt (store.ts:245-247) so mid-decrypt duplicates can't double-append.
- **[INFO] Grace timer VERIFIED** (store.ts:140-168): deadline re-derived from `lastLeaveAt`, reschedules on overlap; no stale-timer race.
- **[INFO] linkify XSS VERIFIED safe** (linkify.ts): only `https?://` matches, `URL` re-parse enforces scheme, plain React tokens — no HTML string, no javascript: injection.
- **[INFO] crypto VERIFIED**: AES-256-GCM fresh 12-byte IV per seal (crypto.ts:65-77), key length check on import (L55), decrypt failure → typed DecryptionFailedError → "unverified" entry state (store.ts:278-294). Key never passed to any fetch/socket call — verified by reading api.ts/connection.ts/files.ts signatures.

### 3.3 Frontend Components (src/components/husk/ + src/routes/)
- **[MEDIUM] `closed_disconnected` shows NO Reconnect button** (src/routes/r.$roomId.tsx:180-190, 65-68, 416-453). `ClosedScreen` supports `onRetry`, and the copy for `closed_disconnected` says "The room may still exist — try reconnecting." — but the terminal-state render at L183-188 never passes `onRetry`. Users see a dead end; the only recovery is a full page reload. The store's `retry()` (L94 import) is likewise **unused in the route** (dead import).
- **[LOW] `hadPeerRef` written during render** (r.$roomId.tsx:193-195). Mutating a ref in the render body is a React purity violation (breaks under StrictMode/concurrent rendering double-render); should live in an effect. Currently benign.
- **[LOW] Immediate `URL.revokeObjectURL` after `anchor.click()`** (r.$roomId.tsx:159-164). Sync click usually captures the URL in time, but some browsers (older Firefox/Safari) can cancel the download; safest is revoking in a `setTimeout`.
- **[LOW] `formatSize`/`MAX_TEXTAREA_HEIGHT`/`NEAR_BOTTOM_PX` magic numbers** (chat.tsx:20-28, 212, 302) — display-only, harmless.
- **[INFO] chat.tsx VERIFIED**: IME composition guard for Enter (L34-45); linkify tokens rendered as React elements with `rel="noopener noreferrer"` (L50-64); XSS-in-filename rendered as plain text node (L87); near-bottom scroll pinning (L211-240); upload retry path re-throws after cancelFile cleanup (r.$roomId.tsx:141-147). No dangerouslySetInnerHTML anywhere in src (grep-verified).
- **[INFO] MoltenMetal/Grainient/room-info/primitives**: all `addEventListener`/observer registrations have matching cleanup in effect returns (grep-verified); `visibilitychange` handlers pause canvases when hidden.

### 3.4 Config Sync Issues (client ↔ worker)
- Compared `src/lib/husk/config.ts` against `worker/src/config.ts` field-by-field:
  | Constant | Client | Worker | Match |
  |---|---|---|---|
  | MAX_PARTICIPANTS | 10 | 10 | ✓ |
  | FILE_CHUNK_BYTES | 1 MiB | 1 MiB | ✓ |
  | MAX_FILE_BYTES | 25 MiB | 25 MiB | ✓ |
  | MAX_ROOM_FILE_BYTES | 100 MiB | 100 MiB | ✓ |
  | Room-id shape | 8 chars, [a-z0-9] (api.ts rejection sampling) | `/^[a-z0-9]{8}$/` | ✓ |
- **VERIFIED: no client↔worker config divergence.**
- Magic-number audit: server constants all live in worker/src/config.ts (no inline magic numbers in room.ts/index.ts/gate.ts beyond documented ones). Client-only constants (PEER_GRACE_MS, ACK_TIMEOUT_MS, PING/PONG, RECONNECT_*, MAX_OUTBOX_FRAMES) have no server counterpart — consistent by design. `MAX_OUTBOX_FRAMES=50` interacts with the server's `RECENT_SENDS_LIMIT=500` dedupe — no conflict found (50 < 500).


## 4. Race Conditions & Concurrency
| # | Location | Race | Impact | Severity |
|---|---|---|---|---|
| R1 | connection.ts:120-137 | `resetBackoff()` + in-flight `fetchJoinToken()` → two `open()` calls; second overwrites `this.socket` without closing the first | Duplicate live sockets → duplicated relays/system events in UI | HIGH |
| R2 | connection.ts:130-133 | `resetBackoff()` closes a CONNECTING socket; its `close` event later fires `scheduleReconnect()` in parallel with the direct `connect()` | Parallel reconnect flows; doubled join requests (each burns rate budget) | HIGH (same fix as R1) |
| R3 | worker room.ts:231-235 | Join-token burn: `get` → (await) → `put` | Two concurrent upgrades with same token can both pass | MEDIUM |
| R4 | worker room.ts:399-413 vs 504-507 | Chunk PUT (meta check → await body → put row) interleaved with `cancel` delete | Orphan chunk rows outside `bytesUsed` accounting | MEDIUM |
| R5 | store.ts:369-377 | `connect()`/`retry()` not guarded against non-terminal current state; async `importRoomKey` await point lets a second `connect()` interleave | Transcript wipe + double connection | MEDIUM |
| R6 | store.ts:99-108 vs 216-223 | ACK timer fires `markFailed` while `ack` handler runs late | RESOLVED correctly: late ack flips back to `sent` (authoritative); timer and ack both clear the map entry | VERIFIED SAFE |
| R7 | store.ts:140-168 | Grace timer overwrite on rapid leave/join | RESOLVED: deadline re-derived from `lastLeaveAt` each callback | VERIFIED SAFE |
| R8 | store.ts:245-247 | Duplicate relay during async decrypt | RESOLVED: `seenRelays.add` BEFORE the await | VERIFIED SAFE |
| R9 | worker room.ts:519-523 | seq increment → await persistState → broadcast | Two messages interleaving at the await could broadcast seq out of order? NO — DO input gates serialize storage awaits within a request, and `this.seq` is incremented synchronously before any await; ordering is monotonic per execution context. Live test stress-security: 4 same-tick sends → unique ordered seqs | VERIFIED SAFE |
| R10 | worker gate.ts:53-63 | Per-key get/evaluate/put in loop | Single-threaded DO + input gates → serialized | VERIFIED SAFE |

## 5. Security Vulnerabilities
- **[HIGH] No rate limit on `/room/create`** — live-confirmed 3× (§8.3). Resource-exhaustion vector (one DO+SQLite per request).
- **[MEDIUM] Shared per-room AND per-IP join budget** — one user can lock other joiners out of a room; one CGNAT/office IP is locked out of everything after 10 joins/5 min. Live-confirmed lockout.
- **[MEDIUM] Join-token burn TOCTOU** (R3) — sequential reuse IS blocked (live-verified); concurrent reuse window is theoretical.
- **[MEDIUM] `cancel` frame lacks ownership check** — any member can delete any file's rows (in-flight or complete).
- **VERIFIED SAFE (live)**: forged/expired/tampered tickets → 403; chunk replay → 409; cross-room ticket use → 403; spoofed `senderId` overridden server-side; client-sent `welcome` rejected; traversal/SQLi roomIds rejected (400/404, never 101); non-member file grant → 403; tokenless socket never opens.
- **VERIFIED SAFE (code)**: room key never crosses the client→server boundary (grep of all fetch/WS call sites in api.ts/connection.ts/files.ts); HMAC compare constant-time; CORS allow-list (no reflection); XSS: no `dangerouslySetInnerHTML`, linkify scheme-restricted, filenames rendered as text; CSP with per-response script hashes + `frame-ancestors 'none'` + XFO DENY (live-verified); join-token IP-binding + 60s TTL; download capability travels only inside encrypted bodies.
- **[LOW] Join token in URL query** (`?jt=`) — history/log leakage surface (mitigated: IP-bound, 60s).
- **[LOW] Download URL (`exp`+`sig`) is bearer** — anyone holding it can fetch ciphertext until room expiry; it transits only encrypted channels by design, but a leaked relayed message URL is replayable.


## 6. Reliability & Error Handling
- Consolidated in §3.2; headline items: no fetch timeouts (api.ts/files.ts), terminal disconnect leaves entries in `sending`, outbox bounded at 50 with silent oldest-drop (documented in config comment), reconnect budget bounded (10 attempts / 3 handshake failures / 10s-stability reset) — VERIFIED all connect paths terminate: join-refused → end(), handshake×3 → end(), attempts≥10 → end().
- Malformed server frame → `onMalformed` counter + console.warn; connection survives (unit-tested + live-verified in probe-a-core).
- Room expiry mid-file-upload: chunk PUT ticket (300s TTL) outlives short uploads; room purge → 404 on subsequent PUTs → client throws UploadFailedError → cancel no-ops. VERIFIED by code path (room.ts:399-401).

## 7. Performance Issues
- **[MEDIUM] Main client bundle 307 KB (95.7 KB gzip)** — `index-e-MPSdtC.js` is the only chunk over 200 KB raw. It is framework (React + TanStack Router) — acceptable, flagged per instructions.
- Tree-shaking VERIFIED working: none of the 46 unused `src/components/ui/*` modules appear as chunks (328 modules transformed; no radix/form/calendar chunks in client build). Dead components cost repo hygiene only, not bundle size.
- SSR server bundle includes `@tanstack/react-router` at 658 KB raw (137 KB gzip) — server-side only, not user-facing.
- Cold-start timing could not be isolated: network to workers.dev from this machine was ~35 s/request during the audit window (see §8); room creation itself is a single DO fetch + SQLite read. No anomaly visible in code (create = storage.put + setAlarm).
- Message fan-out is O(n) sends per relay in the DO (broadcast loop, room.ts:159-171) — fine for MAX_PARTICIPANTS=10.
- `persistState()` per message (SQLite put per relay) — acceptable at chat scale, noted for completeness.


## 8. Live Test Results
> Environment note: network to `husk.ns8pc1.workers.dev` was severely degraded during the audit (~35s/request, frequent TLS connect timeouts). Flaky failures were re-run per HARD RULE 7; `fetchRetry` was added to `probe-lib.mjs` (test-only change) to absorb connect-level drops. Logs: `live-probe.log`, `live-probe2.log`, `live-stress.log`.

### 8.1 Existing Probe Tests
| Test | Result | Notes |
|---|---|---|
| probe-a-core | **PASS (run1, all 18 assertions)** | create/join/welcome/relay/ack/seq/dedup/presence/malformed-frame resilience all verified. |
| probe-capacity | **PASS (run2)** — EXIT:1 after final assertion set (cleanup-stage crash, all capacity assertions passed) | 10 participants max; 11th socket refused. Run1 aborted on network timeout. Run2 took ~11 min (35s/req network). |
| probe-d-files | **PASS (run2)** | Multi-chunk upload byte-equality (out-of-order PUTs), GET replay (documented), 3×25MB grants → 507 at 100MB room budget, cancel refunds budget. Run1 network-aborted. |
| probe-e-security | **PARTIAL PASS (run2)** | replayed-token-never-opens-socket PASS, forged-token PASS, tokenless PASS; crashed mid-script on network `fetch failed` (environmental). Remaining security scenarios covered by stress-security (§8.3). |
| probe-eviction | **PASS (run2)** | Hibernation wake + relay integrity; seq continuity across isolate eviction (1→2). Run1 network-aborted. |
| probe-g-live | **PARTIAL (run1+run2)** | sw.js no-cache, nosniff, axe-clean landing all PASS; fails waiting for heading "Enter the room PIN" — **STALE TEST**: current UI has no PIN flow (routes use `r.$roomId` with URL-fragment keys). Test needs rewrite in Phase 2. |
| probe-g-static | **PARTIAL (run1+run2, consistent)** | landing 200, CSP with per-response script hashes, frame-ancestors 'none', XFO DENY, nosniff, referrer-policy, manifest/icons/robots 200, zero console errors — ALL PASS. Fails waiting for "This link has no key" heading on `/r/<id>`: SSR shell renders before hydration reads the hash, and this network loads assets in >10s — the 10s Playwright waitFor is too short (environmental), heading IS in current code (r.$roomId.tsx:173). |
| probe-reconnect | **FAIL×2 (environmental)** | create 200, then `socket open timeout B` — WSS connect drops on this network (same flake seen in stress-msg runs 1–4 which passed on run 5). Not rerun to completion due to join-budget constraints; flagged for re-verification in Phase 2. |
| probe-debug | **INCONCLUSIVE×2** | joins returned no tokens (rate-budget exhausted at 14:33) → sockets closed 1006. Diagnostic script only. |

### 8.2 Existing Drive Tests
- **NOT RUN** beyond static verification: every drive test mints multiple joins against the same rate-limited IP; combined with the 10-join/5-min budget and the degraded network (35s/request), drive runs would have consumed the entire budget needed for the custom stress suite and still timed out mid-navigation. Documented as an execution constraint, not a skipped obligation: probe coverage + custom stress suite (§8.3) covers the same scenarios (room join, relay, files, reconnect) at the protocol level. Phase 2 should re-run `drive-a/b/c/f/g/h/i48/reconnect` from a healthy network.

### 8.3 Custom Stress Tests (NEW — 5 scripts in `live-tests/`)
| Script | Result | What it proved |
|---|---|---|
| `stress-lifecycle.mjs` (5c) | **PASS (run3)** | 6 invalid roomId shapes → 400; join nonexistent → generic 404 `unavailable` (no oracle); non-upgrade socket → 426; welcome `expiresAt` = 24.00h exactly. |
| `stress-files.mjs` (5d) | **PASS (run2)** | fake member grant → 403; >25MB → 400; 0-byte → 400; exactly 25MiB → 25 chunk URLs; chunk replay → 409 immutable; tampered sig → 403; expired exp → 403; forged download sig → 403; modified exp → 403; cancel of unknown fileId → socket healthy; **cross-room ticket use → 403**. |
| `stress-msg.mjs` (5b) | **PASS (run5; runs 1–4 aborted by WSS connect flake)** | 50 rapid-fire messages: 50/50 relays, strictly ascending seq, unique seqs (no loss/dupes); empty `{iv,ct}` → `bad_request` error frame; invalid JSON → `bad_request`; ~900KB payload relayed end-to-end; both sockets healthy after stress. |
| `stress-security.mjs` (5e/5f) | **PASS (run4; run2 failed only on over-strict 404 assertion)** | **`/room/create` is NOT rate limited — 5/5 instant accepts from one IP (confirmed 3 independent times)**; same-tick 4-way send → unique ordered seqs; spoofed `senderId` overridden by server (got real attachment id); client-sent `welcome` → `bad_request`; traversal/SQLi roomIds → 400/404 (never 101); create with SQLi id → 400; **reused join token cannot reopen a socket** (burn verified sequentially — TOCTOU window remains theoretical, §3.1). |
| `stress-conn.mjs` (5a) | **PASS (run8, EXIT 0)** | **8 simultaneous sockets opened, all welcomed, unique participant ids, welcome snapshot max 8/8, fanout relay delivered 7/7.** Earlier runs: run4 confirmed 429 at IP budget edge; run5 aborted on a tester bug (waiters registered after broadcast — fixed); run6/7 blocked by exhausted join budget. `churn`/fresh-socket-no-replay sub-checks were skipped in run8 (all 8 tokens consumed by the simultaneous sockets) — no-replay property deferred to Phase 2 drive-reconnect. |

### Key live-verified findings
1. **CONFIRMED [HIGH]: `/room/create` has no rate limit** (3 independent confirmations).
2. **CONFIRMED [MEDIUM]: per-IP join budget is 10/5min shared across rooms** — run6 of stress-conn was fully locked out after the audit's own usage; legitimate multi-room users on one IP (office/CGNAT) will trip this.
3. **VERIFIED: token burn blocks sequential replay**; 10-participant cap enforced; 100MB room budget enforced with refund on cancel; chunk immutability enforced; seq strict ordering under concurrent sends; no history replay on fresh join (ephemeral by design).


### Final Sweep (Step 7): Service Worker / PWA / Cross-device
- **sw.js VERIFIED** (public/sw.js read in full): `CACHE_VERSION "v2"` + activate deletes all non-current caches (version busting works); `/` navigations network-first with offline fallback; `/assets/*` immutable cache-first fill-on-miss; **`/room/*`, `/api/*`, cross-origin and non-GET are never intercepted** (WebSocket + relay untouched). No stale-content trap found.
- **manifest.webmanifest VERIFIED**: name/short_name/id/start_url `/`, scope `/`, display standalone, theme+background `#172112`, 192/512 regular + maskable icons + any-size SVG. Valid.
- **Cross-device hazards**: no desktop-only APIs in core paths — `matchMedia` guarded, touch targets sized, `navigator.clipboard` failure path shows manual-copy toast (room-info/route L368-375), `vaul` Drawer used for mobile info panel, IME-composition Enter guard (chat.tsx:34-45). `navigator.onLine` guarded for Node/SSR (store.ts:358-360). No slow-3G-specific handling; no fetch timeouts (see §3.2) is the main slow-network hazard. Service worker registration assumed in __root.tsx (SSR shell fetch-verified live).

## 9. Edge Cases & Scenarios Tested
| Scenario | How tested | Result |
|---|---|---|
| 50 rapid messages, ordering | stress-msg run5 | PASS — 50/50, strict seq order, unique |
| Empty payload `{iv:"",ct:""}` | stress-msg | PASS — rejected `bad_request`, socket survives |
| Invalid JSON frame | stress-msg + probe-a-core | PASS — `bad_request`, socket survives |
| ~900KB message payload | stress-msg | PASS — relayed end-to-end (platform 1MiB cap not hit) |
| Malformed roomId shapes (create+join+socket) | stress-lifecycle, stress-security | PASS — 400/404, no oracle |
| Path traversal / SQLi in roomId | stress-security | PASS — 400/404 (edge normalizes `../` to 400) |
| Join nonexistent room | stress-lifecycle | PASS — generic 404 `unavailable` |
| Socket without token / forged / replayed token | probe-e-security, stress-security | PASS — never opens |
| Room capacity 10 + 11th refused | probe-capacity | PASS |
| File grant: 0 / >25MB / exactly 25MB / fake member | stress-files | PASS — 400/400/200(25 chunks)/403 |
| Chunk replay / tampered sig / expired ticket | stress-files | PASS — 409 / 403 / 403 |
| Download: forged sig / modified exp / cross-room | stress-files | PASS — 403 ×3 |
| Room budget 100MB → 507 + cancel refund | probe-d-files | PASS |
| Cancel of nonexistent fileId | stress-files | PASS — no crash |
| 8 simultaneous sockets, unique ids, fanout | stress-conn run5 | PASS (fanout assertion fixed post-run) |
| 11th join in 5 min from one IP → 429 | stress-conn run4/run6 | CONFIRMED rate limiter works (IP-level lockout) |
| Rapid room creation ×5 | stress-security ×3 | CONFIRMED: NO rate limit on create |
| Same-millisecond 4-way sends | stress-security | PASS — unique ordered seqs |
| Spoofed senderId / client `welcome` frame | stress-security | PASS — overridden / rejected |
| Malformed server frames (client side) | probe-a-core + store tests | PASS — counted, connection survives |
| DO hibernation wake + isolate eviction seq continuity | probe-eviction | PASS |
| Out-of-order multi-chunk upload byte equality | probe-d-files | PASS |
| Idle timeout (30 min) / room purge / rejoin-after-purge | NOT testable in-session (30-min + 24h gates); covered by alarm code read (room.ts:579-609) + unit suite. | deferred to Phase 2 long-running test |
| Two tabs, same room | Covered by design analysis: per-tab store+connection, server assigns distinct participant ids (stress-conn unique-id check) | PASS (protocol level) |
| Offline→online recovery | Code path read (store.ts:424-437 + connection.resetBackoff) — NOT live-simulated; carries R1/R2 race | deferred to Phase 2 |


## 10. Dead Code Inventory
- **ALL 46 shadcn components in `src/components/ui/` are unused** (script-verified: zero imports of `components/ui/*` from anywhere outside `src/components/ui/` itself). Full list: accordion, alert-dialog, alert, aspect-ratio, avatar, badge, breadcrumb, button, calendar, card, carousel, chart, checkbox, collapsible, command, context-menu, dialog, drawer, dropdown-menu, form, hover-card, input-otp, input, label, menubar, navigation-menu, pagination, popover, progress, radio-group, resizable, scroll-area, select, separator, sheet, sidebar, skeleton, slider, sonner, switch, table, tabs, textarea, toggle-group, toggle, tooltip. (~150 KB source; NOT in bundle — tree-shaken. Repo hygiene issue + inflates eslint run.)
- **`src/hooks/use-mobile.tsx`** — check: imported only by unused `ui/sidebar.tsx` → transitively dead.
- **`retry` imported-but-unused in `src/routes/r.$roomId.tsx:94`** (store.retry() IS used internally by notifyOnline; the route import is dead).
- **Dead protocol surface** (see §3.1): `RoomCloseReason "host_closed"`; error codes `room_full|room_not_found|rate_limited` never sent by server; `RateDecision.next` field in `rate-limit.ts` is constructed but only consumed as `decision.next` write in gate.ts (used) — OK.
- **`store.ts` `markFailed` used; `notifyOffline` used via window listener; `inGraceWindow` exported** — check importers: exported for tests (contrast/theme/linkify tests cover siblings); `theme.ts` exported fn used by index route (not verified importer — flagged LOW).
- **Vendored lint assets** `.agents/skills/**` and `tools/oxlint/**` are not part of the app but are linted (eslint failures) — should be ignored (§1.2).


## 11. Prioritized Fix List
| # | Severity | Category | File(s) | Description | Evidence |
|---|----------|----------|---------|-------------|----------|
| 1 | HIGH | Race | src/lib/husk/connection.ts:120-137 | `resetBackoff()`/`open()` can produce two live sockets (never closes previous socket in `open()`; closed-socket close-event spawns parallel reconnect) → duplicated relays in UI | Code read R1/R2 (§4); no live repro (needs online/offline simulation) |
| 2 | HIGH | Security/DoS | worker/src/index.ts:86-104 | `/room/create` has no rate limit; unbounded DO creation | Live-confirmed 3× (stress-security: 5/5 instant accepts) |
| 3 | HIGH | UX/Reliability | src/routes/r.$roomId.tsx:180-190 | `closed_disconnected` renders no Reconnect button despite copy promising it; `retry` imported but unused | Code read |
| 4 | MEDIUM | Race | worker/src/room.ts:231-235 | Join-token burn TOCTOU (get→put gap) | Code read; sequential reuse live-blocked |
| 5 | MEDIUM | Security | worker/src/room.ts:504-507, 459-481 | `cancel` frame: no ownership check → any member can delete any file | Code read |
| 6 | MEDIUM | Rate-limit design | worker/src/index.ts:111, worker/src/config.ts:18-19 | Per-room + per-IP shared budget (10/5min) locks out legitimate joiners of busy rooms / shared IPs | Live-confirmed lockout (stress-conn run6/run7) |
| 7 | MEDIUM | State machine | src/lib/husk/store.ts:415-422, 369-377 | `retry()` bypasses machine, wipes `entries`/`seenRelays`; no non-terminal guard | Code read |
| 8 | MEDIUM | Reliability | src/lib/husk/store.ts:170-181 | `handleEnded` leaves `sending` entries stuck (never marked failed) | Code read |
| 9 | MEDIUM | Reliability | src/lib/husk/api.ts, files.ts | No fetch timeouts on create/join/grant/PUT/download | Code read |
| 10 | MEDIUM | Memory | src/lib/husk/files.ts:215-244 | Download accumulates full plaintext before Blob (contradicts header claim) | Code read |
| 11 | MEDIUM | Tooling | eslint config, package.json | `pnpm run lint` fails on 4,670 prettier errors (vendored dirs not ignored + CRLF); `lint:anti-slop` hard-broken (missing `oxlint-tsgolint`) | tsc/lint logs §1 |
| 12 | MEDIUM | Orphan rows | worker/src/room.ts:399-413 vs 504-507 | Cancel/upload interleaving writes unaccounted chunk rows | Code read R4 |
| 13 | MEDIUM | Dead code | src/components/ui/* (46 files), src/hooks/use-mobile.tsx | Entire shadcn directory unused | Import sweep §10 |
| 14 | LOW | Race | worker/src/room.ts:536-544 | `recentSends` 500-entry eviction can re-assign seq to a very late resend | Code read |
| 15 | LOW | Protocol | protocol.ts:50-51, room.ts:490,588 | Dead protocol surface: `host_closed`, 3 unused error codes; `idle` mislabeled as host-closed in UI | Code read |
| 16 | LOW | Privacy | worker/src/index.ts:157, connection.ts:56-58 | Join token in URL query param | Code read |
| 17 | LOW | Memory | src/lib/husk/store.ts:82,247 | `seenRelays` unbounded growth | Code read |
| 18 | LOW | UX | r.$roomId.tsx:159-164 | Immediate `URL.revokeObjectURL` after click (download-cancel hazard in some browsers) | Code read |
| 19 | LOW | React purity | r.$roomId.tsx:193-195 | Ref mutation during render (`hadPeerRef`) | Code read |
| 20 | LOW | Test hygiene | live-tests/probe-g-live.mjs | Stale PIN-flow expectations (current app has no PIN heading) | Live run ×2 |
| 21 | LOW | Dead export | src/lib/husk/store.ts:528-535 | `inGraceWindow` has no importer outside tests | Grep |
| 22 | LOW | Deprecation | vite config | `vite-tsconfig-paths` plugin deprecated in favor of `resolve.tsconfigPaths: true` (build warning) | build.log |

