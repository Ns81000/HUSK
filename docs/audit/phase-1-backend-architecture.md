# Phase 1 — Backend, Architecture & R2→Durable-Object Migration

## Summary

Read `worker/wrangler.toml`, `worker/r2-lifecycle.json`, `worker/src/{index,room,rate-limit,tickets,config,types,globals.d}.ts` end-to-end, plus the client transfer path `src/lib/husk/files.ts` and both config files. Re-verified current Cloudflare limits against developers.cloudflare.com (DO limits page fetched live 2026-08-27; Workers limits via search of the same domain). Headline: the project **cannot deploy to the Workers Free plan as configured** (KV-backed DO class + R2 binding), the KV namespace ID is still an unfilled placeholder, and — worse — **file download is broken outright**: the client fetches a route the Worker does not serve, and ignores the signed download URL it was given. The migration to SQLite-backed DO storage is not just desirable, it is required by the deployment constraint, and the DO code is well positioned for it (hibernation + alarm-driven purge already exist).

## Findings

### [CRITICAL] Cannot deploy to Workers Free plan: KV-backed DO class + R2 binding (worker/wrangler.toml:14-21)
- **Category:** Architecture / Deployment blocker
- **Evidence:**
  ```toml
  [[migrations]]
  tag = "v1"
  new_classes = ["HuskRoom"]
  [[r2_buckets]]
  binding = "HUSK_FILES"
  bucket_name = "husk-files"
  ```
- **Why it matters:** Verified live against https://developers.cloudflare.com/durable-objects/platform/limits/: on the Free plan "Only Durable Objects with SQLite storage backend are available," and KV-backed classes exist only for accounts that already had them. R2 bucket activation requires adding a payment method (confirmed via Cloudflare community/dev guides, 2025–2026 era), which the deployment constraint ("no credit card") forbids. As written, `wrangler deploy` either fails or deploys a config the account cannot run.
- **Confidence:** High
- **Recommended fix:** Switch the migration to `tag = "v2", new_sqlite_classes = ["HuskRoomV2"]` (a *new* class name — an existing deployed KV-backed class cannot be converted in place; if never deployed, `v1` can be replaced by a single `new_sqlite_classes` entry), remove the `[[r2_buckets]]` block, and replace file storage with chunked DO storage per the R2 Removal Plan below.

### [CRITICAL] File download is broken: client fetches a route the Worker doesn't serve and ignores the signed URL (src/lib/husk/files.ts:129-131 vs worker/src/index.ts:166)
- **Category:** Reliability
- **Evidence:** client:
  ```ts
  const response = await fetch(
    `${WORKER_URL}/room/${pin}/object/${encodeURIComponent(objectKey)}`,
  );
  ```
  Worker route table: `/room/create`, `/room/join`, `/room/{6digits}/socket`, `/room/{6digits}/upload-ticket`, and only `^\/object\/(.+)$` for objects. There is no `/room/<pin>/object/...` handler. Additionally the client drops `ticket.downloadUrl` (which carries the required `?exp=&sig=` params) on the floor — even a correctly-pathed request would fail `verifyTicket` with 403.
- **Why it matters:** Every file share in the app fails at download with a generic "Download failed." This has apparently never worked end-to-end; no test covers it.
- **Confidence:** High
- **Recommended fix:** This code is being rewritten by the R2 removal anyway; the new implementation must include an integration test that actually PUTs and GETs bytes through the Worker routes.

### [CRITICAL] KV namespace ID is an unfilled placeholder (worker/wrangler.toml:27)
- **Category:** Deployment blocker
- **Evidence:** `id = "PASTE_KV_NAMESPACE_ID_HERE"`
- **Why it matters:** `wrangler deploy` fails validation with this value; README step 4 tells the user to paste it but the checked-in state was never completed. (If the rate-limit KV migrates into the room DO or stays, this must be resolved either way before deploy.)
- **Confidence:** High
- **Recommended fix:** Either create the namespace and paste the ID, or (preferred, fewer moving parts) move join rate-limiting counters into a single dedicated DO or keep KV and complete setup; document the choice.

### [HIGH] Upload-ticket endpoint is unauthenticated and unthrottled; tickets are not single-use (worker/src/index.ts:134-164, worker/src/tickets.ts:44-64)
- **Category:** Security / Abuse
- **Evidence:** The `/room/<pin>/upload-ticket` route performs no room-membership check, no rate limit, and issues *both* a PUT and a GET signature for a fresh `pin/uuid` key. `verifyTicket` checks only HMAC + expiry — there is no use-once registry, so a ticket is valid for its full 5-minute TTL with unlimited replays.
- **Why it matters:** Any anonymous internet client can mint upload/download URL pairs for arbitrary PIN prefixes and use Husk as free anonymous 100 MB file hosting (ciphertext, but still abused storage/egress). It also contradicts the README's explicit claim: "Upload and download tickets are single-use" (README.md:96) — the code does not implement single-use.
- **Confidence:** High
- **Recommended fix:** Gate ticket issuance on room membership (have the DO confirm the requester's WebSocket is currently connected — e.g. ticket request proxied through the DO which tags sockets), and add a KV/DO-backed nonce registry to make tickets genuinely single-use, or shrink TTL and accept documented replayability honestly in the README.

### [HIGH] WebSocket route bypasses join rate limiting and is a free PIN existence oracle (worker/src/index.ts:127-132)
- **Category:** Security
- **Evidence:**
  ```ts
  const socketMatch = /^\/room\/([0-9]{6})\/socket$/.exec(url.pathname);
  if (socketMatch) { ... return stub.fetch(request); }
  ```
  No `checkJoinAllowed` call, unlike `/room/join`. A nonexistent PIN returns HTTP 404; a live room returns 101 — a distinguishable, unlimited-speed oracle.
- **Why it matters:** The 10-attempts/5-min join rate limit is the spec's anti-brute-force control (Section 5). An attacker who skips `/join` and probes `/socket` gets a clean "does this PIN exist" signal across the 900k PIN space with no throttle, then only needs to wait/listen for ciphertext once connected to a live room.
- **Confidence:** High
- **Recommended fix:** Apply the same `checkJoinAllowed` budget to the `/socket` route (keyed on IP), and ideally require the client to present a short-lived join ticket minted at `/room/join` success.

### [HIGH] 100 MB max file size is unsafe under Free-plan DO storage and unenforced in chunks (worker/src/config.ts:21, src/lib/husk/config.ts:22)
- **Category:** Architecture / Performance
- **Evidence:** `MAX_FILE_BYTES = 100 * 1024 * 1024`. Verified limits: SQLite DO storage = 5 GB per account (Free), 1 GB per object on Free per the limits-page FAQ, key+value ≤ 2 MB per row. Client already chunks at 1 MiB (`FILE_CHUNK_BYTES`) but buffers the entire ciphertext in memory before a single PUT (files.ts:84-97).
- **Why it matters:** Under DO storage, one 100 MB file = ~100 storage rows; ~50 concurrent max-size transfers exhaust the account-wide 5 GB. And `encryptAndUpload` holds the whole ciphertext (plus a second copy in `blobParts`) in RAM — for 100 MB that is 200+ MB of browser memory, exactly what the spec's "stream encryption above ~5MB" clause forbids.
- **Confidence:** High
- **Recommended fix:** Cap files at a value that makes the Free-plan arithmetic comfortable (25 MB recommended; still 25 rows/file, ~200 concurrent account-wide), and rewrite `encryptAndUpload`/`downloadAndDecrypt` to stream per-chunk (upload each chunk as its own request or a streamed body; never materialize the full ciphertext).

### [MEDIUM] 60-second alarm polling wakes every room every minute for up to 24 hours (worker/src/room.ts:101, 238; worker/src/config.ts:12)
- **Category:** Performance / Free-plan budget
- **Evidence:** On create: `setAlarm(Date.now() + ALARM_INTERVAL_MS)`; in `alarm()`, the fallthrough re-arms `now + ALARM_INTERVAL_MS` unconditionally. `ALARM_INTERVAL_MS = 60_000`.
- **Why it matters:** A room that simply sits open burns ~1,440 DO invocations/day. DO requests count against Free-plan daily allowances; 30 concurrent rooms ≈ 43k requests/day of pure polling, on a plan shared with 100k total.
- **Confidence:** High (mechanism verified in code); Medium (exact current free-tier DO request allowance — recheck pricing page at implementation time)
- **Recommended fix:** Arm the alarm at the *next meaningful deadline* instead of polling: on create set alarm at `min(idleDeadline, hardExpiry)`; on each join/close recompute; only re-arm short-interval while a grace window is pending. Zero polling in steady state.

### [MEDIUM] PIN format is inconsistent between create and WebSocket/ticket routes (worker/src/index.ts:45,127,134)
- **Category:** Reliability
- **Evidence:** `PIN_PATTERN = /^[1-9][0-9]{5}$/` gates `/room/create` and `/room/join`, but the socket and upload-ticket regexes are `[0-9]{6}` — leading-zero PINs pass routing but can never exist (create rejects them).
- **Why it matters:** Harmless today only because the DO rejects unknown rooms; but it means client-side PIN generation must match *both* patterns, and any future looseness in the DO path becomes reachable state. Verify against `src/lib/husk/pin.ts` in Phase 2.
- **Confidence:** High (mismatch verified)
- **Recommended fix:** Single shared PIN regex constant used by all four routes.

### [MEDIUM] Worker verification commands in README don't work; worker package has no test script (README.md:84-89, worker/package.json)
- **Category:** Reliability / DX
- **Evidence:** README instructs `npx tsgo -p worker/tsconfig.json` — `tsgo` is not installed anywhere in the repo. `worker/package.json` has only `dev`/`deploy` scripts and no `typescript` devDependency; `pnpm exec tsc` from inside `worker/` fails with "command not found". (Root `pnpm exec tsc --noEmit -p worker/tsconfig.json` passes cleanly — exit 0.) Worker tests do run via root vitest (`vitest.config.ts` includes `worker/**/*.test.ts`), but there is no documented command for it.
- **Why it matters:** The documented pre-deploy verification cannot be executed as written; a fresh contributor silently skips type-checking the worker.
- **Confidence:** High
- **Recommended fix:** Add `typecheck`/`test` scripts to `worker/package.json` (delegating to root tsc/vitest), fix README to `pnpm exec tsc --noEmit -p worker/tsconfig.json`.

### [LOW] Hand-rolled ambient Cloudflare types can drift from the real runtime (worker/src/types.ts, globals.d.ts)
- **Category:** Reliability
- **Evidence:** `R2Bucket.put(key, value: ReadableStream | ArrayBuffer)` — the real R2 `put` accepts more types and returns an `R2Object` (the local type says `Promise<void>`); `DurableObjectStorage` omits `list`, `delete(key)`, `getAlarm`. Code is written against the local subset, so nothing is currently broken, but `await env.HUSK_FILES.put(...)` returning a real object while typed `void` hides future misuse.
- **Why it matters:** The project avoids `@cloudflare/workers-types` deliberately (kept out of the frontend build); the tradeoff is silent drift.
- **Confidence:** Medium
- **Recommended fix:** Use `@cloudflare/workers-types` in the worker tsconfig only (it is not imported by frontend code, so no frontend bleed) or expand the ambient types to match reality.

### [LOW] CORS header fallback echoes first allowed origin for unknown origins (worker/src/index.ts:28)
- **Category:** Security (minor)
- **Evidence:** `const match = allowed.includes(origin) ? origin : (allowed[0] ?? "");`
- **Why it matters:** Non-matching origins get `Access-Control-Allow-Origin: http://localhost:8080` — not exploitable (browsers won't send credentials that matter here and origin mismatch blocks reads), but the intent would be clearer returning no ACAO header on mismatch.
- **Confidence:** High (code), Low (impact)
- **Recommended fix:** Omit ACAO entirely when the Origin is not allowed.

## Verified-Correct

- **Hibernation API is genuinely used** — `state.acceptWebSocket(server)` (room.ts:128) with `webSocketMessage`/`webSocketClose`/`webSocketError` class methods (room.ts:161-209); no naive `.accept()` + `addEventListener` pattern. Idle rooms with hibernating sockets do not keep the DO pinned.
- **Alarm is the only closure mechanism and purges state** — room.ts:215-239 closes sockets, resets `exists`/`seq`, and `storage.deleteAll()`. No client-driven cleanup path exists server-side. Fires regardless of client behavior. (Client-side verification of "no beforeunload cleanup" happens in Phase 3.)
- **Capacity check is atomic** — room.ts:116-120: participant count check and `acceptWebSocket` happen in the same synchronous handler of the single-threaded DO; no check-then-act window. The spec's simultaneous-join-at-capacity requirement is structurally satisfied.
- **PIN collision handling exists** — DO returns 409 `pin_taken` (room.ts:90-92); Worker propagates it (index.ts:87-90) with the documented contract that the caller regenerates. (Client-side retry loop verified in Phase 3.)
- **Rate limiter actually denies** — `checkJoinAllowed` returns `allowed:false` past 10 attempts, and index.ts:106-112 maps that to HTTP 429 with `retryAfter`. Exponential backoff (`60s * 2^(strikes-1)`, capped 1h) genuinely escalates; penalty-served resets the window, preventing permanent lockout. KV records carry a TTL so abandoned counters expire.
- **Frame parsing is defensive** — `parseClientFrame` coerces and validates every field; malformed frames get an explicit `error` frame, not an exception.
- **Message ordering is server-authoritative** — DO-assigned monotonic `seq` (room.ts:178-188) with per-message `ack`; no reliance on client timestamps.
- **Room constants centralized and spec-matching** — 10 participants, 24h max lifetime, 30min idle timeout, all in worker/src/config.ts; client mirrors grace/backoff values in src/lib/husk/config.ts.
- **Generic join errors** — index.ts:120-123 deliberately collapses missing/full into one 404, per spec Section 5 (no room-existence leak via `/room/join`; the leak via `/socket` is the separate HIGH finding above).

## Cloudflare facts re-verified (2026-08-27)

| Fact | Value | Source |
|---|---|---|
| DOs on Free plan | Available, SQLite-backed only, no commitment mentioned on limits page | developers.cloudflare.com/durable-objects/platform/limits/ |
| SQLite DO storage per account (Free) | 5 GB | same page |
| SQLite DO storage per object | 10 GB (Paid); Free-plan FAQ context: 1 GB | same page + FAQ |
| Max stored value (SQLite DO) | Key and value combined ≤ 2 MB; SQL row/BLOB ≤ 2 MB | same page |
| KV-backed DO per-value cap | 128 KiB (for contrast — rules out KV-backed storage as alternative) | same page |
| WebSocket message size | 32 MiB received (raised Oct 2025; matches audit brief) | same page |
| Workers Free CPU | 10 ms per invocation; I/O wait excluded; sustained excess = error 1102 | developers.cloudflare.com/workers/platform/limits/ |
| Workers Free requests | 100,000/day | same page |
| R2 activation | Requires payment method even for free tier (~$5 verification charge) | community.cloudflare.com + setup guides (2025) |

## Realistic capacity arithmetic (step 7 of the brief)

- Chunk size 1 MiB (client already uses it; leaves 1 MiB headroom under the 2 MB key+value cap even after base64-free binary storage and JSON overhead).
- Per-file rows: `ceil(size / 1 MiB)` → 25 MB file = 25 rows; 100 MB file = 100 rows.
- Free-plan per-DO (room) budget ≈ 1 GB → a single room can hold ~1,000 chunk rows ≈ 1 GB of files; the binding constraint is the account-wide 5 GB ≈ **50 concurrent 100 MB transfers** or **200 concurrent 25 MB transfers** across all rooms on the account.
- Recommendation: keep 1 MiB chunks, cap `MAX_FILE_BYTES` at 25 MB, and enforce per-room file-byte budget (e.g. 100 MB total live files per room) inside the DO so one room cannot consume the account pool.

## R2 Removal Plan (feeds Implementation Phase 1)

**Design choice: store file chunks in the room's own SQLite-backed DO storage.** Files then die with the room automatically via the existing `alarm()` → `deleteAll()` path — replacing both R2 *and* the lifecycle-rule orphan-cleanup mechanism with one purge the code already has. Ciphertext-only storage means retention until room close (≤24h) instead of R2's 1h unreferenced TTL is acceptable and simpler; document it.

1. **`worker/wrangler.toml`** — delete `[[r2_buckets]]`; replace migrations with (if never deployed) `tag = "v1", new_sqlite_classes = ["HuskRoom"]`; keep KV block but resolve the placeholder ID (or move rate limiting into a second SQLite DO `HuskGatekeeper` — optional simplification).
2. **`worker/src/types.ts`** — replace `R2Bucket`/`R2Object` with expanded `DurableObjectStorage` (`put(get)= Promise<T>`, `delete(key)`, `list(options)`, `sql` if needed). Drop `HUSK_FILES` from `Env`.
3. **`worker/src/index.ts`** — delete the `/object/*` proxy routes. Rewrite `/room/<pin>/upload-ticket` → `POST /room/<pin>/file` {size, chunks}: validates size against new cap, calls the room DO (which checks the caller has a live WebSocket via `getWebSockets()` — fixes the unauthenticated-ticket HIGH finding), and returns `{ fileId, chunkUrls }` where each chunk URL is `/room/<pin>/file/<fileId>/<n>?exp=&sig=` (HMAC per chunk+index, reusing tickets.ts with `operation:"chunk"`).
4. **`worker/src/room.ts`** — new DO fetch routes: `PUT /file/<id>/<n>` → verify ticket → `this.state.storage.put(\`file:<id>:<n>\`, await request.arrayBuffer())` (1 MiB ArrayBuffer per row; track `fileBytesUsed` counter, reject beyond per-room budget); `GET /file/<id>?exp=&sig=` → verify → stream rows `0..count-1` into a `ReadableStream` response. Purge: existing `alarm()` `deleteAll()` already covers everything; additionally delete a file's rows when the sender relays a "cancel" frame (interrupted-upload cleanup — coordinates with Phase 3's orphan finding).
5. **`src/lib/husk/files.ts`** — `requestUploadTicket` → `requestFileUpload(pin, size)`; `encryptAndUpload` streams: for each 1 MiB chunk, `sealBytes` → immediate `PUT` chunk URL (no `parts`/`blobParts` accumulation; fixes the memory HIGH finding); `downloadAndDecrypt` fetches `${WORKER_URL}/room/${pin}/file/<fileId>` and decrypts chunk-by-chunk as bytes arrive (use the response `ReadableStream` reader; fixes both the broken-path CRITICAL and the memory issue). Keep `ivs`/`lengths` delivery over the encrypted WS channel exactly as now.
6. **Config** — `MAX_FILE_BYTES` → 25 MB in both config.ts files; add `MAX_ROOM_FILE_BYTES = 100 MB`; add `FILE_ROW_PREFIX = "file:"`.
7. **File-size ceiling to document:** 25 MB/file, ~100 MB live files per room, ~5 GB account-wide ≈ 200 concurrent max-size files.
8. **Tests to add with the migration:** integration test through the real routes (PUT chunk N, GET whole file, byte-equality with test vector); ticket forged/expired/replayed rejection; room-full-of-files budget rejection; alarm purge removes rows (assert via `storage.list`).

## Phase Verdict

The relay core (DO message path, hibernation, alarm closure, capacity atomics, rate-limit logic) is in good shape and closely follows the spec — this is the strongest part of the codebase. But the project is **not deployable on its stated target**: the storage layer is KV+R2 (Free-plan-incompatible, R2 needs a card), the KV ID is a placeholder, and the file transfer feature is **broken end-to-end today** (client/Worker route mismatch plus unused signed URL). The R2 removal is mandatory rather than optional, and the plan above slots into existing DO structure with modest surface area — but it must be accompanied by the ticket-auth fixes and a real integration test, because "file sharing works" currently has zero proof. **Verdict: has blocking issues.**
