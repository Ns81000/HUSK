# Phase 3 — Reliability, Concurrency & Race Conditions

## Summary

Read `room-machine.ts` (+ all 8 tests, which make real state assertions), `connection.ts`, `backoff.ts`, `store.ts`, `api.ts` line-by-line against the DO side (`room.ts`) for cross-boundary races; grepped for `beforeunload`/`visibilitychange` (zero hits). Ran the full suite once: **7 files, 37 tests, all pass** (`pnpm test`; no `.only`/`skip` present, worker tests included via root vitest). The state machine itself is well-built and its tests are genuine; the reliability gaps are in the layer *around* it — reconnect termination, per-message failure handling, and duplicate handling across reconnects. No test anywhere drives two peers or a real socket, so every finding below is untested behavior by construction.

## Findings

### [HIGH] Dead-room reconnect loop never terminates — no terminal state for "room is gone" via reconnect (src/lib/husk/connection.ts:69-79 + store.ts:168-171 + worker/src/room.ts:113-115)
- **Category:** Reliability
- **Evidence:** `socket.addEventListener("close", ...)` always calls `scheduleReconnect()`; `attempt` only grows, backoff caps at 15s, and nothing ever stops the loop except `disposed`. When the server's alarm closes the room (`{t:"closed"}`), the store applies a terminal state (EXPIRED/LEAVE) but **never calls `connection.close()`** — the close event then fires and the client reconnects forever against a room whose DO now returns 404 on `/socket`. Same loop for a guest who opens a stale link after the room already died: 404 handshake → error → close → retry, every ~15s, indefinitely. The 404 handshake is never distinguished from a network blip.
- **Why it matters:** The UI shows "Reconnecting" forever for a room that will never exist again — exactly the "infinite unexplained spinner" the spec forbids (Section 6). It also burns the user's request budget and the Worker's free-tier request quota (each retry is a Worker invocation).
- **Confidence:** High
- **Recommended fix:** In `store.ts`'s `closed` handler, call `connection.close()`. In `connection.ts`, treat an HTTP 404 handshake response (fetch the socket URL's liveness via a HEAD/GET probe, or inspect the close code from the failed upgrade) as a terminal `room_gone` signal surfaced to the store (map to `closed_not_found`); cap total reconnect attempts (e.g. 10) into a visible "Disconnected — the room may have closed" terminal state with a manual retry button.

### [HIGH] No per-message failure/retry: messages silently stay "sending" forever (src/lib/husk/store.ts:185-212, 258-264)
- **Category:** Reliability
- **Evidence:** `publish()` sets `delivery:"sending"` and calls `active.send(id, sealed)`. `send()` returns true whenever the socket is OPEN — but OPEN does not mean delivered; if the socket dies between send and the server's `ack`, the entry is never updated (the frame was already removed from the outbox, so the flush-on-reconnect never resends it). `markFailed()` exists but is reachable **only** when `seal()` throws — which for AES-GCM on a valid key effectively never happens. No timeout on `sending`, no retry code path, no resend function anywhere in the store.
- **Why it matters:** Spec Section 4.5: "the client must show a per-message failed/retry state — never silently drop a message the user believes was sent." Today the exact forbidden behavior is the default path under any mid-send disconnect.
- **Confidence:** High
- **Recommended fix:** Add a timeout (e.g. 10s after send with no `ack`) that flips the entry to `failed`; implement `retry(id)` that reseals/reuses the stored plaintext and resends; for buffered-but-unacked frames, keep them in the outbox keyed by id so a successful flush can also resolve them.

### [MEDIUM] Receiver-side duplicate messages after reconnect resend — no dedup by localId (worker/src/room.ts:161-189 + src/lib/husk/store.ts:116-147)
- **Category:** Race Condition / Reliability
- **Evidence:** The outbox re-sends buffered frames after reconnect. If the original frame reached the DO but the `ack` was lost, the DO assigns a **new seq** and broadcasts again. Receivers do `entries: [...current.entries, {...}]` with `id: message.localId` and never check whether an entry with that id already exists — producing two bubbles with identical React keys and two entries for one message.
- **Why it matters:** Visible duplicate messages under a common real-world pattern (send → ack lost → reconnect). Also corrupts the `ack` path (maps over entries by id, updating both copies).
- **Confidence:** High (code path verified end-to-end); Medium (requires ack loss, which reconnects make likely)
- **Recommended fix:** In the DO, keep a small set of recently seen `(socketId, localId)` pairs and drop resends; *and* in the store's relay handler, skip insertion when `entries.some(e => e.id === message.localId)` (defense in depth — the DO set is wiped on eviction).

### [MEDIUM] `parseServerMessage` validates the tag only, then blind-casts the rest of the frame (src/lib/husk/protocol.ts:86-101)
- **Category:** Reliability
- **Evidence:** `return decoded as ServerMessage;` after checking only `decoded.t`. A `relay` frame missing `payload.iv` reaches `open(key, message.payload)` → `fromBase64Url(undefined)` → `TypeError: value.replace is not a function` inside `openBytes`... which is *not* a `DecryptionFailedError`, so store.ts:148-164's `if (error instanceof DecryptionFailedError)` silently swallows it and the frame vanishes without a trace.
- **Why it matters:** The protocol module's docstring promises "callers never branch on raw representations," but malformed frames are dropped silently instead of being surfaced as an error frame/count. A buggy or hostile relay can desync clients invisibly.
- **Confidence:** High
- **Recommended fix:** Per-tag field validation in `parseServerMessage` (return null on shape mismatch); in the store, count/log and surface a toast on repeated parse failures.

### [MEDIUM] Grace-window logic runs on the client clock with a stale-peers race (src/lib/husk/store.ts:82-103)
- **Category:** Race Condition
- **Evidence:** On `presence leave`, a client-side `setTimeout(PEER_GRACE_MS)` decides when to show "A participant left." The callback re-reads `get().participants` at fire time — but a *second* leave event (2 peers leaving nearly simultaneously) overwrites `graceTimer` after clearing it, so the first peer's grace is silently extended; conversely a `join` arriving between two `leave`s clears the timer entirely, and the remaining `leave` restarts it. The system message also only fires when `peers <= 1`, so a 3-person room where one leaves shows nothing — by design or accident, it's undocumented.
- **Why it matters:** The spec's 8-second grace behavior is the "proven pattern" being carried forward; its edge behavior (multi-peer leaves) is undefined and timer-overwrite races produce inconsistent UI.
- **Confidence:** High (code), Medium (impact)
- **Recommended fix:** Track grace as data (a deadline timestamp per leave event) rather than one mutable timer; derive the visible state in the render path from `now - lastLeaveAt` and `participants.length`.

### [LOW] Duplicate `leave` broadcasts when a socket errors then closes (worker/src/room.ts:191-209)
- **Category:** Reliability
- **Evidence:** `webSocketError` delegates to `webSocketClose`; the runtime may deliver both events for one socket, and the handler broadcasts a `presence leave` each time (it doesn't check whether the socket is already gone from `getWebSockets()`).
- **Why it matters:** Clients receive duplicate leave events; harmless with the current timer logic (it re-arms the same grace), but it feeds finding above and any future per-leave logic.
- **Confidence:** Medium (depends on runtime event delivery)
- **Recommended fix:** In `webSocketClose`, bail early if the socket is no longer in `state.getWebSockets()` (or dedupe by id+close-seen set).

### [LOW] Late async decrypt can write into a closed store (src/lib/husk/store.ts:132-147)
- **Category:** Race Condition
- **Evidence:** `handleServerMessage` awaits `open()`; a `leave()` that resets `entries: []` can complete while a decrypt is in flight; the `set()` then appends the entry to the freshly cleared store of a terminal-state room.
- **Why it matters:** Currently masked (the terminal ClosedScreen doesn't render entries), but it's an unguarded stale-write that will bite the first person who adds a "reopen/rejoin" affordance.
- **Confidence:** High (mechanism), Low (user-visible impact today)
- **Recommended fix:** Capture the pin/selfId at handler start; after the await, verify `get().pin === capturedPin && get().state === expected` before writing.

### [LOW] Outbox is unbounded and never expires (src/lib/husk/connection.ts:40, 88-95)
- **Category:** Reliability
- **Evidence:** `outbox: ClientMessage[]` grows without cap while disconnected; `flush()` sends everything on reconnect, however stale.
- **Why it matters:** A laptop asleep overnight with typed-but-unsent messages (each sealed and queued) dumps them all into a room that may have been closed hours ago (where they vanish into the 404 reconnect loop from finding 1).
- **Confidence:** High (code), Low (practical frequency)
- **Recommended fix:** Cap the outbox (e.g. 50 frames, oldest dropped with a system note) and drop frames older than the room's expected expiry.

## Verified-Correct

- **Room state machine is explicit and total** — every UI state from spec Section 4 exists as a named state; illegal transitions return the current state unchanged (room-machine.ts:54-100), making it safe under duplicate/out-of-order network events. Tests assert real state outcomes, cover grace enter/exit, reconnect paths, capacity rejection, and terminal-state immutability (a loop over all events × all terminal states — room-machine.test.ts:43-55).
- **Spec Section 6 rows, one by one:**
  - *Simultaneous join at capacity* — DO resolves atomically in the synchronous `/socket` handler (room.ts:116-120); second joiner gets 403. Structurally correct; no HTTP-level test (Phase 6).
  - *Host crash / no graceful disconnect* — no `beforeunload`/`pagehide` cleanup exists anywhere (grep: zero hits); server alarm is the only closer; dead sockets are reaped by the hibernation runtime's heartbeat and the idle alarm catches the rest. Matches spec.
  - *Reconnect after network drop* — backoff is bounded and jittered (backoff.ts: 1s→15s cap, ±20% jitter, jitter spread tested); visible "Reconnecting" indicator with `aria-live="polite"` (room-info.tsx:33). Matches spec bounds (1s/15s). *Termination* is finding 1.
  - *Duplicate-tab same-identity* — both tabs connect independently; the DO assigns each socket its own UUID and relays to all sockets including same-key tabs; sender dedup is by socket id, so a second tab sees the first tab's messages as a peer's and vice versa — messages appear in both, no server state confusion. The spec's "don't create two distinct users" is satisfied loosely (each tab is a distinct participant UUID, count includes both) — acceptable, but note participant counts will read 1 higher per extra tab; flagging as intended-behavior-ambiguity, not a bug.
  - *Interrupted file upload* — **overtaken by events:** with the R2→DO migration (Phase 1 plan), orphan cleanup must be redesigned; the DO-side plan adds cancel-frame row deletion and alarm `deleteAll()`. No client retry UI for a failed upload exists (r.$pin.tsx:91-113 just throws away the error — `onSendFile` has no try/catch, so a failed upload is an unhandled rejection with zero UI feedback; flagged here, fix lands with the Phase 1 migration).
  - *PIN collision on creation* — client retries on 409 up to 5 attempts with a fresh PIN (api.ts:22-39), never surfaces the collision, has a finite retry limit. Correct.
- **Clipboard/share fallback works** — copy failure flips to a visible fallback with instructions, and the always-visible selectable input already contains the full link (room-info.tsx:79-94). Better than the spec minimum.
- **Message ordering is server-authoritative** — DO monotonic `seq`, client sorts with `orderedEntries()` (seq primary, ts tiebreak), timestamps display-only. No client-clock ordering anywhere.
- **No `.only`/`skip`/weak assertions found** — suite is small but every test asserts concrete outcomes (37/37 green in 0.5s).
- **Backoff is bounded + jittered** — no thundering-herd unbounded growth; caps at 15s (config), jitter ±20% (tested).

## Phase Verdict

The deterministic core — state machine, DO atomics, PIN collision retry, backoff — is genuinely solid and matches the spec's edge-case list better than most Lovable output would. The problems concentrate in the reconnect lifecycle: the client never stops reconnecting to a dead room, never times out a "sending" message, and can duplicate messages after an ack loss — all classic lifecycle-boundary bugs the happy-path tests structurally cannot see. None of these are architectural; all three HIGH/MEDIUM lifecycle fixes are local, and the interrupted-upload finding resolves as part of the Phase 1 storage migration. **Verdict: needs minor fixes** (with the reconnect-termination and message-failure findings treated as pre-launch blocking).
