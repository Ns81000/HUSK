# HUSK Sound Chat — running log

Append-only. Newest entry at the bottom. Never rewrite an earlier entry; if an
earlier entry is wrong, say so in a new entry. Every session re-runs the
verification battery itself and records the numbers it personally observed —
never a number copied from an earlier entry or from a prompt.

Rules for every session (mirrored in the master plan, Section 5):

- **Verify first, assume never.** Everything stated here was executed or
  measured in the session that wrote it; a later session re-verifies a claim
  before building on it.
- **Pending work first.** A session that inherits unfinished work from a
  previous session completes that work before starting its own phase, and
  records here what was pending and what was done.
- **Kickoff prompts are delivered in the chat only** and are never written into
  this log; the log records work and evidence, not handoff prompts.

---

## Phase 0 — Integration Spike

This entry records the whole of Phase 0. The phase ran past one context window
and was continued with no change of scope, so it is logged as one session; the
log did not exist until the end of the phase, and this entry was written at the
end, against the final state. The repo state at the start of the continuation
was verified by re-measurement, not trusted: `git status --short` showed exactly
` M src/server.ts` plus untracked `audit/`, `prompts/sound-chat/`,
`src/lib/sound-chat/`, and the in-process spike suites re-ran green before
anything was changed (see the verification battery at the end of this entry).

### Headline: the vendored codec needs `'unsafe-eval'`, not just `'wasm-unsafe-eval'`

This contradicts `GGWAVE_DEEP_DIVE.md` §2.4 and the master plan's CSP row, and it
blocks the whole browser-capture harness under HUSK's real CSP. Evidence, all
measured in Chromium 1234 build this session:

- Under the real CSP, the _first_ codec call throws:
  `EvalError: Evaluating a string as JavaScript violates the following Content
Security Policy directive because 'unsafe-eval' is not an allowed source of
script: script-src 'self' 'wasm-unsafe-eval' 'sha256-…'`.
- Exactly one `securitypolicyviolation` is reported, and it identifies the
  culprit: `{directive:"script-src", blocked:"eval",
source:"http://localhost:3000/src/lib/sound-chat/vendor/ggwave.js",
line:745, column:24}`.
- Hooking `window.Function` in a page-script proved the call site and the payload:
  the stack is `Function(…) <- newFunc(ggwave.js:745:24) <-
craftInvokerFunction(ggwave.js:818) <- module init`, and the compiled string is
  `"\n        return function disableLog() {\n        if (arguments.length !== 0) {\n…"`.
  So it is emscripten's embind, building one invoker per registered binding.
- The generating code, verbatim from the vendored file:
  `invokerFnBody+="}\n";args1.push(invokerFnBody);return newFunc(Function,args1).apply(null,args2)`
  — the _global `Function` object is passed as an argument_, and `newFunc` then
  does `var r = constructor.apply(obj, argumentList);`.
- That is why a text search misses it: `\bnew\s+Function\b` = **0** matches and
  `\beval\s*\(` = **0** matches in the 148,131-byte file. The deep dive's
  "zero `new Function`" claim was a correct text measurement of the wrong thing.
- Sufficiency check (harness-only relaxed CSP, `src/server.ts` untouched):
  with `'unsafe-eval'` added, the same page encodes the locked 64-byte block to
  `samples=92160` with **0** violations. So `'unsafe-eval'` is necessary and
  sufficient on top of the already-committed `'wasm-unsafe-eval'`.
- Consequence: this is a human decision, not a session decision. The approved
  `src/server.ts` edit is the single `'wasm-unsafe-eval'` token, the plan
  explicitly rejects `'unsafe-eval'`, and the artifact cannot be fixed without
  either patching it (its SHA-256 stops identifying upstream) or rebuilding it
  from source with an emsdk this repo does not have (deep dive §1.9). Options are
  listed under "Open questions" at the end of this entry.
- `harness/fake-mic.spec.ts` now carries an always-on test that asserts this
  blocker as measured reality (real CSP → `EvalError` + one `eval` violation;
  relaxed CSP → `samples=92160`, 0 violations), and the matrix runs under the
  real CSP are _skipped with a message_ unless a session opts in with
  `SOUND_CHAT_HARNESS_RELAXED_CSP=1`. Matrix lines are tagged `csp=…` so a
  measurement run can never be mistaken for a production-validating one.

### Second finding: the vendored artifact cannot be `import()`ed in a browser

- Measured in Chromium against the Vite dev server:
  `Object.keys(await import("/src/lib/sound-chat/vendor/ggwave.js")) = []`,
  `typeof (await import(...)).default === "undefined"`, no `ggwave_factory`
  global, and the served bytes are the raw UMD file (its `module.exports` branch
  requires Node's `exports`/`module`, which do not exist in a browser module).
  Vite does not pre-bundle files under `src/`, so the CJS-interop assumption in
  deep dive §2.1 ("the factory arrives as the module's `default`") holds for
  `node_modules`, not for a `src/`-vendored copy.
- Fix, in our code only, artifact byte-identical: `src/lib/sound-chat/load-ggwave.ts`
  loads the artifact as a classic `<script>` in a browser (`?url` asset + the
  `ggwave_factory` global it defines — exactly how upstream's own browser example
  loads it) and via `createRequire()` in Node (where `vendor/package.json`'s
  `"type":"commonjs"` makes it load as CJS). One factory, cached for the page.
- The loader deliberately lives _outside_ `vendor/`: anything in that folder
  inherits `"type":"commonjs"`, which made Playwright's Node-side loader reject
  `import.meta.url` in the `.ts` file ("Cannot use 'import.meta' outside a
  module" → "No tests found").
- Build evidence that `?url` keeps the artifact out of the JS graph: the harness
  Vite build emits `assets/ggwave-JKZypKNC.js` = **148.13 kB** (the verbatim
  artifact, byte-for-byte the vendored size), `assets/index-*.js` = 9.12 kB, plus
  a 90-byte `__vite-browser-external` shim for the `node:module` import in the
  Node-only branch.

### Vendored artifact, re-verified this session (not copied from the handover)

- `src/lib/sound-chat/vendor/ggwave.js`: 148,131 bytes, **0** CR bytes (pure LF),
  SHA-256 `D5FDB0A11B390D357D67163311C064FFD8CD90476911DCCA3C689A98EA11AB6B`,
  git blob `b9ca22672b85ebe916ec7baa344bde983421751c` (= upstream's blob id).
- `GGWAVE_DEEP_DIVE.md` quotes SHA-256 `F4BD5E9E…` for the same artifact; that is
  the CRLF checkout form, so it will not match a fresh LF checkout. `NOTICE.md`
  says so; the file was **not** modified this session (the blob id proves content
  identity, and all the loader work happened in a new sibling file).

### Two harness bugs found and fixed this session

1. `captureWithBrowser()` navigated to `http://localhost:3000/__sound-chat-harness`
   **without** registering the `page.route` fulfilment that `openHarnessPage()`
   installs, so the dev server's SPA fallback answered 404, the module never ran,
   and every test failed with `TypeError: Cannot read properties of undefined
(reading 'prepare')`. Fixed by extracting one shared `installHarnessRoute(page)`
   used by both paths. (Symptom to remember: the only console evidence was a
   single bare `404`.)
2. The harness page's "settle 700 ms after the last decode" early exit cut the
   capture short for multi-block variants: `sequence-3-blocks` (three 1.92 s
   blocks, 400 ms apart, 8.2 s window) stopped ~2.7 s in, 700 ms after block 1
   decoded, so blocks 2 and 3 were never in the room. This was a _harness_
   false negative, not a codec failure — the in-process runner recovers all three
   (`decodes=7 unique=3`). Fixed by making settle explicit per variant
   (`ChannelVariant.settleAfterDecodeMs`, `0` = run the whole window; multi-payload
   variants default to `0`).

### Files touched this session

New:

- `src/lib/sound-chat/load-ggwave.ts` — the environment-aware artifact loader
  (classic script + `?url` in a browser, `createRequire` in Node).
- `src/lib/sound-chat/spike/fuzz.test.ts` — the Section 7 step 7 fuzz suite.
- `prompts/sound-chat/SOUND_CHAT_LOG.md` — this file.

Edited (all inside `src/lib/sound-chat/**`, no off-limits file touched):

- `spike/codec.ts` — `loadCodecModule()` now delegates to `loadGgwaveModule()`.
- `harness/matrix.ts` — expectations tightened to measured outcomes; added
  `allowed` (may-appear) vs `expected` (must-decode) split; added 4096/8192 trim
  offsets; added `settleAfterDecodeMs`.
- `harness/matrix.test.ts` — garbage check uses `allowed`.
- `harness/page.ts` — `settleAfterDecodeMs` option; `encode` returns base64.
- `harness/fake-mic.spec.ts` — shared `installHarnessRoute`; CSP-mode switch +
  blocker test; base64 Tx handoff; matrix log line tagged with CSP mode.

Untouched on purpose: `src/server.ts` (still exactly the one committed
`'wasm-unsafe-eval'` token), `package.json`, `worker/**`, everything else on the
off-limits list.

### What this session added to the Phase 0 scope

- `spike/fuzz.test.ts` (Section 7 step 7), measured this session under
  `pnpm exec vitest run src/lib/sound-chat/spike/fuzz.test.ts`:
  - clean: **261** payloads (256 random 64-byte wire-format blocks — half with
    zero-padded tails — plus the boundary lengths 1, 5, 44, 63, 64) →
    `decodeEvents=522 undecoded=0 mismatches=0`. Exactly 2 decode events per
    payload, i.e. the codec re-decodes each block twice while it is in the
    90-frame window, and every decode is byte-exact including the zero padding
    the fixed-length encoder applies to short payloads.
  - degraded subsets, 48 payloads each: `white-noise-20db`
    `decodeEvents=96 undecoded=0 mismatches=0`; `resample-44k-round-trip`
    `decodeEvents=96 undecoded=0 mismatches=0`; `clip-0.06`
    `decodeEvents=96 undecoded=0 mismatches=0`.
- The degradation-matrix expectations were tightened to measured outcomes
  (`harness/matrix.ts`): trims 1/512/1023/1024/1025/2048/4096/8192 → `decode`;
  21504/46080/89000/91136/92160 → `graceful`; resample 44k/32k/22k round trips →
  `decode`; echo 20 ms/5 ms → `decode`; white noise ≥ −6 dB → `decode`, −12 dB →
  `graceful`; pink 24/12/0 dB → `decode`; dropouts 3×8/6×8/40×4 ms → `decode`,
  1×300 ms → `graceful`; gain +12/−20/−40/−60 dB and clip 0.06/0.02 → `decode`;
  cross-talk at half amplitude → `decode` (the louder block wins);
  equal-amplitude collision → `graceful` (nothing decodes). Also split
  `expected` (must decode) from `allowed` (may appear, never garbage).
- The in-process runner (`spike/matrix.test.ts`) then covers **46**
  browser-independent variants, all green; the browser runner covers the full
  **55**-variant matrix (see next section).

### Browser matrix — final run, all green (`58 passed (3.9m)`)

Full Chromium (`channel:"chromium"`) with `--use-file-for-fake-audio-capture`,
real `getUserMedia` → `AudioContext` → `ScriptProcessor(1024,1,1)` → codec,
under the real app CSP **plus `'unsafe-eval'`** (measurement mode, see the
headline). Every line below is from `test-results/phase0-harness-final.log`;
`decodes` counts decode events, `unique` distinct payloads, `firstMs` is when
the first decode landed. The fake track reports 44100 Hz regardless of the WAV,
so all `ctx=48000` runs include Chromium's 48000→44100→48000 conversion.

- decode band (payload byte-exact, `unique=1` in every case): `clean` decodes=2
  firstMs=1960; white-noise 40/30/20/12/6/0/−6 dB decodes 2/2/2/3/2/2/1,
  firstMs 1924–1966; pink-noise 24/12/0 dB decodes 3/2/2; clip-0.06/0.02
  decodes 1/2; gain +12/−20/−40/−60 dB decodes 2/2/3/1; dropouts 3×8/6×8/40×4 ms
  decodes 2/1/2; trim 1/512/1023/1024/1025/2048/4096/8192 decodes
  2/2/2/2/3/1/2/3 (firstMs falls to 1771 by trim-8192, as expected — the block
  starts earlier in the window); resample 44k/32k/22k round trips decodes 2/2/2;
  echo 20 ms/5 ms decodes 2/1; crosstalk-foreign-half decodes=2 `unique=1` (only
  the louder block decoded, matching in-process); lead-in-800ms decodes=2
  firstMs=2746 (≈ the 800 ms lead-in, as expected).
- graceful band (no crash, no hang, nothing decoded):
  `white-noise--12db`, `dropouts-1x300ms`*, `trim-21504/46080/89000/91136/92160`,
  `device-44100-native`, `device-44100-mismatched`, `device-48000-wav-44100`,
  `collision-simultaneous`, `silence-only`, `cut-short-500ms`,
  `self-transmit-pause-listening` (0 decodes, 111 chunks skipped),
  `self-transmit-pause-noisy` (0 decodes, 112 chunks skipped).
- *browser-only exception to the in-process result: `dropouts-1x300ms` decoded
  once in the browser (`decodes=1 firstMs=1948`) where the in-process runner
  decodes nothing. Expectation is `graceful`, so both outcomes pass; recorded
  because it shows the browser chain (Chromium's 48→44.1→48 conversion and the
  codec's internal resampler) is not sample-identical to the in-process feed.
- self-reception contract: `self-transmit-live` decodes our own block
  (`decodes=2 firstMs=1930`) — the hazard is real — while pausing the Rx feed for
  the transmit window plus 500 ms (`PAUSE_TAIL_MS` in `harness/page.ts`)
  prevents it entirely (0 decodes). Phase 1 must implement the pause.
- device-rate finding: every variant with a **44100 Hz AudioContext** decoded
  nothing (graceful), and a WAV authored at 44100 Hz failed even with a 48000 Hz
  context (`device-48000-wav-44100`), while **96000 Hz** (`device-96000`,
  decodes=2 firstMs=1947) and all 48000 Hz contexts decoded. Hypothesis (not
  separately measured): ggwave's internal resampler only keeps the frame grid
  aligned when the device rate is an integral multiple of the 48000/1024
  protocol constants. **Phase 1 hard requirement: create the AudioContext with
  `{ sampleRate: 48000 }` and never pre-resample the transmission.**
- `browser Tx path`: encode inside the page (real wasm Tx under the real CSP
  transform) → WAV → second Chromium → decode: `pass unique=1 firstMs=1924`.
  This closes the loop on the page-side Tx path; Phase 1's `audio-io.ts` can
  reuse `play()`/`playHex()` as the playback reference.
- `build output` test (Section 7 step 8): `vite build` emits
  `assets/ggwave-*.js` **148.13 kB** (the verbatim vendored artifact, its own
  file) and `assets/index-*.js` 9.12 kB; `index.html` references no codec. Note
  the mechanism changed from the plan's "own chunk" to "own `?url` asset" — see
  the second finding above; the plan's invariant (codec bytes are never in the
  entry bundle, only fetched when Sound Chat loads) still holds.

### Verification battery — final numbers, observed this session

Run against the exact final code state (`test-results/phase0-battery.log`):

| step                                              | result                                                                                                                             |
| ------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm exec tsc --noEmit` (root)                   | EXIT 0                                                                                                                             |
| `cd worker && pnpm exec tsc --noEmit`             | EXIT 0 — **zero diff**, the worker is untouched                                                                                    |
| `pnpm test`                                       | EXIT 0 — **21 test files passed, 171 tests passed** (includes the 50 Phase 0 spike tests and the worker project)                   |
| `pnpm run lint`                                   | EXIT 1 — see below: **0 errors in any Sound Chat file except the vendored artifact itself**                                        |
| `pnpm run lint:anti-slop` (`oxlint --type-aware`) | EXIT **0** — 143 warnings, 0 errors repo-wide (scoped check of `src/lib/sound-chat`: 61 warnings, 0 errors)                        |
| `pnpm run build`                                  | EXIT 0 (the app build still contains no codec — nothing in the app imports it; the chunk/asset proof comes from the harness build) |
| `git --no-pager diff --stat`                      | `src/server.ts                                                                                                                     | 2 +-` — **only** the already-committed CSP token, nothing else |
| `git status --short`                              | ` M src/server.ts` + untracked `audit/`, `prompts/sound-chat/`, `src/lib/sound-chat/`                                              |
| `git status --short -- worker`                    | empty — worker has no changes at all                                                                                               |

`pnpm run lint` caveat (logged, not silently accepted): the remaining errors are
prettier's "Delete `␍`"/reformat errors in **files outside this phase's
ownership** — the gitignored ggwave research clone (`ggwave/bindings/javascript/ggwave.js`,
`ggwave/examples/**`, `ggwave/tests/test-ggwave.js`), gitignored scratch under
`test-results/**` (probe scripts, harness build assets, the LF/CRLF copies of
the artifact), two pre-existing files in `src/components/husk/**` (`chat.tsx`,
`primitives.tsx`), and the vendored artifact `src/lib/sound-chat/vendor/ggwave.js`
itself, which is a 148 KB minified file that prettier always wants to reformat.
Every file I authored is prettier/eslint-clean (scoped run:
`eslint src/lib/sound-chat/spike src/lib/sound-chat/harness src/lib/sound-chat/load-ggwave.ts`
→ 0 problems). Clearing the repo-wide failure needs one of: eslint/prettier
ignore entries for `ggwave/**`, `test-results/**` and the vendored artifact
(edits to `eslint.config.js`/`.prettierignore` are not in this phase's approved
edit list), deleting the research clone, or both — a human call, so I stopped
there rather than edit unowned config.

Environmental notes for the next session:

- The Vite dev server must be running for the harness (`pnpm dev`, port 3000);
  the Playwright config starts it itself and reuses an existing one. A server
  left over from an earlier session was reused here; it serves the real CSP.
- `worker/node_modules` was missing at the start of the handover; a previous
  session ran `cd worker && pnpm install` so `pnpm test` could load the worker
  project. Still required.
- The Playwright "chromium" channel build (chromium-1234) must be installed for
  fake audio capture; it is.
- `test-results/run-harness-full.ps1`, `run-harness-subset.ps1`, `run-harness-tx.ps1`,
  `run-battery.ps1` and the `probe-*.mjs` scripts are scratch harness runners
  (gitignored) kept as evidence for this entry.

### Open questions for a human (Phase 1 is blocked on the first one)

1. **CSP / artifact decision (blocker).** The vendored artifact cannot run under
   `'wasm-unsafe-eval'` alone. Options, with tradeoffs:
   - (a) add `'unsafe-eval'` to `script-src` in `src/server.ts`: one-line change,
     zero code risk, but it weakens the CSP for the whole app — the plan
     explicitly rejected this;
   - (b) patch the vendored artifact to replace embind's
     `newFunc(Function, args1)` invoker construction with a CSP-safe equivalent
     (emscripten's own `createNamedFunction` shows the pattern): keeps the CSP,
     but the artifact's SHA-256 no longer identifies upstream and the patch must
     be re-derived on every artifact upgrade;
   - (c) rebuild the artifact from the clone's source with an emsdk configured
     for `DYNAMIC_EXECUTION=0`-style output (or a non-embind binding): cleanest
     CSP posture, but no emsdk exists in this repo today and it reopens the
     binding choice the deep dive closed;
   - (d) isolate the codec in a sandboxed frame/worker with its own document CSP:
     keeps the app CSP intact, but adds a messaging boundary around a synchronous
     API and was not prototyped here.
2. **Lint scope.** Approve ignore entries for `ggwave/**`, `test-results/**` and
   `src/lib/sound-chat/vendor/ggwave.js` (or decide to delete the clone) so
   `pnpm run lint` returns to green.
3. **Artifacts vs chunks.** The codec is now loaded as a `?url` asset rather than
   a Rollup chunk. If the plan's "own lazy chunk" wording matters for cache
   headers, note that Vite emits `?url` assets under `/assets/*` with hashed
   names, so `public/_headers`' immutable rule still applies (verify in Phase 5).
4. **44100 Hz devices.** If a real device refuses a 48000 Hz AudioContext
   (iOS/Safari can ignore the requested rate), the codec path may fail as
   measured here; Phase 1 must detect `context.sampleRate !== 48000` and surface
   it as a specific, user-legible error state rather than silence.

### Pending from Phase 0 — Phase 1 must complete these first

Per the workflow rules above, Phase 1 starts here, not with new transport code:

1. **CSP decision (blocker).** Get a human decision on the `'unsafe-eval'`
   question (Open question 1) recorded in this log, implement whichever option
   is chosen, and make the harness's `codec loading vs HUSK's CSP` test assert
   the chosen reality instead of today's blocker. Until then the browser matrix
   only runs under `SOUND_CHAT_HARNESS_RELAXED_CSP=1`.
2. **Repo-wide lint.** Apply the lint-scope decision (Open question 2) so
   `pnpm run lint` returns to green.
3. **`?url` asset vs chunk.** Confirm in the app's own production build (not
   just the harness build) that the codec asset lands under `/assets/*` with the
   immutable-cache header (Open question 3).
4. **44100 Hz guard.** Implement `context.sampleRate !== 48000` detection with a
   specific, user-legible error state (Open question 4) — a Phase 1
   `audio-io.ts` requirement that came out of this phase's measurements.

### Phase 0 acceptance, in one paragraph

Every Section 7 step is done and measured: the artifact is vendored and verified
(hash + blob id above), the CSP edit is in and asserted, the locked codec
configuration round-trips in-process (46 spike tests, all green), the round trip
is fuzzed over 261 clean and 144 degraded payloads byte-exact, the real Chromium
capture pipeline passes all 55 degradation variants plus the browser Tx loop-back
plus the asset-split check (58/58), and the verification battery is green except
the repo-wide eslint failure whose every remaining error is outside this phase's
ownership. The one thing Phase 0 could not prove — and says so loudly — is that
the codec runs under HUSK's CSP as planned: it does not, and that decision is now
on the table for a human.

---

## Phase 1 — Core transport module (and Phase 0 pending closeout)

Session of 2026-09-20. Started from `4654e95` with a clean tree; the human had
pushed two audit-document commits and a prompt-folder reorganisation between
sessions — all docs-only, nothing inside this phase's ownership. Per the human's
explicit instruction, **no repo change outside this phase's files was assumed
to be a fix**: every log claim was re-measured before being built on.

### Baseline re-verification (before any edit)

- `git status --short`: clean. `src/server.ts` still has exactly
  `'wasm-unsafe-eval'` and no `'unsafe-eval'` — the blocker state, as logged.
- In-process spike suites: **50/50 green** (7 files, includes the 261-payload
  fuzz with 144 degraded variants, all byte-exact).
- Harness build (`vite build --config src/lib/sound-chat/harness/vite.config.ts`):
  green; emits `ggwave-JKZypKNC.js` (148.13 kB) as its own asset.
- App production build (`pnpm run build`): green, and **contains no codec
  asset** — nothing in the app module graph imports the loader yet (expected
  until the Phase 3 route wires it). Measured, not assumed.
- `pnpm run lint` baseline: **2085 problems (2083 errors, 2 warnings)**.
  Re-measured per-directory: `ggwave/**` 144, `test-results/**` 1,804,
  `src/lib/sound-chat/vendor/ggwave.js` 9, and — differing from the earlier
  entry's claim — `src/components/husk/**` measured **0 errors / 2 warnings**
  (warnings do not fail `eslint .`). The human states they changed nothing;
  the earlier "errors in src/components/husk/**" claim does not reproduce and
  its cause is unknown (not assumed: possibly line-ending state at the time it
  was recorded). Flagged here so the record is honest.

### Pending item 1 — CSP/artifact decision (closed: option b, patch)

The human delegated the choice ("choose the best"). Chosen: **(b) patch the
vendored artifact** — keeps the app CSP exactly as strict, avoids the emsdk
dependency of (c) and the unprototyped messaging boundary of (d), and the one
line of (a) that the plan explicitly rejects.

The patch, derived from the artifact's own bytes (region extracted verbatim
first): `craftInvokerFunction`'s generated-source invoker — everything from
`var argsList="";` through `return newFunc(Function,args1).apply(null,args2)`
(1,809 bytes) — was replaced (816 bytes) with a plain closure that performs
the identical steps: argument-count check, `toWireType` conversion of `this`
and each argument into a wired list, destructor stack (`runDestructors` when
`needsDestructorStack`, individual dtor calls otherwise), and
`retType.fromWireType(rv)` return; the function is named via the artifact's own
CSP-safe `createNamedFunction`. `newFunc` is now unreferenced. `newFunc(Function`
was the file's **only** dynamic-execution site (verified: 2 occurrences of
`newFunc` total, and Phase 0's sufficiency measurement — with `'unsafe-eval'`
the same page ran with 0 violations).

- Hashes: unpatched 148,131 bytes, SHA-256
  `D5FDB0A1…AB6B` (unchanged upstream identity, blob `b9ca2267`);
  **patched 147,140 bytes, SHA-256
  `B097B3294D478B13C6693C33303C86F02BC9FFFD5DDE03698490A124E01E577F`**.
- Honesty note: the first patch pass dropped `craftInvokerFunction`'s closing
  brace (5 suites went red with a SyntaxError). Repaired, then `node --check`
  added to the routine; everything after was measured on the repaired file.
- `NOTICE.md` now records both hashes and the patch; it no longer claims the
  artifact is byte-identical to upstream.
- Immediate regression: the 50 in-process tests re-ran green on the patched
  artifact, including the 405-payload fuzz — the generic invoker's semantics
  are exercised thousands of times per run.
- Harness test flipped: `codec loading vs HUSK's CSP` now asserts the chosen
  reality — under the app's real CSP the page encodes the locked block to
  **samples=92160 with `violations=0`** (measured this session), plus a
  control probe proving the violation detector still fires under a CSP with no
  wasm allowance. The `SOUND_CHAT_HARNESS_RELAXED_CSP` switch and its skip
  paths are **removed**; the browser matrix now always runs under the real
  CSP. The env var is dead.

### Pending item 2 — lint scope (closed)

`eslint.config.js` (not on the off-limits list; mandated by the kickoff)
gains three ignores: `ggwave/**` (research clone — kept, see below),
`test-results/**` (build/probe artifacts), and the minified
`src/lib/sound-chat/vendor/ggwave.js`. Result: **`pnpm run lint` exits 0**
(0 errors, 2 pre-existing `react-refresh` warnings in `src/components/husk/**`).
This edit goes beyond the master plan's original approved-edit list; it was
explicitly instructed by the kickoff ("apply the decision so `pnpm run lint`
returns to green") and should be folded into the plan at the deferred
master-plan update.

### Pending item 3 — `?url` asset vs chunk (closed, with a deferral)

- Measured in the app's own production build: no codec asset is emitted today
  because no app-graph module imports the loader — the ?url import cannot be
  in the app build before Phase 3 wires a route to it. This is a fact of the
  bundler graph, not a failure.
- Mechanism confirmed with a probe build (`test-results/sound-chat-asset-probe`,
  same Vite install, entry importing the real `load-ggwave.ts`): the codec
  lands as **`dist/assets/ggwave-Cm_DI0UB.js` (147,139 bytes, hashed name)**
  under `/assets/*`, which `public/_headers` marks
  `Cache-Control: public, max-age=31536000, immutable`. The 1-byte difference
  from the on-disk 147,140 is Vite's emission normalisation.
- **Deferral, recorded deliberately:** the final in-graph confirmation (asset
  present in the app's own `dist/assets/`, served with the immutable header)
  belongs to Phase 3 route wiring, re-checked in Phase 5.

### Pending item 4 — 44100 Hz guard (closed)

Implemented in the new `audio-io.ts`: `createAudioContext()` creates the
context as `{ sampleRate: 48000 }`, verifies `context.sampleRate`, and throws
the dedicated **`AudioContextRateError`** (user-legible message naming both
rates) when the browser forces a different rate, closing the half-built
context first. Re-measured live in this session's harness run to justify the
guard: `device-44100-native` and `device-44100-mismatched` both decoded
**0** blocks (graceful, exactly the silence the guard exists to prevent),
while `device-96000` decoded. The harness's own spike path deliberately keeps
creating non-48000 contexts so this matrix stays measurable.

### Phase 1 delivery

- `src/lib/sound-chat/codec.ts` — the spike codec promoted verbatim (same
  guards: no negative instance id, no empty-payload encode, every view copied
  via `Uint8Array.from`, any throw = module dead + restart offer, Rx narrowed
  to `AUDIBLE_FASTEST`, `disableLog()` before init, payloadLength 64, volume
  25). `spike/codec.ts` is now a documented `export * from "../codec"`, so the
  Phase 0 harness and spike suites exercise the **real** module — no copy to
  drift.
- `src/lib/sound-chat/audio-io.ts` — microphone access as a discriminated
  result (granted / denied / missing / unsupported, clean constraints), lazy
  user-gesture `AudioContext` lifecycle with the 48000 verification above,
  `ensureRunning` for autoplay policy, `startListening` (ScriptProcessor
  1024/1/1, one chunk per `onaudioprocess`, decoded immediately, never
  accumulated; codec death stops the feed and reports once), Rx-feed pause on
  the AudioContext clock for the transmit window **plus the 500 ms measured
  tail** (background-throttle-proof), `transmit` / `transmitAndPause` via
  `AudioBufferSourceNode`, `teardownAudio` with explicit `track.stop()` on all
  tracks, and an `onVisibilityChange` subscription for the transport to hold
  sends while hidden.
- `src/lib/sound-chat/transport-machine.ts` — pure state machine in the
  `room-machine.ts` discipline: idle, listening, transmitting, awaiting_turn,
  awaiting_ack, backoff, error (recoverable — START again), module_error
  (only RESTART leaves it; STOP cannot erase it). Illegal transitions are
  no-ops.
- Tests: `transport-machine.test.ts` (9 tests incl. the **full 8-state ×
  13-event transition table** asserted exhaustively) and `audio-io.test.ts`
  (16 tests over mocked `AudioContext`/`getUserMedia`/codec: permission
  states, rate guard, one-chunk-per-callback feeding, pause+tail resume,
  module-death latching, teardown track stops, visibility subscription).

### Verification battery (this session's own numbers)

- `pnpm exec tsc --noEmit`: **exit 0**, repo-wide.
- `pnpm run lint`: **exit 0** (0 errors, 2 pre-existing warnings).
- `pnpm exec vitest run src/lib/sound-chat`: **75/75 green** (50 spike +
  16 audio-io + 9 transport-machine), ~13 s.
- Harness build: green.
- `pnpm run build` (app): green (no codec asset pre-Phase-3, measured above).
- Playwright harness, **no relaxed-CSP env var set**: **58/58 passed in 3.9m,
  exit 0** — first time the full browser matrix has ever run under HUSK's
  real CSP. Key lines, all measured this run: `[csp] real-csp samples=92160
violations=0 (patched artifact, no dynamic execution)`;
  `device-44100-native decodes=0` / `device-44100-mismatched decodes=0` /
  `device-96000 decodes=1`; `self-transmit-live decodes=3` vs
  `self-transmit-pause-listening decodes=0 skipped=111` (Phase 0's
  pause-before-transmit rule reproduced); `[browser-tx] pass unique=1`;
  asset-split build test green.

### Housekeeping decisions recorded this session

- The `ggwave/` research clone is **kept**: the CSP patch re-derivation, the
  Phase 2 protocol design (against `ggwave.cpp`), and any artifact upgrade all
  need it. Deletion belongs to the final cleanup phase, once no phase can
  still need it. It is now eslint-ignored.
- New files this session: `src/lib/sound-chat/{codec,audio-io,transport-machine}.ts`
  plus their tests; modified: `spike/codec.ts` (re-export),
  `harness/fake-mic.spec.ts` (CSP reality), `vendor/ggwave.js` (the patch),
  `vendor/NOTICE.md` (provenance), `eslint.config.js` (lint scope). Nothing
  outside the sound-chat namespace plus `eslint.config.js` was touched;
  `worker/**`, `src/lib/husk/**`, `src/components/husk/**`, routes,
  routeTree, tools, e2e, package.json, playwright.config.ts, vite.config.ts,
  .gitignore: untouched. No WebRTC/STUN/TURN, no variable-length mode, no DSS,
  no ultrasound.
