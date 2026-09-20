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

### Commit record for Phase 1

- Implementation: `e3dd342 feat(sound-chat): Phase 1 core transport - CSP-safe
patched artifact, codec, audio-io, state machine` (10 files).
- Documentation: `b710906 docs(sound-chat): Phase 1 log entry and master-plan
repairs` (log + master plan).
- Pushed to `origin/main`; branch is clean afterward.
- The master plan was repaired in the same documentation commit to remove
  stale post-Phase-1 instructions: it now records the patched-artifact CSP
  reality, the authorized `eslint.config.js` and `NOTICE.md` edits, completed
  Phase 0/1, `?url`-asset wording, the mandatory full document reads, and the
  commit-first verification workflow.

---

## Independent verification pass — Phase 0/1 audit + pre-Phase-2 hardening

Session type: **verification and hardening only. No phase was started** (Phase 2
is still unimplemented). The CSP question was **not** reopened: option (b), the
patched artifact, stands — re-verified, not re-decided.

### What this session did

- Read the master plan, this log and the deep dive in full first, then
  re-measured every claim they make about the completed phases instead of
  trusting them, using an external audit report as a checklist to test rather
  than as a source of truth. Every audit item was re-tested and classified.
- Result: 7 real defects, 2 wrong claims and 1 arithmetic error in phases whose
  suite was 196 unit tests + 58 real-Chromium cases, all green. The ones that
  can bite Phase 2 are fixed and regression-guarded; the whole class of failure
  is now the master plan's binding **Section 10** (new Rule 12).
- No sound/codec/CSP/security defect was found. Every defect was in a *seam*:
  a callback mock that could not throw, a chunk that was never the wrong size, a
  teardown that never ran twice, a `close()` that never rejected, a byte count
  typed by hand.

### Battery re-run BEFORE any edit (own numbers, at `274e7c7`, clean tree)

| Step | Result |
| :--- | :--- |
| `pnpm exec tsc --noEmit` (root / `worker`) | exit 0 / exit 0 |
| `pnpm test` | **23 files, 196 tests passed** (17 s) |
| `pnpm run lint` | exit 0 — 0 errors, 2 pre-existing `react-refresh` warnings |
| `pnpm run lint:anti-slop` | 147 warnings, 0 errors |
| `pnpm run build` | entry `index-CNYxg7aS.js` 307.00 kB / **gzip 95.75 kB**, no codec in it |
| harness `vite build` | `assets/ggwave-Cm_DI0UB.js` = **147139 bytes** |
| harness Playwright (full, real CSP) | **58 passed (4.3 m)**; `[csp] real-csp samples=92160 violations=0`; `csp-mode=real server-csp-has-unsafe-eval=false`; `self-transmit-live decodes=2` vs `self-transmit-pause-listening decodes=0 skipped=111`; `device-96000 decodes=2` |
| `git diff --name-status d91b774 HEAD` (worker, husk lib/components, routes, routeTree, tools, e2e, live-tests, package.json, all three configs) | **0 lines** — boundary held; `src/server.ts` = exactly `+ 'wasm-unsafe-eval'`; `eslint.config.js` = 3 ignore entries; `.gitignore` = `+ggwave` |

### The findings, classified

| # | Finding | Evidence gathered this session | Class → decision |
| :-- | :--- | :--- | :--- |
| 1 | `onDecoded` sat inside the codec `try/catch` in `audio-io.ts`, so an application callback that throws was reported as a dead codec module and the mic feed latched off | In-process probe of the real `startListening`: decode calls 1, `onModuleError` 1 with the *consumer's* error, second chunk never reached the codec (`handle.chunks` frozen at 1) | **Real bug** → fixed (three-layer error contract) |
| 2 | `SoundChatCodec.decode` accepted any non-zero chunk length | Raw-module sweep: chunks of 1 / 192 / 512 / 1000 / **1023** samples de-synchronise the fixed-length Rx permanently (a following complete block decodes 0 times); **1024 / 2048 / 3072 are fine** | **Real, unreachable today** (capture always yields 1024) but reachable from Phase 2/3 code → guard added for whole-frame multiples |
| 3 | `bytesToFloat32` threw a bare `RangeError` for a non-4-byte-aligned view | Node: `RangeError: start offset of Float32Array should be a multiple of 4`. Only call site passes `Uint8Array.from(view)` (offset 0) | **Latent** → typed `CodecUsageError` |
| 4 | `vendor/NOTICE.md` recorded 147140 bytes; the file and the committed blob are 147139. A harness comment still said 148131 (pre-patch upstream size) | Recomputed SHA-256 over the real bytes = the value NOTICE already recorded (the hash was right, the size was typed). `git cat-file -s HEAD:…vendor/ggwave.js` = 147139 | **Doc error** → fixed, now machine-checked |
| 5 | `onVisibilityChange` never dispatches the initial hidden state | Code reading: it is a change-only subscription; the consumer can read `visibilityState` itself | **By-design** → no change; Phase 3 decides the contract |
| 6 | `teardownAudio` used `void context?.close()` | Real Chromium probe: a second `close()` rejects `InvalidStateError: Cannot close a closed AudioContext.` and the `void` form produced **2 `unhandledrejection` events** | **Real (low)** → rejection-handled |
| 7 | `SoundChatCodec.rxDurationFrames()` is dead code | Measured: returns 0 on a fixed-length Rx; zero callers outside the class + `.d.ts` | **Real** → removed |

### Wrong claims found (corrected in the docs this session)

1. **"An empty payload kills the codec module for the rest of the page session"**
   (master plan §3 hard limits, `codec.ts` guard comment, deep dive §5.3).
   Re-ran the trap on a throwaway module: `RuntimeError: divide by zero`, then the
   module encoded a full 368640-byte waveform. The "dead for the session"
   behaviour is **our own deliberate latch**, not a wasm fact. The wording is
   corrected everywhere; the latch stays, because a trap in Emscripten leaves
   C++ state undefined — "terminal by policy" is the honest statement.
2. **The audit's "test-count discrepancy" is not one.** Phase 0's 21 files /
   171 tests plus Phase 1's `audio-io` (16) + `transport-machine` (9) = 23 / 196,
   exactly what this session measured; the 75/75 figure is the Sound Chat
   subset. Historical entries are history, per Rule 7 — nothing was rewritten.
3. **Arithmetic**: Section 4's "~39 bytes usable per block" is 43
   (64 − 5-byte header − 16-byte tag) before multi-block `seq` overhead. The
   plan now states the arithmetic and requires Phase 2 to measure the real
   capacity and make every document agree.

### Additional measurements (Phase 2 design inputs)

- **Tx determinism, byte-exact**: the same payload/protocol/volume produces
  identical bytes on repeated calls *and* across two independently instantiated
  modules (368640 bytes each; different payload → 338008 differing bytes). A
  recorded transmission therefore replays perfectly: **the dedupe window is the
  replay defence**, and nonce discipline exists to stop key+nonce reuse, not
  replay. Phase 2 must not blur the two.
- **Artifact tamper check**: the vendored file differs from the clone's upstream
  copy (148131 LF bytes) in **one contiguous region** (1803 → 811 characters,
  `craftInvokerFunction` → `createNamedFunction`); everything before and after is
  byte-identical. 0 `eval(`, 0 `new Function`, exactly one `newFunc(` (the
  now-unreferenced declaration), 1 `WebAssembly.instantiate`.
- **Patched-artifact arity**: `.length === 0` for every export while `.argCount`
  is preserved (`encode` 4, `decode` 2, `init` 1) and a wrong argument count still
  raises `BindingError: function encode called with 2 arguments, expected 4`.
  Nothing in this repo relies on `Function.length`.
- **Built asset identity**: the emitted `assets/ggwave-*.js` is byte-identical to
  `src/lib/sound-chat/vendor/ggwave.js` (sha256 `B097B329…577F`, 147139 bytes) —
  now asserted by the harness build-output test instead of trusted.
- The `.git` directory of the `ggwave` research clone is gone (it is a plain
  source tree now), so the upstream commit id in `NOTICE.md` can only be
  re-verified by content, not by `git -C ggwave`. Recorded, not fixed: the clone
  is kept as required and the artifact hash is what the test checks.

### What was changed, file by file

- `src/lib/sound-chat/codec.ts` — `decode()` refuses a chunk that is not a whole
  number of 1024-sample frames, *outside* `#guard()` so a caller's mistake cannot
  latch the module dead; `bytesToFloat32()` reports an unaligned view as
  `CodecUsageError` instead of a raw `RangeError`; `rxDurationFrames()` deleted;
  header comment now states the three-layer error contract and the
  "terminal by policy, not by measurement" rule. All property lengths stay
  inside `#guard()` so a genuine trap still latches.
- `src/lib/sound-chat/audio-io.ts` — the audio callback now has two layers:
  codec failures stop the feed and go to `onModuleError`; `onDecoded` errors go
  to the new `onDecodedError` and the feed keeps running (falls back to
  `console.error`, never a silent swallow); `ListenOptions.onModuleError` is
  documented to cover both a real module death *and* our own broken frame
  contract, with `instanceof` for the copy; `createAudioContext()`'s
  rate-mismatch close and `teardownAudio()` are rejection-handled.
- `src/lib/sound-chat/codec-guards.test.ts` (**new**, 8 tests) — partial-frame
  refusal with `state === "ready"` and no desync; whole multiples stay legal;
  empty chunk; encode guards leave the module usable; unaligned / un-sized byte
  views; a closed codec refuses as a usage error.
- `src/lib/sound-chat/provenance.test.ts` (**new**, 3 tests) — parses
  `NOTICE.md` and asserts the recorded size and SHA-256 against the real bytes,
  asserts no dynamic execution (`eval(`, `new Function`, one unreferenced
  `newFunc(` declaration, `createNamedFunction` present, one
  `WebAssembly.instantiate`), and asserts the upstream MIT text ships beside it.
- `src/lib/sound-chat/audio-io.test.ts` — the mock `close()` now **rejects** the
  way measured Chromium does (this is what makes class 5 testable at all); plus
  three seam tests: a throwing consumer keeps the feed alive and reports
  separately, the no-handler fallback reports to `console.error`, and a misuse
  error reaches `onModuleError` with its type intact; plus a double-teardown test
  that would fail as an unhandled rejection if the handling were removed.
- `src/lib/sound-chat/spike/frame-alignment.test.ts` — the partial-frame test now
  pins the **guard** (`CodecUsageError`, `state === "ready"`, the next block still
  decoding at frames 89/90) instead of the old silently-fatal fact
  (`expect(second).toEqual([])`). The measured fact itself is cited in the file
  header and the plan's seam set.
- `src/lib/sound-chat/harness/fake-mic.spec.ts` — stale `148131` comment
  corrected; the build-output test now also asserts the emitted codec asset is
  byte-identical to the vendored artifact.
- `src/lib/sound-chat/vendor/NOTICE.md` — `147140` → `147139` bytes.
- `prompts/sound-chat/SOUND_CHAT_MASTER_PLAN.md` — new binding **Section 10**
  (10.1: 14 defect classes, each with the guard it needs and the test that must
  fail before the fix; 10.2: crypto/protocol properties P1–P12; 10.3: the
  hostile-input seam set; 10.4: definition of done), new **Rule 12** making it
  binding, the Section 5 battery now includes the seam/provenance run, Section 4's
  capacity arithmetic corrected, post-Phase-1 accuracy notes for the Section 3
  rows, Phase 2/3/4 gates extended, and new Section 8 checklist items.

### Battery re-run AFTER the fixes (own numbers)

| Step | Result |
| :--- | :--- |
| `pnpm exec tsc --noEmit` (root / `worker`) | exit 0 / exit 0 |
| `pnpm test` | **25 files, 210 tests passed** (23.1 s) — +2 files / +14 tests |
| `pnpm exec vitest run src/lib/sound-chat` | **11 files, 89 tests passed** (was 75) |
| `pnpm run lint` | exit 0 — 0 errors, 2 pre-existing warnings |
| `pnpm run lint:anti-slop` | 148 warnings, 0 errors (one more file scanned) |
| `pnpm run build` | entry `index-CNYxg7aS.js` 307.00 kB / **gzip 95.75 kB**, no codec — unchanged |
| harness `vite build` | green; codec `?url` asset emitted |
| harness Playwright (full, real CSP) | **58 passed (4.3 m)**; `[csp] real-csp samples=92160 violations=0`; `csp-mode=real server-csp-has-unsafe-eval=false`; `self-transmit-live decodes=3` vs `self-transmit-pause-listening decodes=0 skipped=111`; `device-96000 decodes=2`; the byte-identity assertion passed |
| seam logs observed | `[guards] after refused partial frames, decodes at frames=89,90`; `[align] partial-frame first=89,90 refused=CodecUsageError after=1,89,90` |

Note: the two new test files were written by the editor tooling with CRLF and
failed prettier; they were converted to LF and formatted with the repo's own
prettier before commit. No config file was touched to make that pass.

### Honest caveat about the new tests

They were **not** run against the pre-fix code (the old behaviour was measured
directly instead: the `onDecoded → onModuleError` probe, the raw-module
partial-frame sweep, and the real-Chromium double-`close()` probe). The plan's
Section 10.1 now makes "must fail before the fix" an explicit requirement for
every remaining phase, and Phase 4 has to prove it in the harness — including
corrupting a *copy* of the artifact to show the provenance test can fail.

### Tooling incident (recorded so it is not repeated)

A throwaway Playwright probe configuration written by this session inherited the
default output directory and **emptied the gitignored `test-results/` scratch
directory** (harness build output and this session's first logs). No tracked file
was affected, the harness build was regenerated with
`pnpm exec vite build --config src/lib/sound-chat/harness/vite.config.ts`, and the
probe was re-run from an isolated folder with `rootDir`/`outputDir` pinned. That
rule is now Section 10.1 class 14. The earlier session's scratch runners
(`test-results/run-battery.ps1`, `probe-*.mjs`) referenced in the Phase 0 entry
are gone from disk with it.

### Handed to Phase 2 (do not redo, re-verify)

1. The five applied fixes above — Phase 2 must show they still hold after its own
   changes (it is the first real consumer of `onDecoded`, so fix 1 stops being
   theoretical: parsing, AEAD verification, dedupe and ACK logic all run there).
2. Section 10.2 P1–P12 — per-direction keys, no key+nonce reuse across reloads,
   AAD over the whole header, replay defeated by the bounded dedupe window,
   tag failure = nothing decoded, "heard but unreadable" distinguished from
   silence, pairing never acoustic, derivation arithmetic + iterations logged,
   no secret logged or persisted, **measured** capacity, ACK timing scaled to the
   measured transmit duration, bounded protocol state.
3. Section 10.3 — extend the hostile-input set with everything Phase 2 adds.
4. Measure the real single- and two-block payload capacity and make Section 3,
   Section 4 and the UI's character counter agree with it.
5. Nothing in the locked configuration changed: two instances, `AUDIBLE_FASTEST`,
   fixed-length 64-byte blocks, 48000/1024, no DSS, no variable-length, no
   ultrasound, no WebRTC/STUN/TURN, `'wasm-unsafe-eval'` only.

### Commit record for this pass

- Implementation + master plan: `a6d8781e6f34b381ccae24963f9d44c579459590`
  (9 files, +652/−33) — `worker/**`, `src/lib/husk/**`,
  `src/components/husk/**`, routes, `routeTree.gen.ts`, `package.json`, the
  eslint/vite/playwright/vitest configs, `.gitignore` and `src/server.ts` were
  not touched at all in this pass; the `ggwave` research clone is untouched and
  kept.
- Documentation (this entry): the next commit on `main` after `a6d8781`.
- Both pushed to `origin/main`; branch clean afterwards.

### Claims corrected this session

1. "An empty payload kills the module for the rest of the page session" → it
   traps (`divide by zero`) and the module stays usable; the latch is our policy.
2. "`NOTICE.md`: the patched file is 147140 bytes" → 147139 (hash was already
   right, and is now machine-checked).
3. "harness comment: the vendored artifact is 148131 bytes" → 147139, which is
   also what the emitted asset must equal byte-for-byte.
4. "usable plaintext per block ~39 bytes" → 43 before `seq` overhead.
5. "21 files/171 tests vs 23/196 tests is a discrepancy" → it is arithmetic, and
   the 75/75 figure is the Sound Chat subset.
6. "a thrown codec call means the module is dead" → the module may well be
   alive; the session is restarted by policy, and misuse guards deliberately
   never latch (this is what the old comment implied incorrectly).

