# Phase 3 Log — Reliability & Race-Condition Fixes

## What changed

### Reconnect termination (HIGH)

- `src/lib/husk/connection.ts` — rewritten lifecycle. `fetchJoinToken` now
  returns the full `JoinResult` (not `string | null`); a refused join reports a
  new one-shot `onEnded("join_refused_unavailable" | "join_refused_rate_limited")`
  and disposes the connection. Sockets that close without ever opening count
  toward `RECONNECT_HANDSHAKE_FAILURES` (3, config.ts): the join endpoint keeps
  minting tokens, so a token that repeatedly fails to upgrade means the room is
  gone → terminal `join_refused_unavailable`. Opened-then-dropped sockets are
  blips — but a connection that lived under `RECONNECT_STABLE_MS` (10 s) counts
  against the budget, and `RECONNECT_MAX_ATTEMPTS` (10) exhausted attempts end
  in `onEnded("attempts_exhausted")`. Previously the attempt counter reset on
  every `open`, so a flapping link could retry forever (found while testing).
- `src/lib/husk/room-machine.ts` — new terminal state `closed_disconnected`
  entered via `CONNECTION_LOST`; added to `TERMINAL_STATES` and the immutability
  test loop.
- `src/lib/husk/store.ts` — `onEnded` maps refused-unavailable →
  `ROOM_NOT_FOUND`, refused-rate-limited → `RATE_LIMITED`, attempts-exhausted →
  `CONNECTION_LOST`. A server `closed` frame now applies the terminal state AND
  disposes the connection (the audit's primary fix). New `retry()` action
  re-runs `connect` with the stored pin + key fragment; the room screen's
  `ClosedScreen` shows a "Reconnect" button for `closed_disconnected`
  (new `CLOSED_COPY` entry in `src/routes/r.$pin.tsx`).

### Per-message failure/retry (HIGH)

- `config.ts` — `ACK_TIMEOUT_MS = 10_000`.
- `store.ts` — per-entry ack timers: `publish` arms a 10 s timer after send; a
  matching `ack` or own `relay` clears it; on expiry the entry flips to
  `failed`. On `status === "open"` the store re-arms timers for entries still
  `sending`, giving buffered-but-unacked frames a fresh window after the
  reconnect flush resolves them. New `retryMessage(id)` reseals the stored
  plaintext body and resends under the SAME localId (so the DO dedup and own-
  relay resolution keep working). `DeliveryNote` (`chat.tsx`) renders a Retry
  button next to "Not sent".

### Receiver-side dedup (MEDIUM)

- `store.ts` — a synchronous `seenRelays` Set keyed by localId. An earlier
  version checked `entries.some(...)` instead; a store test proved that two
  relays arriving before the first decrypt completes both pass that check (the
  insert is async), so the set is registered BEFORE the decrypt and cleared on
  connect/leave.
- `worker/src/room.ts` — bounded `recentSends` map (`(socketId, localId)` →
  seq, limit 500, FIFO eviction): a resend is not re-relayed and not assigned a
  new seq; the sender gets a fresh ack carrying the ORIGINAL seq. Wiped on
  room create and on the alarm purge.

### `parseServerMessage` shape validation (MEDIUM)

- `protocol.ts` — per-tag field validation (scalars, enums, participant list,
  sealed envelope); any mismatch returns null. `connection.ts` calls a new
  `onMalformed` handler per rejected frame; the store counts frames in
  `malformedCount` and `console.warn`s (telemetry hook) instead of dropping
  silently.

### Grace-window race (MEDIUM)

- `store.ts` — `lastLeaveAt` deadline data replaces the single mutable timer.
  The timer still schedules expiry, but the callback re-reads the deadline and
  reschedules if a newer leave restarted the window (join clears the deadline).
  Exported `inGraceWindow(lastLeaveAt, now)`; `ConnectionIndicator`
  (room-info.tsx) derives the "peer may be reconnecting" suffix from store
  `lastLeaveAt` in the render path instead of trusting the state alone.

### Duplicate leave broadcast guard (LOW)

- `worker/src/room.ts` — `webSocketClose` dedupes via a `WeakSet<WebSocket>`.
  **Deviation from the audit's first suggestion:** its primary recommendation
  ("bail if the socket is no longer in `getWebSockets()`") suppresses ALL leave
  broadcasts under workerd — the hibernation runtime has already removed the
  socket from `getWebSockets()` when the close event fires. An integration test
  that waits for the leave frame timed out under the membership check; with the
  audit's alternative (dedupe by close-seen set) the leave arrives exactly once.

### Stale-write guard (LOW)

- `store.ts` — the relay handler captures pin + state before the decrypt await;
  `isStale()` re-verifies both before either insert path. `leave()` now also
  drops pending ack timers, the grace timer, the seen-relay set, and the key
  fragment.

### Outbox cap + expiry (LOW)

- `connection.ts` — outbox entries are `{frame, queuedAt}`; cap
  `MAX_OUTBOX_FRAMES = 50` (oldest dropped); the welcome frame's `expiresAt`
  is recorded and frames queued after that instant are pruned on enqueue and
  before every flush.

### Tests

- New `src/lib/husk/protocol.test.ts` (6), `connection.test.ts` (9; stubbed
  WebSocket global, fake timers, stubbed `VITE_WORKER_URL` + module reset since
  `config.ts` reads the env at module load), `store.test.ts` (11; store built
  through a new `createRoomStore(spawnConnection?)` factory — the connection is
  injected, which is also what makes store-level testing possible; real WebCrypto
  for seal/open, fake timers for ack/grace deadlines).
- Worker integration additions (5): PIN collision 409; interrupted-upload cancel
  deletes rows and refunds the 100 MB budget; duplicate tabs behave as distinct
  participants; resent localId → one relay + original-seq ack; close broadcasts
  presence leave exactly once.
- `room-machine.test.ts` extended for `closed_disconnected` (now 9 tests).

## Deliberate behaviour notes

- The handshake-failure heuristic (3 failed upgrades on freshly minted tokens)
  is how "room gone" is detected post-join; the browser WebSocket API exposes
  no HTTP status, so the audit's "inspect the failed upgrade" is approximated
  by repetition. Rate-limited joins are still distinguished exactly (429 from
  `/room/join`).
- Terminal `closed_disconnected` is recoverable via the explicit Reconnect
  button, or automatically when the browser fires `online` (Phase 4).

## Test status

- `pnpm exec tsc --noEmit -p tsconfig.json` — pass
- `pnpm exec tsc --noEmit -p worker/tsconfig.json` — pass
- `pnpm test` — **87/87 pass** (68 node: 37 pre-existing + 9 protocol + 9
  connection + 11 store + 2 room-machine additions; 19 workers: 14 pre-existing
  + 5 new edge cases)
- `pnpm build` — pass
- Edge re-tests: DO resend dedup and exactly-once leave are pinned by worker
  tests; grace race, ack-loss duplicates, stale decrypts by store tests.

## Residual risk

- The outbox cap silently drops the oldest frames (spec's "with a system note"
  was not implemented: the frames are sealed ciphertext, so no plaintext note
  can be shown for them without keeping the plaintext, which the store does not
  retain for unsent messages).
- `RECONNECT_STABLE_MS` (10 s) is a heuristic threshold for "stable enough to
  reset the budget"; not spec-mandated.
- Lint repo-wide remains red (pre-existing baseline; touched files clean).
