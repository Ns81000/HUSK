# Phase 1 Log — R2 Removal / SQLite Durable Object Storage Migration

## What changed

### Worker

- `worker/wrangler.toml` — removed `[[r2_buckets]]`; migration is now a single
  `v1` / `new_sqlite_classes = ["HuskRoom", "HuskGatekeeper"]` (never deployed,
  so no v2 tag needed); removed the KV namespace block and the placeholder ID
  entirely. **User decision:** rate-limit counters moved into a second SQLite
  Durable Object (user delegated the choice; recommended option taken).
- `worker/src/gate.ts` (new) — `HuskGatekeeper` DO: single instance (`idFromName("gate")`)
  holding join rate-limit records in SQLite storage (`rl:<key>` rows), with an
  hourly alarm sweeping records whose window and penalty have elapsed.
- `worker/src/rate-limit.ts` — pure `evaluate()` logic unchanged (unit tests
  untouched and passing); KV-dependent `checkJoinAllowed` replaced with a
  gatekeeper-DO-backed version that **fails closed** (unreachable gate =>
  deny 30s).
- `worker/src/room.ts` — new DO routes:
  - `POST /room/<pin>/file` `{size, member}` — reserves storage; verifies
    `member` is a **currently connected participant** (`getWebSockets()` +
    attachment id), closing the unauthenticated-ticket finding; enforces the
    per-room 100 MB budget; returns fileId + per-chunk HMAC signatures.
    Reservation and cancel are serialised through a per-DO promise queue so
    the budget read-check-write is atomic under concurrency.
  - `PUT /room/<pin>/file/<fileId>/<n>?exp=&sig=` — verifies `chunk` ticket,
    rejects `index >= meta.chunks`, **write-once rows** (`chunk_exists` 409 on
    replay), 1 byte–1 MiB body, stored as `file:<id>:<n>` ArrayBuffers.
  - `GET /room/<pin>/file/<fileId>?exp=&sig=` — verifies `get` ticket, streams
    rows through a **pull-based ReadableStream** (one 1 MiB row per pull; the
    file is never buffered server-side — Free-plan 10 ms CPU).
  - `cancel` client frame deletes a file's meta + rows and refunds the budget
    (interrupted-upload cleanup); `alarm()` → `deleteAll()` purges everything
    on room closure (now also the file purge — no lifecycle rule needed).
- `worker/src/index.ts` — `/object/*` proxy and `/room/<pin>/upload-ticket`
  deleted; new routes `POST /room/<pin>/file` (returns chunkUrls + download
  capability) and pass-through PUT/GET to the room DO with CORS. CORS now
  omits ACAO entirely for disallowed origins (audit LOW). All route regexes
  share the canonical PIN shape `[1-9][0-9]{5}` (create/join/socket/file).
- `worker/src/types.ts` — `R2Bucket`/`R2Object`/`KVNamespace` removed;
  `DurableObjectStorage` expanded (`delete`, `list`, `getAlarm`);
  `Env.HUSK_FILES`/`HUSK_RATE_LIMIT` replaced by `HUSK_GATE`.
- `worker/src/config.ts` — `MAX_FILE_BYTES` 100→25 MB, `MAX_ROOM_FILE_BYTES`
  = 100 MB, `FILE_CHUNK_BYTES` = 1 MiB, row prefixes, single `PIN_PATTERN`.
- `worker/src/tickets.ts` — operations now `"put" | "get" | "chunk"`.
- `worker/package.json` — added `typecheck`/`test` scripts and devDeps
  (`@cloudflare/vitest-pool-workers@^0.22.0`, `typescript`, pinned `vitest@4.1.11`).
- `worker/r2-lifecycle.json` — deleted.

### Test harness (new)

- `worker/vitest.config.ts` — `@cloudflare/vitest-pool-workers` (v0.22 plugin
  API: `cloudflareTest({...})`) with `main: src/index.ts`, real
  `wrangler.toml`, `HUSK_TICKET_SECRET` test binding.
- `worker/tests/test-types.d.ts` — minimal globals so `cloudflare:test` types
  resolve without vendoring `@cloudflare/workers-types` into the worker build.
- `worker/tests/integration.test.ts` — 10 tests through the real routes in
  workerd: relay+ack between two peers; **simultaneous-join-at-capacity**
  (Section 6 edge); 11 MiB 12-chunk upload → GET byte-equality; forged ticket
  403; expired ticket 403; chunk replay 409; grant without live membership
  403; per-room budget 507; unsigned file GET 403; **alarm purge removes
  rows and closes the room** (drives the real alarm via `runInDurableObject`
  + `runDurableObjectAlarm`, then asserts 404 join and 404 file GET).
  Tests use unique per-call `CF-Connecting-IP` so the shared rate-limit
  budget cannot flake between tests.
- Root `vitest.config.ts` — projects: `node` (existing unit tests) +
  `worker/vitest.config.ts`; single `pnpm test` runs both (47 tests).

### Frontend

- `src/lib/husk/config.ts` — `MAX_FILE_BYTES` 25 MB; removed
  `FILE_CHUNK_THRESHOLD_BYTES`; added `MAX_ROOM_FILE_BYTES`.
- `src/lib/husk/files.ts` — rewritten to stream:
  - `requestFileUpload(pin, member, size)` → grant (`fileId`, chunkUrls,
    download capability).
  - `encryptAndUpload` seals each 1 MiB slice and PUTs it immediately — no
    `parts`/`blobParts` accumulation (memory HIGH fix); 409 on retried chunk
    treated as success.
  - `downloadAndDecrypt` reads the response `ReadableStream` chunk-wise and
    decrypts incrementally via a `ByteQueue` span reassembler — never
    materialises more than ~1 chunk of ciphertext (fixes the broken
    `/room/<pin>/object/...` CRITICAL and the memory finding).
  - `UploadFailedError` carries the `fileId` so failures can cancel storage.
- `src/lib/husk/protocol.ts` — `SealedBody` file kind: `objectKey` →
  `fileId` + `exp`/`sig` (download capability rides inside the encrypted
  body only); added `cancel` client frame.
- `src/lib/husk/connection.ts` — `sendControl()` for the cancel frame
  (fire-and-forget on the live socket).
- `src/lib/husk/store.ts` — `cancelFile(fileId)` store action.
- `src/routes/r.$pin.tsx` — `onSendFile` now passes `selfId` as membership
  proof, sends the new body shape, and cancels the fileId on `UploadFailedError`
  before rethrowing.
- `src/components/husk/chat.tsx` — upload failure UI: failed banner with the
  file name, "Upload failed · not sent", **Retry** button, and discard button
  (spec Section 6 interrupted-upload requirement).

### Docs

- `README.md` — R2/KV setup steps removed (only `HUSK_TICKET_SECRET` remains),
  `pnpm` everywhere, verification commands fixed (`pnpm exec tsc --noEmit …`,
  `cd worker && pnpm test`), new "Capacity limits" section documenting the
  honest ceiling: 25 MB/file, 100 MB/room, ~5 GB account-wide ≈ 200
  concurrent max-size files.

## Test status

- `pnpm exec tsc --noEmit -p worker/tsconfig.json` — pass
- `pnpm exec tsc --noEmit -p tsconfig.json` — pass
- `pnpm test` — **47/47 pass** (37 pre-existing unit tests + 10 new
  integration tests; pre-existing unit tests untouched except none required
  changes)
- `pnpm build` — pass
- `pnpm lint` — repo-wide lint was already failing before any change (3967
  problems: the repo has never been prettier-formatted). All files touched in
  this phase were prettier-formatted and lint clean individually. Not "fixed"
  repo-wide: out of scope, untouched files would create huge diff noise.

## Edge cases re-tested after the change (spec Section 6 areas touched)

- Simultaneous join at capacity — dedicated integration test, still 403.
- Interrupted file upload — client cancel frame deletes rows; failure UI with
  retry added; alarm purge covers abandoned uploads.
- PIN collision on create — 409 path unchanged; client retry unchanged.
- Leading-zero PINs — now rejected uniformly at every route (shared shape).
- Concurrent storage reservation — serialised via the DO file-op queue.
- CORS preflight for cross-origin chunk PUT/GET — OPTIONS handled; ACAO only
  for allowed origins.

## Residual risk

- A `cancel` frame sent while the socket is down is dropped; that file's rows
  persist (within the 100 MB room budget) until the room's alarm purge. Same
  practical lifetime as R2's 1 h lifecycle rule, bounded by room closure.
- The `get` ticket for a file lives until room expiry (not 5 min) because it
  must remain downloadable for the room's lifetime; it is only ever
  transmitted inside the encrypted message body, so exposure requires the
  room key. Replay of a GET is read-only ciphertext with room-scoped lifetime —
  documented, deliberate.
- `wrangler dev`/deploy not executed here (no Cloudflare credentials in this
  environment); the config follows the verified Free-plan constraints.
- Lint repo-wide remains red (pre-existing; untouched files).
