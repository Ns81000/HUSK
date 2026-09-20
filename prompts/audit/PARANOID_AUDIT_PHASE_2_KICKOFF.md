# HUSK — Paranoid Audit PHASE 2 Kickoff (Fix → Verify → Deploy)

> **Role**: You are the implementation agent continuing the HUSK paranoid audit. Phase 1 (analysis/testing) is COMPLETE. Your job: fix every finding, verify with the full test battery, and deploy.

## STEP 0 — Read First (mandatory, in order)
1. `prompts/findings/FINDINGS.md` — the complete Phase 1 findings report. Every fix below references its sections. Read the WHOLE file before touching code.
2. `worker/src/config.ts` and `src/lib/husk/config.ts` — the twin config files that MUST stay in sync.

## Constraints (violations = failure)
- **pnpm exclusively** — never npm/yarn/bun. `pnpm dlx` for one-off executables.
- Do NOT modify `src/components/husk/*` UI components; fixes 3/18/19 touch `src/routes/` only.
- Be token-efficient: read targeted ranges, batch tool calls, never paste whole files into chat.
- Do NOT stop until every fix is committed, tested, and deployed.
- If a fix introduces a new failing test, fix the fix before moving on.
- Unit tests: `pnpm test` in repo root AND in `worker/`. Live tests: `node live-tests/<script>.mjs` from repo root (Node ≥ 24).

## Fixes (in priority order)

### HIGH
1. **Duplicate-socket race** — `src/lib/husk/connection.ts:120-137`
   - WHAT: (a) In `open()`, before `this.socket = socket`, close any existing socket and mark it so its `close` listener does NOT trigger `scheduleReconnect` (per-socket `superseded` flag captured in the listener closure). (b) Add an `inFlightConnect` boolean set at the top of `connect()` and cleared in `open()`/on join failure; `resetBackoff()` skips when it is true.
   - WHY: two live sockets deliver every relay twice into the store; parallel reconnect flows double join requests.
   - VERIFY: unit test in `connection.test.ts`: fire `connect()`, resolve join in-flight, call `resetBackoff()`, assert only ONE socket was created.

2. **Rate-limit `/room/create`** — `worker/src/index.ts:86-104`
   - WHAT: before the DO fetch, call `checkJoinAllowed(env, ["create:" + ip])` (same gatekeeper, separate `create:` key namespace). Add `CREATE_MAX_ATTEMPTS = 5` per `JOIN_WINDOW_SECONDS` to `worker/src/config.ts`. Return 429 `{error:"rate_limited", retryAfter}` on denial.
   - WHY: `/room/create` currently mints unlimited Durable Objects — live-confirmed resource-exhaustion vector.
   - VERIFY: extend `worker/src/rate-limit.test.ts`; live: 6 rapid creates from one IP → 6th is 429.

3. **Reconnect button on `closed_disconnected`** — `src/routes/r.$roomId.tsx:180-190`
   - WHAT: pass `onRetry={() => void retry()}` to `ClosedScreen` when `state === "closed_disconnected"` (do fix 7 first). This also gives the currently-unused `retry` import a real use.
   - WHY: the closed copy promises "try reconnecting" but no button renders.

### MEDIUM
4. **Token-burn TOCTOU** — `worker/src/room.ts:229-235`
   - WHAT: wrap the burn check+write in `this.state.blockConcurrencyWhile(...)` so `storage.get(burnKey)` and `storage.put(...)` are atomic; return the same generic 404 when burned.
   - WHY: the get→put await gap lets two concurrent upgrades share one token.

5. **Cancel ownership** — `worker/src/room.ts` (`FileMeta`, `reserveFileStorage`, cancel branch)
   - WHAT: add `owner: string` to `FileMeta`, set from `member` in `reserveFileStorage`; in the `cancel` branch load meta and only delete when `meta.owner === attachment.id` (else ignore).
   - WHY: any member can currently delete anyone's files (in-flight or complete).
   - VERIFY: extend `worker/tests/integration.test.ts` — A uploads, B cancels A's fileId, rows must survive.

6. **Join budget lockout** — `worker/src/index.ts:106-125`
   - WHAT: remove the `room:${roomId}` key from the `checkJoinAllowed` call (keep only `ip:${ip}`).
   - WHY: live-confirmed total lockout of legit joiners sharing an IP or joining a busy room.
   - VERIFY: `rate-limit.test.ts` update; live: 12 joins across 3 rooms from one IP within 5 min → all succeed.

7. **Guard `retry()`/`connect()`** — `src/lib/husk/store.ts:369-422`
   - WHAT: in `retry()`, return early unless the current state is terminal (`isTerminal(...)`) or `reconnecting`.
   - WHY: a stray `retry()` wipes the transcript (`entries: []`) and respawns the connection.
   - VERIFY: unit test in `store.test.ts`: connect, reach `active`, call `retry()`, assert `entries` unchanged.

8. **Mark `sending` entries failed on terminal end** — `src/lib/husk/store.ts:170-181`
   - WHAT: in `handleEnded`, after `clearAllAckTimers()`, map `mine && delivery === "sending"` entries to `delivery: "failed"`.
   - WHY: bubbles spin forever after attempts_exhausted / join_refused.

9. **Fetch timeouts** — `src/lib/husk/api.ts`, `src/lib/husk/files.ts`
   - WHAT: add `AbortSignal.timeout(15_000)` (create/join/grant) and `AbortSignal.timeout(60_000)` (chunk PUTs, file GET) to every `fetch`; on abort, throw the existing typed errors (`UploadFailedError(grant.fileId)` so cancel cleanup still runs).
   - WHY: a hung connection stalls uploads/creates indefinitely and leaks reserved storage.

10. **Download memory claim** — `src/lib/husk/files.ts:195-244`
    - WHAT: minimal fix — correct the header comment to state the real memory bound (~one full decrypted file before `new Blob`), OR push each decrypted chunk wrapped as its own Blob element. Do not over-engineer.
    - WHY: the current comment claims "never buffering more than the chunk" — false for 25 MB files.

11. **Lint gates** — repo root
    - WHAT: (a) add `.agents/`, `tools/`, `live-tests/` to the eslint flat-config `ignores`; (b) `pnpm exec eslint . --fix` to clear CRLF prettier noise + add `.gitattributes` with `* text=auto eol=lf`; (c) `pnpm add -D oxlint-tsgolint` (or delete the `lint:anti-slop` script) so it exits 0.
    - WHY: both lint gates are currently red-broken — no signal.

12. **Cancel/upload orphan rows** — `worker/src/room.ts:399-413`
    - WHAT: after `await request.arrayBuffer()`, re-check `storage.get(FILE_META_PREFIX + fileId)`; if undefined, return 404 WITHOUT writing the row.
    - WHY: closes the unaccounted-row leak (Phase 1 race R4).

13. **Delete dead UI code** — `src/components/ui/*` (46 files), `src/hooks/use-mobile.tsx`
    - WHAT: `git rm -r src/components/ui src/hooks/use-mobile.tsx` after re-verifying zero imports (sweep method in FINDINGS §10).
    - WHY: 100% unused; inflates lint and repo noise (already tree-shaken out of the bundle).

### LOW
14. `recentSends` eviction — `worker/src/room.ts:536-544`: raise limit to 1000 or evict by age.
15. Dead protocol surface — `src/lib/husk/protocol.ts:50-51`: remove `"host_closed"` + unused error codes OR wire the server to send them; make `store.ts:299` map `idle` to honest UI copy (not "closed by host").
16. Join token in query param — document rationale or move to handshake header (low priority).
17. `seenRelays` — `src/lib/husk/store.ts:82`: cap at 1000 (Map-based oldest-delete).
18. `URL.revokeObjectURL` — `r.$roomId.tsx:159-164`: revoke via `setTimeout(..., 10_000)`.
19. `hadPeerRef` — `r.$roomId.tsx:191-195`: move ref write into a `useEffect`.
20. Stale test — rewrite `live-tests/probe-g-live.mjs` PIN expectations to the current room-link flow.
21. `inGraceWindow` — delete the export or actually use it in `room-info.tsx`.
22. `vite-tsconfig-paths` — remove plugin, set `resolve.tsconfigPaths: true` (build warning).

## Verification Battery (after ALL fixes)
1. `pnpm exec tsc --noEmit` (root) — exit 0.
2. `cd worker && pnpm exec tsc --noEmit` — exit 0.
3. `pnpm test` (root) AND `cd worker && pnpm test` — all green.
4. `pnpm run lint` — exit 0 after fix 11.
5. `pnpm run build` — success; note bundle sizes.
6. Live probes (repo root): `probe-a-core`, `probe-capacity`, `probe-d-files`, `probe-e-security`, `probe-eviction`, `probe-g-static`, `probe-reconnect`. Re-run any failure twice before judging it real. NOTE: joins are rate-limited (10/5 min per IP) — space scripts accordingly.
7. Drive tests: at least `drive-a.mjs`, `drive-b.mjs`, `drive-reconnect.mjs`.
8. Custom stress (in `live-tests/`, created in Phase 1): `stress-lifecycle.mjs`, `stress-files.mjs`, `stress-msg.mjs`, `stress-security.mjs`, `stress-conn.mjs`. Finish `stress-conn`'s message-survival-across-reconnect sub-scenario (never completed in Phase 1 due to rate budget).

## Deploy (only after the battery passes)
```bash
cd C:\Users\Ns8pc\Pictures\HUSK
git add -A
git commit -m "fix: paranoid audit — rate-limit create, connection races, cancel ownership, lint gates"
git push

cd worker
pnpm run deploy
cd ..

pnpm run build
worker\node_modules\.bin\wrangler.cmd deploy --compatibility-date 2025-01-01
```

## Post-deploy
- Re-run: `probe-a-core`, `probe-d-files`, `probe-e-security`, `stress-security.mjs` (must now show create rate limiting: 6th create → 429), `stress-files.mjs`.
- Confirm the deployed frontend shows the Reconnect button on a disconnected room (`drive-reconnect.mjs` or manual).
- Append a "Phase 2 outcome" section to `prompts/findings/FINDINGS.md` listing each fix # with PASS/FAIL evidence.

