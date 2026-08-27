# Phase 6 — Performance, Test-Coverage Gaps & Final Synthesis

## Summary

Mapped every spec Section 8 requirement to actual test files and assertions (read all 7 test files across both packages). Measured real build output in Phase 4 (`pnpm build`: client entry 307 KB / ~95 KB gzip, route-split, 495 KB total public assets). Analyzed Worker CPU budget against the Free plan's 10ms limit by tracing the relay and file paths. A live Lighthouse run is not feasible in this environment (no deployed origin, no headless Chrome wired up here) — the Lighthouse-style assessment below is static analysis of build output and code paths, stated as such. Then synthesized all phase findings into `docs/audit/IMPLEMENTATION_PROMPT.md`.

## Findings

### [HIGH] Spec Section 8 integration and edge-case tests do not exist at all
- **Category:** Test Gap
- **Evidence:** The entire suite is 7 unit-test files / 37 tests (all passing, no `.only`/`skip`). There is no Miniflare/`wrangler dev` harness, no test spins up the Worker or a DO, no test opens a WebSocket, no test exercises the create→join→message→file flow. The spec's "Integration tests: full room-create → join → message exchange → file exchange flow against a local Durable Object test harness" and all six explicitly-listed edge-case rows (one test per Section 6 row) are absent.
- **Why it matters:** This is exactly how a broken file-download route (Phase 1's CRITICAL — client fetches a path the Worker doesn't serve) shipped unnoticed: nothing ever ran the two ends against each other. The spec anticipated this and demanded the harness explicitly.
- **Confidence:** High
- **Recommended fix:** Add `@cloudflare/vitest-pool-workers` (Miniflare-based vitest integration for Workers) in the workspace covering: create→join→WS connect→relay→ack; file chunk PUT→GET round-trip; capacity rejection; ticket forgery/expiry/replay; alarm closure. One test per Section 6 edge-case row, explicitly named after it.

### [HIGH] Security tests are one-quarter implemented (Section 8 "Security tests" row)
- **Category:** Test Gap
- **Evidence:** Present-and-adequate: XSS message-body tokenization (`linkify.test.ts` — `javascript:`, `data:` URIs, `<img onerror>` payloads all asserted inert). Present-but-weak: brute-force throttling (`rate-limit.test.ts` covers the pure `evaluate()` function; the HTTP 429 wiring, KV round-trip, and per-IP/per-PIN keying are untested). Missing: captured-frame plaintext read test; unauthorized-object-fetch test; XSS-in-filename test.
- **Why it matters:** The spec's security-test row exists because of the previous project's claims-vs-reality gap. Green unit tests on pure functions here create false confidence about the HTTP surface (see Phase 2 verdict).
- **Confidence:** High
- **Recommended fix:** Fold the four security tests into the Miniflare harness above (assert WS frames contain only base64 payload fields; assert `/object/*`-equivalent routes 403 without valid sig; assert 429 after 10 joins; assert a `<script>` filename renders as text — the last is a client render test, jsdom-able).

### [MEDIUM] Sequence-ordering logic is untested (spec Section 8 unit-test row)
- **Category:** Test Gap
- **Evidence:** No test imports `orderedEntries` (store.ts:280-282) or asserts seq-based insertion; the ordering guarantee (Section 4.3: sequence number is the source of truth) has zero coverage.
- **Why it matters:** It's one of the five named unit-test categories and the mechanism guarding against clock-skew misordering; a regression here is invisible until real clock-skew produces visibly wrong order.
- **Confidence:** High
- **Recommended fix:** Unit-test `orderedEntries` (out-of-order input, seq ties, system messages with MAX_SAFE_INTEGER seq) plus a store-level test that out-of-order `relay` frames render in seq order.

### [LOW] Worker CPU budget: relay path is comfortably inside 10ms; file path needs one care point
- **Category:** Performance
- **Evidence:** Relay path per message: `parseClientFrame` (JSON.parse of a small frame), `JSON.stringify` of the relay, one `broadcast` loop with `socket.send` per hibernated socket, one ack. All O(participants), no base64, no crypto. Small frames (<a few KB) — well under 10ms. File path today: `env.HUSK_FILES.put(objectKey, request.body)` streams (I/O wait doesn't count as CPU); the DO-storage migration's `await request.arrayBuffer()` materializes ≤1 MiB chunks (cheap memcpy, fine); the one care point is *GET reassembly*: streaming rows back through a `ReadableStream` pull function keeps CPU per invocation bounded, while buffering a whole 25 MB file into memory before responding would push both memory (128MB) and CPU (JS copying) on a 10ms budget.
- **Why it matters:** Only the GET path could realistically breach the Free-plan CPU cap under the migration.
- **Confidence:** Medium (no live measurement — static analysis of code paths)
- **Recommended fix:** In the Phase 1 migration, stream chunk rows into the response (`new Response(readable)` with a pull-based reader), never `arrayBuffer()` the whole file server-side; add a 10-chunk integration test that would surface CPU overrun as error 1102 locally.

### [LOW] Client main-thread decrypt of large files blocks UI (src/lib/husk/files.ts:140-150, r.$pin.tsx:115-139)
- **Category:** Performance / UX
- **Evidence:** `downloadAndDecrypt` awaits `openBytes` per chunk inside the render loop of the download flow; a 25 MB file = 25 sequential AES-GCM decrypts (~1 MiB each) on the main thread. Each individual decrypt is a few ms of WebCrypto (async, off-main-thread in most engines), but the 100MB-era `response.arrayBuffer()` at files.ts:135 materializes the entire ciphertext on the main thread at once.
- **Why it matters:** The current code buffers whole-file ciphertext (memory spike + jank on mid-range Android). The Phase 1 migration's streaming rewrite (decrypt per received chunk, yield to the event loop between chunks) resolves this without a Web Worker; only add a Worker if profiling after the migration still shows jank (spec: "Simple" over clever).
- **Confidence:** High (mechanism), Medium (magnitude)
- **Recommended fix:** Fold into the Phase 1 `files.ts` rewrite: read the response `ReadableStream` chunk-wise, decrypt incrementally, never materialize more than 2 chunks.

### [LOW] Lighthouse-style static assessment (stated method: build-output analysis, no live run)
- **Category:** Performance
- **Evidence (measured):** client entry 307 KB raw / **~95 KB gzip**; route chunks 7–12 KB gzip; CSS 12 KB; zero unused component-library code in the bundle (243 modules; unused shadcn scaffold not imported); SSR server bundle large (665 KB router chunk) but server-side only. Font loading is render-blocking remote CSS (Phase 4 finding) — the single biggest Core-Web-Vitals liability; self-hosting Inter fixes it. No code currently blocks the main thread on load beyond hydration. Estimated Lighthouse performance on a real deploy: 90+ on desktop, 80s on mobile until the font fix lands — **estimate, not measurement**.
- **Why it matters:** Sets the baseline so post-fix builds can be compared.
- **Confidence:** Medium (static), and explicitly not a Lighthouse run.
- **Recommended fix:** Run live Lighthouse against `wrangler dev` during implementation; add `@lighthouse-ci` only if the team wants a budget gate.

## Spec Section 8 — full coverage matrix

| Required test | Status | Evidence |
|---|---|---|
| Unit: encryption/decryption round-trip | **Present-and-Adequate** | crypto.test.ts: 7 tests incl. wrong-key, tamper, fresh-IV, base64url |
| Unit: PIN entropy/format | **Present-and-Adequate** | pin.test.ts: 5 tests incl. rejection-sampling boundary, 500-sample validity, spread |
| Unit: message sequence-number ordering | **Missing** | no test touches `orderedEntries` or seq handling |
| Unit: room state machine transitions | **Present-and-Adequate** | room-machine.test.ts: 8 tests, incl. terminal-immutability matrix |
| Unit: rate-limit logic | **Present-and-Adequate** (pure logic) | rate-limit.test.ts: 5 tests, real assertions |
| Integration: full create→join→message→file vs DO harness | **Missing** | no harness exists; this gap is how the broken download route shipped |
| Edge: simultaneous join at capacity | **Missing** (logic verified structurally in code) | — |
| Edge: host crash → idle-timeout closure | **Missing** | — |
| Edge: reconnect after network drop | **Missing** (backoff unit-tested only) | backoff.test.ts: 3 tests |
| Edge: duplicate-tab same-identity | **Missing** | — |
| Edge: interrupted file upload | **Missing** (and feature itself broken — Phase 1) | — |
| Edge: PIN collision on creation | **Missing** (409 path logic read-verified) | — |
| Security: captured frame has no plaintext | **Missing** | — |
| Security: object fetch without signed URL fails | **Missing** | tickets.test.ts tests the HMAC function only |
| Security: brute-force join throttled | **Present-but-Weak** | pure-function tests only |
| Security: XSS payload in message body / filename | **Present** (body) / **Missing** (filename) | linkify.test.ts: 4 tests |
| Accessibility: axe every screen both themes | **Missing** | no axe dep (Phase 5) |
| Accessibility: keyboard-only navigation | **Not-tested** (manually traced: reachable, modal trap missing) | Phase 5 |
| Accessibility: WCAG AA contrast both themes | **Failing in 4 pairs** (computed), untested in CI | Phase 5 |
| Manual QA pass | **No record** | no QA doc/script in repo |

**Suite totals:** 7 files, 37 tests, all passing in ~0.5s. Zero skipped/`.only`. Assertion quality is good everywhere tests exist — the problem is coverage breadth, not depth.

## Phase Verdict

Performance is not the risk: the bundle is lean, the relay's CPU profile fits the Free plan comfortably, and the two real perf care-points (server-side whole-file buffering, client whole-ciphertext buffering) are both resolved by the Phase 1 migration's streaming design. The risk is that almost nothing is *proven*: the spec's Section 8 asked for an integration harness, six named edge-case tests, four security tests, and an a11y audit, and the shipped suite answers with excellent unit tests for crypto/PIN/state-machine/rate-limit and nothing else. The Phase 1 CRITICAL download-route mismatch is the direct, already-paid cost of that gap. **Verdict: has blocking issues** in the test-coverage dimension specifically — the implementation prompt must make the Miniflare harness a first-class phase, not an afterthought, because every other phase's "verify" step depends on it.
