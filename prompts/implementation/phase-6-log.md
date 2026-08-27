# Phase 6 Log — Performance Verification, Test-Coverage Gaps & Final Hardening

## What changed

### 1. Streaming-GET CPU bound proven (audit HIGH)

- `worker/tests/integration.test.ts` — the 11 MiB / 12-chunk file round-trip now
  reads the GET response through its **pull-based stream reader** (`body.getReader()`)
  instead of `arrayBuffer()`, and asserts byte equality **chunk-wise**: each 1 MiB
  row of the downloaded stream is compared against the corresponding uploaded
  slice (`expectStreamedChunkwiseEqual`, new helper). The full round-trip
  completing — 12 chunk PUTs, then a streamed GET reassembled reader-pull by
  reader-pull with zero mismatches — is the 1102 ("Worker exceeded CPU time")
  assertion: the server never buffers the file, so per-request work stays
  bounded to one row per pull. The superseded whole-buffer helper
  (`expectBytesEqual`) was removed.
- **CPU-limit enforcement experiment (honest negative result, amended after
  the live deploy):** `[limits] cpu_ms = 10` was added to `worker/wrangler.toml`
  as deployment-target documentation. An empirical check showed the local
  harness does **not** meter CPU: with `cpu_ms = 1` the entire suite passes
  identically, i.e. `vitest-pool-workers` does not wire wrangler's `[limits]`
  into workerd's CPU limiter. **Amendment (live deploy, 2026-08-28):** the
  Free-plan API rejects declaring CPU limits at all (error 100328: "CPU limits
  are not supported for the Free plan"), so the block was removed before the
  successful deploy. The suite's CPU evidence is the completing streamed
  round-trip itself; the Free plan applies its 10 ms default server-side
  without any declaration.

### 2. Missing unit tests added (audit MEDIUM)

- `src/lib/husk/store.test.ts` — new `describe("message ordering")`, 4 tests:
  - `orderedEntries` sorts out-of-order input by seq;
  - seq ties are broken by `ts` (stable secondary sort);
  - system messages (`seq: Number.MAX_SAFE_INTEGER`, `system` text) always sort
    after real messages regardless of their wall-clock `ts`;
  - **store-level:** a connected store fed relays out of order (seq 3 → 1 → 2,
    each fully processed before the next) accumulates them in arrival order,
    and `orderedEntries(entries)` — the exact call `chat.tsx`'s render path
    uses — restores server seq order (`m1, m2, m3`). The test uses the
    `createRoomStore(spawnConnection)` injection seam, so it runs without jsdom.
- **Pre-existing latent flake found and hardened:** during full-suite runs the
  Phase 3 test "a duplicate relay with the same localId is inserted once"
  failed once in ~8 runs (`entries.length` 0). Root cause: `flushDecrypt()`
  yielded a fixed 10 event-loop turns, but WebCrypto resolves on the host's
  thread pool rather than the fake-timer queue, so under load the decrypt can
  land later. The helper now yields 100 bounded turns (semantics unchanged for
  every caller; assertions unchanged). 8 consecutive full-suite runs after the
  fix: 104/104 every time. The failing test itself is pre-existing and
  unchanged; only its wait helper was made robust.

### 3. Section 8 coverage matrix close-out

Walked every row of the audit's matrix against the current suites. Final state:

| Required test                                       | Status                                  | Evidence                                                                                                                                                                                                                                                                                                    |
| --------------------------------------------------- | --------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Unit: encryption/decryption round-trip              | Present-and-Adequate                    | `crypto.test.ts` (7: round-trip, wrong-key, tamper, fresh-IV, base64url)                                                                                                                                                                                                                                    |
| Unit: PIN entropy/format                            | Present-and-Adequate                    | `pin.test.ts` (5: rejection-sampling boundary, 500-sample validity, spread)                                                                                                                                                                                                                                 |
| Unit: message sequence-number ordering              | **Present (Phase 6)**                   | was Missing; 4 new tests above                                                                                                                                                                                                                                                                              |
| Unit: room state machine transitions                | Present-and-Adequate                    | `room-machine.test.ts` (9, incl. terminal-immutability matrix)                                                                                                                                                                                                                                              |
| Unit: rate-limit logic                              | Present-and-Adequate                    | `rate-limit.test.ts` (5, pure `evaluate()`)                                                                                                                                                                                                                                                                 |
| Integration: create→join→message→file vs DO harness | **Present (Phases 1–3, extended in 6)** | `worker/tests/integration.test.ts`, 19 tests through real routes in workerd; file round-trip now streamed chunk-wise (11 MiB / 12 chunks)                                                                                                                                                                   |
| Edge: simultaneous join at capacity                 | Present                                 | Phase 1: atomic DO capacity rejection, 403, with valid minted token                                                                                                                                                                                                                                         |
| Edge: host crash → idle-timeout closure             | Present                                 | alarm-purge test drives `emptySince` into the past and runs the real alarm; plus leave-broadcast-on-close test. (A true host crash cannot be simulated in workerd; idle-alarm closure is the spec mechanism)                                                                                                |
| Edge: reconnect after network drop                  | Present                                 | client: `connection.test.ts` (9: refused joins terminal, handshake-failure budget, attempts exhausted), `backoff.test.ts` (3), store `retry()` / `closed_disconnected` + online-recovery tests; server: per-reconnect token mint pinned by replay/429 tests. Not covered: a real mid-stream socket-drop E2E |
| Edge: duplicate-tab same-identity                   | Present                                 | Phase 3 integration test (distinct participants, both tabs relayed)                                                                                                                                                                                                                                         |
| Edge: interrupted file upload                       | Present                                 | Phase 3 integration test (cancel deletes rows + refunds budget) and the upload-failure/retry UI                                                                                                                                                                                                             |
| Edge: PIN collision on creation                     | Present                                 | Phase 3 integration test (409); client retry logic unchanged                                                                                                                                                                                                                                                |
| Security: captured frame has no plaintext           | Present                                 | Phase 2 integration test (only the six allowed ciphertext fields)                                                                                                                                                                                                                                           |
| Security: object fetch without signed URL fails     | Present                                 | Phase 1 tests: unsigned file GET 403, forged/expired chunk tickets 403                                                                                                                                                                                                                                      |
| Security: brute-force join throttled                | Present                                 | Phase 2 integration test (HTTP 429 + `retryAfter`) on top of the pure-logic tests                                                                                                                                                                                                                           |
| Security: XSS payload in message body / filename    | Present                                 | body: `linkify.test.ts` (4); filename: `chat.render.test.tsx` (4 payloads, Phase 2)                                                                                                                                                                                                                         |
| Accessibility: axe every screen both themes         | Present (bounded)                       | `e2e/a11y.spec.ts`: landing / PIN-entry / room-no-key, light + dark, zero violations (`wcag2a/2aa/21a/21aa`) + open-modal room state in `e2e/modal.spec.ts`. Residual below                                                                                                                                 |
| Accessibility: keyboard-only navigation             | Partial                                 | Modal E2E: Tab trap, wrap at both ends, Escape/scrim close with focus restoration (6 specs, both themes). Full keyboard-only walkthrough of every flow remains manual — residual below                                                                                                                      |
| Accessibility: WCAG AA contrast both themes         | Present                                 | `contrast.test.ts` (5, Phase 5 CI gate parsing `styles.css` itself)                                                                                                                                                                                                                                         |
| Manual QA pass                                      | **Not executable here — residual**      | no Cloudflare credentials in this environment; the exact checklist with a results table is prepared in `SUMMARY.md` for the deployer                                                                                                                                                                        |
| _(new)_ Streaming GET keeps CPU bounded             | Present                                 | Phase 6 streamed chunk-wise round-trip above; no 1102-class failure                                                                                                                                                                                                                                         |

No matrix row is left Missing without an entry in "Residual risk" below.

### 4. Live Lighthouse (audit LOW — measured, not estimated)

Method: production `pnpm build` output (`.output/server`) served under
wrangler/workerd exactly like the a11y harness (`--compatibility-date
2026-08-01`, port 8799; `/` returned 200), then **Lighthouse 13.4.1** via
`pnpm dlx lighthouse` driving Playwright's chromium (`CHROME_PATH=...ms-playwright\chromium-1234\chrome-win64\chrome.exe`,
`--chrome-flags="--headless=new --no-sandbox"`). Mobile = Lighthouse default
emulation; desktop = `--preset=desktop`. The server was killed and all
JSON/log artifacts removed afterwards.

| Page        | Profile | Perf    | A11y | Best-Practices | SEO | FCP   | LCP   | TBT  | CLS   |
| ----------- | ------- | ------- | ---- | -------------- | --- | ----- | ----- | ---- | ----- |
| `/`         | mobile  | **97**  | 100  | 100            | 100 | 2.1 s | 2.1 s | 0 ms | 0.01  |
| `/`         | desktop | **100** | 100  | 100            | 100 | 0.5 s | 0.5 s | 0 ms | 0     |
| `/r/123456` | mobile  | **96**  | 100  | —              | —   | 2.1 s | 2.3 s | 0 ms | 0.001 |
| `/r/123456` | desktop | **100** | 100  | —              | —   | 0.5 s | 0.5 s | 0 ms | 0     |

Inter self-hosting effect, measured (not estimated): the mobile landing run
issues **zero non-local network requests** — the only font request is
`/fonts/inter-latin.woff2` (200, same origin, `font-display: swap`), and there
are **zero** `fonts.googleapis.com` / `fonts.gstatic.com` requests. With the
Phase 4 fix in place the app scores 97–100 in every measured category, with
TBT 0 ms and CLS ≈ 0 in both profiles; the audit's pre-fix estimate ("80s on
mobile") is moot.

## Commands and results

| Command                                          | Result                                                                                                                   |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------ |
| `pnpm test`                                      | **14 files, 104/104 pass** (was 100; +4 ordering tests); 8/8 consecutive full-suite runs green after the flake hardening |
| `cd worker && pnpm test`                         | **19/19 pass** (streamed chunk-wise file round-trip included)                                                            |
| `pnpm exec tsc --noEmit -p tsconfig.json`        | pass                                                                                                                     |
| `pnpm exec tsc --noEmit -p worker/tsconfig.json` | pass                                                                                                                     |
| `cd worker && pnpm typecheck`                    | pass                                                                                                                     |
| `pnpm build`                                     | pass; production `.output` verified free of any a11y-mode worker URL                                                     |
| `pnpm test:a11y`                                 | **12/12 pass** (6 axe + 6 modal E2E), production build served under wrangler/workerd                                     |
| `pnpm dlx lighthouse` (13.4.1), 4 runs           | table above; all server processes killed, artifacts removed                                                              |

## Residual risk

- **Manual QA pass** remains unexecuted: this environment has no Cloudflare
  credentials and no second device. `SUMMARY.md` carries the exact deployment
  commands plus the spec Section 8 manual QA checklist with a blank results
  table for the deployer. This is the only matrix row without green evidence,
  explicitly recorded as such.
- **Keyboard-only navigation** is covered where automation reaches it (modal
  trap/wrap/Escape/scrim/focus-restore E2E; the keypad is focusable labeled
  buttons). A full keyboard-only walkthrough of every flow, including file
  attach/download, is folded into the manual QA checklist above.
- **Axe coverage stays bounded** to the swept screens: landing, PIN-entry,
  room-no-key, and the open-modal room state, both themes. Message-list-with-
  content, toasts, and remaining closed states are not swept (their building
  blocks are the same swept components). The summary claims exactly this scope.
- Local workerd does not meter CPU (`cpu_ms = 1` experiment), so the CPU-bound
  proof rests on the completing streamed round-trip plus the streaming design,
  not a locally enforced limit; the Free plan applies its 10 ms default
  server-side (declaring `[limits] cpu_ms` is rejected on Free — error 100328).
- Reconnect-after-network-drop lacks a real mid-stream socket-drop E2E; the
  client lifecycle (termination, budgets, terminal states, recovery) is pinned
  at unit/store level and the server side by token/throttle tests.
- Lighthouse ran against local workerd over HTTP on `127.0.0.1`; a deployed
  origin (TLS + CDN) can shift absolute times, not the category picture.
- Carried unchanged from earlier phases: alarm polling every 60 s in
  `worker/src/room.ts`; the outbox cap silently drops its oldest frame (no
  plaintext system note possible — unsent plaintext is not retained); the
  `ssr.nonce` CSP migration as future work (the NUL→`\u0000` escape remains the
  shipped mitigation); static light `theme-color` meta; repo-wide lint baseline
  red (pre-existing; touched files are clean); no live deployment.
