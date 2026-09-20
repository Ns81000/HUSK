# HUSK — Sound Chat Feature: Master Plan (Rev. 2)

Status: locked plan, ready for Phase 0 (Integration Spike).
**Supersedes Rev. 1.** Rev. 2 incorporates the full ggwave deep-dive
(`prompts/sound-chat/GGWAVE_DEEP_DIVE.md`) — every architecture decision below
is backed by measured evidence from that document, not assumption. Read that
document too if you want the underlying reasoning; this plan states the
conclusions and the resulting build spec.

This document is the single source of truth for this feature. Every session
must read it in full (in chunks if needed) before doing anything, alongside
the running log file described in Section 5.

---

## 1. What we're building

A second, fully independent chat mode: two devices in the same physical space
exchange short encrypted text messages using sound through their speakers and
microphones — no Wi-Fi, Bluetooth, server relay, or internet connection
required for the chat itself. It sits next to HUSK's existing network-relay
chat as an alternative entry point, not a replacement.

**Important framing correction from Rev. 1**: this ships as an **audible**
feature, not an inaudible one (see Section 3 — the "near-ultrasonic, silent"
version is unreliable in real browsers today). The pitch is "type a short
note, your phone plays a sound, the other phone hears it and decodes it" —
both people witness the transmission happen. That's an honest description
and, for a same-room air-gapped chat, arguably a feature (it's obvious when
data is moving) rather than a compromise.

Working name: **Sound Chat**. Route: `/sound-chat`. Folder namespace:
`sound-chat` everywhere (files, components, lib).

## 2. Non-negotiable constraints

1. **HUSK's existing chat must not be touched or put at risk.** `worker/**`,
   `src/lib/husk/**`, `src/components/husk/**`, `src/routes/r.$roomId.tsx`, and
   the WebSocket protocol are OFF LIMITS. If a session believes a change there
   is truly necessary, it must STOP and explain why in the log rather than
   making the edit.
2. **The only approved edits to existing files** (full ownership map in
   Section 6) are: one new button in `src/routes/index.tsx`, and one precise,
   minimal edit to `src/server.ts`'s CSP (`'wasm-unsafe-eval'` in
   `script-src`, and optionally a `Permissions-Policy: microphone=(self)`
   header). No other existing file changes.
3. **Match HUSK's design system exactly** — semantic Tailwind tokens only, the
   existing `Button`/`IconButton`/`Panel`/`Modal`/toast primitives reused
   as-is, the same glass/tactile visual language, no emoji in UI copy.
4. **Match HUSK's philosophy** — ephemeral, no accounts, no server-side
   persistence. In-memory only for the session.
5. **Be honest about physics in the UI.** No claim of silence, no claim of
   instant delivery. Every transmit shows a real progress/ETA. Copy should say
   something like "plays a short sound" — never "silent" or "inaudible."
6. **Never silently fail.** Every failure mode gets a specific, user-legible
   message. Given the codec gives us almost no error signals of its own
   (Section 3), the app's own error handling carries all of the weight here —
   this is not optional polish, it's core to the feature working at all.
7. **Vendor the codec artifact deliberately, with its hash recorded.** Do not
   `pnpm add ggwave` (see Section 3 — it's a stale, CSP-incompatible build).

## 3. Locked architecture decisions

All of the following are backed by measured findings in
`GGWAVE_DEEP_DIVE.md` — do not re-litigate without new evidence.

| Decision                     | Choice                                                                                                                                                                                                                                                                                                                                                                                                                             | Why (deep-dive reference)                                                                                                                                                                                                                                                                                                                                                                                                   |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Codec                        | **ggwave**, vendored                                                                                                                                                                                                                                                                                                                                                                                                               | Proven FSK + Reed-Solomon; not reinventing DSP                                                                                                                                                                                                                                                                                                                                                                              |
| Codec artifact source        | **Vendor the clone's newer prebuilt `bindings/javascript/ggwave.js`** (SHA-256 `F4BD5E9E…`) into `src/lib/sound-chat/vendor/ggwave.js`. **Do not** `pnpm add ggwave` from npm.                                                                                                                                                                                                                                                     | npm's published build is a 4-year-old (2022) artifact missing protocol features, and it calls `new Function` at load — which would force `'unsafe-eval'` into our CSP. The newer clone artifact has zero `new Function` calls and needs only the narrower `'wasm-unsafe-eval'`                                                                                                                                              |
| Transmission mode            | **Fixed-length, 64-byte blocks. No variable-length mode, ever.**                                                                                                                                                                                                                                                                                                                                                                   | Variable-length adds a 683ms marker tax, an unrecoverable 13–38 second "stuck receiving" window with no JS-exposed cancel, and an 8MB memory buffer we don't need. Fixed-length is cheaper, faster per byte, and never gets stuck                                                                                                                                                                                           |
| Protocol                     | **`AUDIBLE_FASTEST` for v1. No ultrasound in v1.**                                                                                                                                                                                                                                                                                                                                                                                 | Ultrasound has two long-standing, unresolved browser-specific bugs (Safari cannot receive it at all; other browsers fail to receive it via JS even when the native app works on the same device) — confirmed against the live upstream issue tracker. Audible has no such problems. (Ultrasound may be revisited later as an experimental opt-in with a self-test, per the product decision already made — not in v1 scope) |
| DSS mode                     | **Never enable.**                                                                                                                                                                                                                                                                                                                                                                                                                  | Zero wire-speed benefit, zero security/obfuscation value (it's a public, hardcoded XOR mask), and upstream's own tests disable it for exactly this reason                                                                                                                                                                                                                                                                   |
| Duplex mode                  | **Half-duplex, turn-based** (unchanged from Rev. 1)                                                                                                                                                                                                                                                                                                                                                                                | Confirmed necessary: transmitting resets the codec's own receiver state on a shared instance, and our own speaker output would otherwise be picked up by our own mic                                                                                                                                                                                                                                                        |
| Instances                    | **Two ggwave instances held for the whole session**: one Tx-only, one Rx-only. Never re-`init()` per message.                                                                                                                                                                                                                                                                                                                      | `init()` allocates ~13–22MB; re-initializing per message is wasteful and unnecessary. A shared instance's `encode()` call resets its own receive state, so Tx and Rx must be separate instances                                                                                                                                                                                                                             |
| Instance ceiling             | **Hard cap of 4 live instances per loaded module — never approach it.** We use exactly 2 (Tx+Rx) for the whole session. Any future design that creates instances per-message or per-tab must re-check this ceiling first.                                                                                                                                                                                                          | Confirmed in the deep dive; exceeding it is one of the module-killing misuses alongside the empty-payload and invalid-id traps                                                                                                                                                                                                                                                                                              |
| Rx optimization              | **`rxToggleProtocol()` to enable exactly one protocol (`AUDIBLE_FASTEST`) before `init()`.** Call `disableLog()` on both instances.                                                                                                                                                                                                                                                                                                | Measured ~5x cheaper decode (135ms → 27ms per 20 calls) and fewer false positives versus leaving all 12 protocols enabled                                                                                                                                                                                                                                                                                                   |
| Message integrity            | **Our own AEAD tag is the only integrity signal that exists.** The codec cannot distinguish "silence" from "corrupted transmission" in JavaScript — both return an empty result.                                                                                                                                                                                                                                                   | Confirmed: the underlying failure signal exists in the C++ layer but isn't exposed to JS at all. A failed AEAD tag verification must be treated exactly like "nothing received yet"                                                                                                                                                                                                                                         |
| Dedupe                       | **By our own `msgId` in the payload header.** The codec re-decodes the same audio block 2–4 times as it streams through a sliding window — this is normal, expected behavior, not a bug to work around at the codec level                                                                                                                                                                                                          | Measured directly; the codec does no dedupe of its own                                                                                                                                                                                                                                                                                                                                                                      |
| Retransmission               | **ACK-based, over the half-duplex turn cycle** (mirrors the existing chat's `localId`/ack-timeout/retry pattern) rather than blind repeated sends                                                                                                                                                                                                                                                                                  | Fits naturally with the half-duplex design already chosen; more efficient than blind repetition, and we already have a proven pattern to mirror                                                                                                                                                                                                                                                                             |
| Self-reception               | **Pause the Rx instance's mic feed for the duration of our own transmission** (same technique the official ggwave browser demo uses)                                                                                                                                                                                                                                                                                               | Prevents decoding our own speaker output; simpler and more reliable than trying to filter it out after the fact                                                                                                                                                                                                                                                                                                             |
| Wire format                  | See Section 4 below — 64-byte blocks, `ver\|msgId\|fromPeerId\|len\|ciphertext+AEAD tag`, padded                                                                                                                                                                                                                                                                                                                                   | Maximizes usable payload within the fixed 64-byte block while leaving room for the AEAD tag that carries our only integrity signal                                                                                                                                                                                                                                                                                          |
| Encryption                   | AES-256-GCM (or ChaCha20-Poly1305), key from a manually-typed pairing code (unchanged from Rev. 1)                                                                                                                                                                                                                                                                                                                                 | —                                                                                                                                                                                                                                                                                                                                                                                                                           |
| Message length               | **Cap at 2 blocks (~70 usable bytes / roughly 60–70 ASCII characters), ~3.9 seconds total transmit time on AUDIBLE_FASTEST.** Single very short messages fit in 1 block (~1.9s).                                                                                                                                                                                                                                                   | Recomputed from the deep dive's measured per-block timing — significantly faster and more predictable than the earlier variable-length estimate                                                                                                                                                                                                                                                                             |
| Persistence                  | None — in-memory only (unchanged)                                                                                                                                                                                                                                                                                                                                                                                                  | Matches HUSK philosophy                                                                                                                                                                                                                                                                                                                                                                                                     |
| Backend involvement          | None — 100% client-side (unchanged)                                                                                                                                                                                                                                                                                                                                                                                                | —                                                                                                                                                                                                                                                                                                                                                                                                                           |
| CSP change                   | Add `'wasm-unsafe-eval'` to `script-src` in `src/server.ts`. **Not** `'unsafe-eval'`.                                                                                                                                                                                                                                                                                                                                              | Required for `WebAssembly.instantiate` to run under HUSK's current CSP; confirmed via both spec behavior and direct inspection of the vendored artifact                                                                                                                                                                                                                                                                     |
| COOP/COEP                    | **None needed.**                                                                                                                                                                                                                                                                                                                                                                                                                   | Confirmed: zero `SharedArrayBuffer`/pthread usage in either build artifact                                                                                                                                                                                                                                                                                                                                                  |
| Permissions-Policy           | Optional defense-in-depth: `microphone=(self)`. Not required — no policy exists today so mic access is currently unrestricted anyway.                                                                                                                                                                                                                                                                                              | —                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `media-src` CSP              | **Not needed.** WebAudio `AudioBufferSourceNode` playback isn't governed by `media-src`; only relevant if we later adopt `<audio>`/blob playback or AudioWorklet                                                                                                                                                                                                                                                                   | —                                                                                                                                                                                                                                                                                                                                                                                                                           |
| Bundle strategy              | **Lazy-load the vendored codec via dynamic `import()` behind the Sound Chat route/button only.** Never in the main bundle.                                                                                                                                                                                                                                                                                                         | The codec adds ~60KB gzipped — comparable to HUSK's entire current app bundle (~95KB gzipped). This must be an isolated chunk                                                                                                                                                                                                                                                                                               |
| Static-asset serving/caching | **Verify, don't assume:** the vendored `.wasm`/`.js` artifact must be emitted by Vite under `/assets/*` so it automatically inherits the existing `public/_headers` rule (`public, max-age=31536000, immutable`) and is served with the correct `application/wasm` content type by the Workers runtime.                                                                                                                            | Re-checked against the audit's `[09]` findings: `public/_headers` already has a working immutable-cache rule for `/assets/*` — we want the codec to fall under it for free, not invent new header rules                                                                                                                                                                                                                     |
| Service worker               | **No changes needed, and `public/sw.js` stays off-limits.** `sw.js` already treats `/assets/*` as cache-first and leaves every other navigation (besides `/`) network-only — the same behavior `/r/<id>` already relies on. `/sound-chat` will behave the same way automatically: not available offline on first visit (needs the network once to fetch the code), but the acoustic transport itself needs no network once loaded. | Confirmed hand-written `sw.js` has no Workbox/build-time manifest to update, so there is no integration step here — but this must be verified empirically in Phase 0/5, not assumed                                                                                                                                                                                                                                         |
| CI                           | **None exists in this repo** (no `.github/` workflows, confirmed in the audit) — all verification is manual and local before a manual `wrangler deploy`, same as the rest of the project. No CI setup is in scope for this feature.                                                                                                                                                                                                | Avoids inventing process this project doesn't use elsewhere                                                                                                                                                                                                                                                                                                                                                                 |
| Capture technique            | `createScriptProcessor(1024, 1, 1)` (matches `samplesPerFrame`), fed to the Rx instance one chunk at a time, draining the result after every chunk — never accumulating into one large buffer before decoding                                                                                                                                                                                                                      | This is the only technique with real-world prior art in the ggwave ecosystem; `AudioWorklet` has zero prior art here and is deferred as a future improvement, not a v1 blocker                                                                                                                                                                                                                                              |
| Sample rate / frame size     | **48000 Hz / 1024 samples are protocol constants — never change them.** Only `sampleRateInp`/`sampleRateOut` (device-side) may vary; the codec resamples internally.                                                                                                                                                                                                                                                               | Both peers must agree on these or nothing ever decodes — this is undocumented upstream and easy to break "by optimizing"                                                                                                                                                                                                                                                                                                    |
| License                      | MIT (ggwave). Requires a reachable attribution notice in the UI (one line is enough, e.g. in the pairing/info panel)                                                                                                                                                                                                                                                                                                               | Standard MIT requirement — keep the notice reachable                                                                                                                                                                                                                                                                                                                                                                        |

### Known hard limits to accept up front (not bugs — physics and measured library behavior)

- **It's audible.** Both people will clearly hear a short chirp/tone during
  transmission. This is by design for v1 (Section 3) — set expectations in
  the UI, don't apologize for it.
- **Range is a few meters in a reasonably quiet room.**
- **~33 bytes/sec effective payload throughput at best** — this is a
  short-notes medium, not a live messenger. The UI must show real progress.
- **The codec module can permanently die for the rest of the page session**
  if misused in specific ways (an empty payload, or an invalid instance id).
  Our code must never trigger these, and must detect and offer a clean
  "restart Sound Chat" recovery path if it somehow happens anyway.
- **Anyone else's microphone in the room can record the raw transmission.**
  This is inherent to any acoustic channel. It's an accepted, documented
  limit — the point of encryption is that the _content_ stays protected even
  though the _transmission itself_ is not private.

## 4. Wire format (locked)

Each transmission is exactly one 64-byte fixed-length ggwave block:

```
byte 0       : version (1 byte)
bytes 1-2    : msgId (2 bytes) — for dedupe and ACK matching
byte 3       : fromPeerId (1 byte) — which side sent this
byte 4       : len (1 byte) — length of the real ciphertext before padding
bytes 5-N    : AEAD ciphertext + 16-byte auth tag
remaining    : zero-padded to fill 64 bytes
```

- Usable plaintext per block: **~39 bytes** after the 5-byte header and
  16-byte AEAD tag are subtracted from 64.
- Messages longer than one block use a `seq` scheme across multiple blocks
  (finalize the exact multi-block header shape in Phase 2 — the single-block
  shape above is locked, the multi-block extension is not yet).
- A dedicated small frame type (same 64-byte block, distinguished by a
  reserved value in a header field) is used for ACKs, so acknowledgment
  travels over the same channel and turn-taking discipline.
- A failed AEAD tag verification on receipt is treated exactly like "nothing
  decoded yet" — log it, don't render it, let the sender's own ACK-timeout
  drive a retry.

## 5. Workflow rules for every session

1. **Read this whole file first**, in chunks if needed, start to end. Then
   read `prompts/sound-chat/SOUND_CHAT_LOG.md` start to end (create it on
   Phase 0 if it doesn't exist) — the single running log, append-only, never
   rewritten. Same discipline as the codebase audit and the ggwave deep dive:
   dense bullets, file:line citations, verify rather than trust.
2. **Implement exactly one phase.** Do not start the next phase even with
   context budget left — stop, log, hand off.
3. **Verification battery before declaring a phase done:**
   - `pnpm exec tsc --noEmit` (root)
   - `cd worker && pnpm exec tsc --noEmit` (must show **zero diff** — proves
     the "don't touch the worker" constraint held)
   - `pnpm test` (root) — all existing tests green, plus new ones
   - `pnpm run lint` and `pnpm run lint:anti-slop`
   - `pnpm run build`, and confirm via the build output that the vendored
     codec is in its own lazy-loaded chunk, not the main bundle
   - `git diff --stat` reviewed by the agent to confirm only Section-6
     approved files changed
4. **Stop and ask** if a fix or design choice needs a human tradeoff decision.
5. **Every session ends by appending to the log** with: what was done, exact
   files touched, test/lint/build results (numbers, not vibes), bugs found and
   their status, open questions — then a ready-to-paste kickoff prompt for the
   next session, delivered **in the chat, never written into the log**.
6. **Dead code, unused exports, and TODOs are findings, not silence.**
7. **Always measure fresh — never quote a prior session's numbers as current.**
   This repo's own history (found in the codebase audit) has multiple old
   prompt docs quoting mutually inconsistent test counts (`133/133`, `107/107`,
   `100/100`, `37 tests`, `147 passing` — all claimed as "current" at different
   points, none reliably true anymore). `SOUND_CHAT_LOG.md` must not repeat
   this: every session re-runs the verification battery itself and logs the
   exact numbers it personally observed, never a number copied from an
   earlier log entry.
8. **No WebRTC, STUN, or TURN — ever.** The original HUSK spec explicitly
   rejected these for reliability reasons; Sound Chat's pure Web
   Audio/getUserMedia approach already complies, and no future addition to
   this feature may introduce them without that constraint being revisited
   with the human first.
9. **Kickoff prompts live in the chat, never in the log.** Each session ends by
   delivering the next phase's kickoff prompt to the human directly;
   `SOUND_CHAT_LOG.md` records work and evidence only.
10. **Pending work first.** A session that inherits unfinished work from a
    previous session completes that work before starting its own phase, and
    records in the log what was pending and what was done about it.
11. **Never assume — verify first.** Every claim a session builds on (this
    plan, the deep dive, the log, a handover note, a library's documented
    behaviour) is re-executed or re-measured in that session before it is
    relied on; anything that cannot be verified is logged as an open question,
    not treated as fact.

### Kickoff prompt template

```
Read /prompts/sound-chat/SOUND_CHAT_MASTER_PLAN.md in full, start to end (in
chunks if needed). Then read /prompts/sound-chat/GGWAVE_DEEP_DIVE.md if you
haven't already internalized it, and /prompts/sound-chat/SOUND_CHAT_LOG.md in
full, start to end. Do not trust the log blindly — verify current repo state
against its claims before continuing (re-run the verification battery).

Implement Phase [N]: [phase name] as specified in the master plan.
Do not start Phase [N+1].
Follow the non-negotiable constraints and the file ownership map exactly.
Run the full verification battery before declaring done.
Append your results to SOUND_CHAT_LOG.md (append only) and end by giving me
the next kickoff prompt for Phase [N+1] — in the chat, never inside the log.
```

---

## 6. File/folder ownership map

**New (fully owned by this feature):**

- `src/routes/sound-chat.tsx`
- `src/components/sound-chat/**`
- `src/lib/sound-chat/**` including `src/lib/sound-chat/vendor/ggwave.js`
  (vendored artifact, hash recorded in the log) and a co-located `LICENSE`
  or attribution note file
- `prompts/sound-chat/**` (this plan, the deep dive, the running log)

**Edited (minimal, explicit diffs only, logged every time):**

- `src/routes/index.tsx` — exactly one new `Button` + navigation
- `src/server.ts` — exactly: `'wasm-unsafe-eval'` added to `script-src`, and
  optionally a `Permissions-Policy: microphone=(self)` header. Nothing else.

**Off limits (do not touch, do not "clean up," do not refactor):**

- `worker/**` (all of it)
- `src/lib/husk/**`, `src/components/husk/**`
- `src/routes/r.$roomId.tsx`, `src/routes/__root.tsx` (unless a genuinely
  required global registration is discovered — stop and ask first)
- `src/routeTree.gen.ts` (auto-generated — never hand-edit)
- Anything under `tools/`, `.agents/`, `e2e/`, `live-tests/`
- `package.json` — **no edit needed**, since the codec is vendored, not
  installed as a dependency

**Immediate hygiene item (do this first, before anything else):**

- The `ggwave` research clone's ignore entry in `.gitignore` is currently an
  **uncommitted** edit (confirmed in the deep dive). Commit that single-line
  `.gitignore` change immediately, before any other work, so the ~11MB
  research clone can never be accidentally staged.

---

## 7. Detailed phase specs

### Phase 0 — Integration Spike (research is done; this is hands-on verification)

The deep-dive research phase is complete (`GGWAVE_DEEP_DIVE.md`). This phase
is a small, disposable spike to prove the locked decisions actually work
before real feature code is built on top of them. ≤1 day of work.

1. Commit the `.gitignore` hygiene fix (Section 6).
2. Vendor the clone's newer `bindings/javascript/ggwave.js` into
   `src/lib/sound-chat/vendor/ggwave.js`; record its SHA-256 in the log.
3. Add `'wasm-unsafe-eval'` to `src/server.ts`'s CSP `script-src`. Confirm the
   module actually loads (no CSP violation) in Chrome, Safari, and Firefox.
4. Create two instances (Tx-only, Rx-only), call `rxToggleProtocol` to enable
   only `AUDIBLE_FASTEST`, set `payloadLength = 64`, call `disableLog()` on
   both. Confirm a round trip: encode a small payload → decode it back
   correctly, in-process (no real audio hardware needed for this step).
5. **Automated pipeline validation via Chromium's fake-audio-capture
   injection — no physical hardware involved.** Chromium supports feeding a
   WAV file as the browser's "microphone" via launch flags
   (`--use-fake-device-for-media-stream`, `--use-fake-ui-for-media-stream`,
   `--use-file-for-fake-audio-capture=<path>.wav`). Playwright (already in
   this repo's stack) can launch Chromium with these flags directly. Build a
   test harness that:
   - Uses the real `codec.ts`/`audio-io.ts` encode path to generate the raw
     samples for a test payload, writes them to a WAV file.
   - Launches a real (non-headless-shell, since fake-audio-capture needs the
     full Chromium build) Chromium instance via Playwright with that WAV as
     the fake mic input, loads the real Sound Chat capture pipeline, and
     asserts the decoded output matches the original payload exactly.
   - This exercises the actual `getUserMedia` → `AudioContext` →
     `ScriptProcessor` → codec → protocol/crypto stack end to end — the real
     software risk surface — without needing a phone.
6. **Build a simulated acoustic degradation matrix** by applying synthetic
   impairments to the WAV before feeding it in as the fake mic input, and
   re-run the harness against every variant:
   - White/pink noise injected at a range of SNR levels, down to and past the
     point where decode should fail gracefully (confirms the AEAD-tag
     failure path activates instead of returning garbage)
   - Clipping (simulate a maxed-out phone speaker) and heavy gain reduction
     (simulate a quiet one)
   - Random short dropout segments zeroed out (simulate capture buffer
     glitches)
   - The WAV trimmed to start mid-transmission at several different offsets
     (simulates our `ScriptProcessor`'s fixed 1024-sample chunk boundaries
     never aligning with when the real transmission actually started — a
     realistic and easy-to-miss case)
   - A mild resample-and-resample-back pass (simulates a device whose actual
     hardware rate isn't a clean 48000Hz)
     Each variant gets a pass/fail/graceful-fail recorded in the log — this
     _is_ the harsh testing pass for the codec layer, done entirely in
     software.
7. **Fuzz the round trip.** Generate hundreds of random valid-length payloads
   (including boundary lengths: empty-after-header, exactly 39 bytes, exactly
   the 2-block cap) and run each through encode → decode with no impairment,
   then again through a couple of the degradation variants above. Any
   mismatch is a bug, not an accepted flake.
8. Confirm the build output puts the vendored codec in its own chunk (test a
   dynamic `import()` wrapper now, even before any real UI consumes it) —
   fully agent-verifiable, no external input needed.

**Note on real acoustic transduction:** the fake-audio-capture technique
above validates every layer of _our_ software rigorously, but it necessarily
bypasses the actual physical transduction through a real speaker into a real
microphone through real air (frequency response rolloff, real room acoustics,
genuinely unpredictable ambient noise, real device firmware quirks). That
physical check is out of scope for these engineering phases — see the note
at the end of Section 8.

**Do not write any Sound Chat feature code beyond this spike scaffold.**

### Phase 1 — Core transport module

- **First, close out the Phase 0 pending items** recorded in
  `SOUND_CHAT_LOG.md` under "Pending from Phase 0 — Phase 1 must complete
  these first": the CSP/artifact decision (blocker) with its harness test
  flipped to the chosen reality, the lint-scope decision, the `?url`-asset
  confirmation in the app build, and the 44100 Hz `AudioContext` guard. These
  are measured blockers from the spike, not optional clean-up.
- `audio-io.ts`: `AudioContext` lifecycle (created lazily on a user gesture —
  iOS requires this), mic permission wrapper with granted/denied/unsupported
  states, `createScriptProcessor(1024, 1, 1)` capture feeding the Rx instance
  one chunk at a time with an immediate drain after each chunk (never
  accumulate into a large buffer before decoding — confirmed necessary),
  playback via `AudioBufferSourceNode`, full teardown on unmount (mirror the
  WebGL cleanup discipline in `Grainient.tsx`), explicit `track.stop()` on all
  media tracks (the reference implementation famously leaks this), Page
  Visibility handling.
- `codec.ts`: thin wrapper around the two held ggwave instances (Tx-only,
  Rx-only) from the locked Phase-0 config. Hard-codes every defensive rule
  from the deep dive:
  - Guard `id >= 0` after every `init()`; never call `encode`/`decode` on a
    negative id.
  - Never call `encode()` with an empty payload (measured: traps the module).
  - **Copy every returned typed-array view immediately**
    (`Uint8Array.from(view)`) — views alias static buffers and are silently
    detached on the next wasm memory growth.
  - Wrap every codec call in try/catch; treat any thrown/rejected call as
    "the module died" and surface a distinct, recoverable UI error state
    (offer to restart Sound Chat / reload), not a generic crash.
  - Pause the Rx instance's mic feed for the exact duration of our own
    transmission (prevents self-reception).
- `transport-machine.ts`: a pure state machine (same discipline as
  `src/lib/husk/room-machine.ts`) covering at least: idle, listening,
  transmitting, awaiting-turn/ack, collision-backoff, module-error
  (unrecoverable — offer restart), error.
- Tests: mock `AudioContext`/`getUserMedia`/the codec wrapper for the I/O
  layer; exhaustively unit test the pure state machine (happy path + every
  illegal transition asserted as a no-op, mirroring
  `room-machine.test.ts`'s style).

### Phase 2 — Protocol, pairing, encryption

- `protocol.ts`: implement the locked wire format from Section 4 exactly —
  single-block message/ACK frames now, plus the multi-block `seq` extension
  for messages over ~39 bytes of plaintext (up to the 2-block cap).
- `crypto.ts`: key derivation (PBKDF2 or better — pick and justify in the
  log) from the manually-entered pairing code, AES-256-GCM per block with a
  fresh nonce (the codec's waveforms are deterministic and trivially
  replayable — confirmed — so the nonce/counter discipline here is what
  prevents replay, not anything in ggwave).
- `pairing.ts` + pairing UI logic: one device generates and displays a short
  code, the other enters it, both derive the same key locally, an actual
  short acoustic round-trip confirms pairing before the chat screen unlocks.
- ACK/retry/dedupe: mirror `src/lib/husk/store.ts`'s pattern (`localId`, ack
  timeout, retry reuses the same id, `sending → sent → failed`), timeouts
  scaled to real per-block transmit time (~2s/block), not the network's fixed
  10s. Dedupe inbound blocks by `msgId` (confirmed necessary — the codec
  redelivers the same block 2-4 times by design).
- A failed AEAD tag is treated exactly like "nothing decoded" — never
  rendered, never surfaced as corruption to the user; it just lets the
  sender's normal ack-timeout retry handle it.

### Phase 3 — UI integration

- `src/routes/sound-chat.tsx` using only `primitives.tsx` components and
  semantic design tokens.
- The one approved edit to `src/routes/index.tsx`: a second `Button`.
- Pairing screen (generate/display code, enter code, waiting/confirmed
  states) using `Modal`/`Panel`.
- Permission pre-prompt screen explaining _why_ mic access is requested.
- Composer with a live character counter against the 2-block cap (~60-70
  chars) and a real estimated transmit time (~2s for 1 block, ~4s for 2).
- Explicit, on-brand UI for every state: transmitting (real progress, not a
  lying spinner), listening, mic denied, browser unsupported, pairing
  mismatch, collision detected, and the "module died — restart Sound Chat"
  recovery state from Phase 1.
- A one-line MIT attribution notice for ggwave, reachable from the pairing or
  info panel.
- The one approved `src/server.ts` edit from Section 3/6, with the exact diff
  documented in the log.
- Copy throughout says "plays a short sound" / "makes an audible tone" — never
  "silent" or "inaudible."

### Phase 4 — The Gauntlet (mandatory adversarial hardening loop)

A loop, not a checklist — keep cycling until a clean pass.

**Loop:** brainstorm scenarios → write an automated test where feasible, a
manual `live-tests/`-style script where it isn't → run it → any failure gets
fixed and the **entire** verification battery re-run, not just the new test →
log with CRITICAL→HIGH→MEDIUM→LOW severity (same convention as `FINDINGS.md`)
→ repeat until everything passes or a remaining issue is explicitly accepted
and documented as a by-design limit.

**Seed scenarios (expand this list — don't treat it as exhaustive):**

- _Codec fragility (new from the deep dive)_: trigger the empty-payload trap
  and the invalid-instance-id abort deliberately in a test harness — confirm
  our guards actually prevent both from ever reaching the real codec calls;
  confirm the "module died" recovery UI actually appears if one somehow slips
  through; confirm a long session's wasm memory growth doesn't silently
  detach a view we're still holding.
- _Dedupe/collision_: confirm the same block decoded 3-4 times renders as one
  message; confirm two devices transmitting in the same instant is detected
  and handled by the collision-backoff state, not silently corrupted audio.
- _Self-reception_: confirm pausing the Rx feed during our own transmission
  actually prevents self-decode (test with real hardware, not just logic).
- _Acoustic environment (via the Phase 0 fake-audio-capture harness + degradation matrix, extended)_: loud ambient noise/music mixed into the WAV at multiple SNR levels; simulated other-session cross-talk by overlaying a second encoded transmission; very different simulated device volume levels (gain variants); simulated muted/near-silent input with no decode and confirmation the UI shows a clear "nothing received" state, not a hang.
- _Hardware/OS_: iOS Safari's user-gesture requirement for `AudioContext`; a
  phone call interrupting audio mid-transmission; backgrounding pausing
  capture; tab throttling when unfocused; sample-rate mismatch between two
  different devices (confirm 48000/1024 discipline holds).
- _Security_: wrong/mistyped pairing code fails closed with a clear message,
  never a crash or silent wrong-key state; replay of a captured transmission
  is rejected via the nonce/msgId discipline; someone else's device
  recording the audible tones is accepted as an inherent, documented limit
  (the point is the content stays encrypted).
- _UX/human error_: leaving mid-transmission; refreshing mid-session; empty
  or exactly-at-cap messages; pasting emoji/non-Latin scripts.
- _Build/ops_: confirm the vendored artifact's hash still matches on a fresh
  checkout (tamper/corruption check); confirm the codec chunk is genuinely
  lazy-loaded (main bundle size unchanged) and the MIT attribution is
  actually reachable in the shipped UI.
- _Resource/performance_: long-running session memory growth (`AudioContext`
  nodes, listeners, timers all torn down correctly); many rapid short
  messages in sequence.

### Phase 5 — Final polish & sign-off

- QA matrix, prioritized by actual usage: **Chrome/Edge on Android is the
  primary target and the one that must be flawless.** Desktop Chrome/Firefox
  (via Playwright, agent-verifiable) as a secondary sanity check. Safari/iOS
  is explicitly out of scope for this feature's QA bar — not because it's
  unsupported in principle, but because it isn't the target platform and
  isn't worth spending phases hardening against.
- Accessibility pass: `aria-live` on transmit/listen state changes, focus
  management through the pairing modal, keyboard operability throughout.
- Full verification battery green; `git diff --stat` confirms only
  Section-6-approved files were ever touched across all phases; MIT
  attribution present and correct; vendored artifact hash matches the log.
- Final log entry summarizing the whole feature's state and any accepted
  limitations.

---

## 8. Production sign-off checklist (the real final gate)

This gathers every scattered requirement from Sections 2–7 into one list.
Phase 5 is not "done" until every box here is checked and the log shows the
actual evidence (a number, a screenshot description, a test name) — not just
a checkmark.

**Isolation & safety (does this actually leave existing HUSK alone?)**

- [ ] `git diff --stat` across the _entire_ feature's history touches only
      the files listed in Section 6 — nothing else, ever
- [ ] `cd worker && pnpm exec tsc --noEmit` shows zero diff from before this
      feature started
- [ ] All pre-existing root and worker tests still pass, counted fresh
      (per Rule 7) — not assumed from an earlier phase's log entry
- [ ] `src/server.ts` diff is exactly the CSP `'wasm-unsafe-eval'` addition
      (+ optional `Permissions-Policy`) — nothing broader
- [ ] No WebRTC/STUN/TURN anywhere in the feature (Rule 8)
- [ ] No emoji anywhere in Sound Chat's UI copy or source

**Codec correctness (does it actually work, per the deep dive's findings?)**

- [ ] Vendored artifact hash matches the one recorded in Phase 0's log entry
      on a completely fresh checkout
- [ ] Fixed-length 64-byte blocks only; no variable-length code path exists
- [ ] Exactly 2 instances ever exist (Tx-only, Rx-only) — never more,
      confirmed via the Section 3 instance-ceiling constraint
- [ ] Every codec call is guarded (id ≥ 0, non-empty payload, try/catch) and
      a "module died" recovery UI path exists and was actually triggered and
      verified in the Gauntlet, not just written defensively and never tested
- [ ] Every returned typed-array view is copied immediately, verified via a
      test that forces a wasm memory-growth event mid-session
- [ ] Dedupe by `msgId` verified against a real 2–4x duplicate decode, not
      just unit-tested against a mocked single decode

**Reliability (does it survive realistic conditions, validated in software?)**

- [ ] The Phase 0 fake-audio-capture harness exists and runs against the full
      degradation matrix (noise/SNR sweep, clipping, gain, dropouts, chunk
      misalignment, resample artifacts) with every result logged
- [ ] Fuzz round-trip suite (hundreds of random payloads, boundary lengths)
      passes clean and against degraded variants
- [ ] Self-reception (own transmission being picked up by own mic) tested and
      confirmed prevented, via the harness feeding a self-generated WAV back
      in during a simulated "own transmission in progress" state
- [ ] Collision handling (both sides send at once) tested and confirmed
      non-corrupting, via two overlapping WAV inputs
- [ ] Every Phase 4 seed scenario has a logged outcome — pass, fixed, or
      explicitly accepted as a by-design limit — none silently skipped

**Security**

- [ ] Pairing code is never transmitted over the acoustic channel itself
- [ ] Wrong/mistyped pairing code fails closed with a clear message
- [ ] Replay of a captured transmission is rejected (nonce/msgId discipline
      verified with an actual replay attempt in a test, not just designed for)
- [ ] A failed AEAD tag is confirmed to render as "nothing received," never
      as visible corrupted plaintext

**Production serving**

- [ ] Vendored `.wasm`/`.js` confirmed served under `/assets/*` with the
      existing immutable long-cache header, correct `application/wasm`
      content type
- [ ] Build output confirms the codec is in its own lazy-loaded chunk — main
      bundle's gzipped size is unchanged from before this feature (compare
      against the ~95.75 KB baseline noted in the audit)
- [ ] `public/sw.js` unmodified; `/sound-chat` navigation and asset caching
      behave as predicted (verified, not assumed) with no offline surprises

**UX & accessibility**

- [ ] Every state (transmitting, listening, denied, unsupported, pairing
      mismatch, collision, module-died) has real on-brand UI, verified by
      triggering each one, not just coded
- [ ] All copy says "plays a short sound" / "audible tone" — no "silent" or
      "inaudible" language anywhere
- [ ] MIT attribution for ggwave is reachable in the shipped UI
- [ ] `aria-live` on transmit/listen state changes; full keyboard operability
      through pairing and chat; matches the design-token/primitive rules in
      Section 2

If every box above is checked with real evidence in the log, the feature is
production-ready. If any box can't be checked, it goes back to the relevant
phase — Phase 5 does not get to accept known gaps quietly.

**Note on real-device acceptance testing:** everything above is validated in
software — real Chromium, real WASM, real `getUserMedia` code paths, but
synthetic audio input rather than actual sound traveling through real air
between two physical phones. That final check — does this actually work when
you play it out loud on your own Android phones in your own room — is
intentionally **not** a gate in these engineering phases. It happens once,
after deployment, done by you on real hardware. If it surfaces something odd,
report it back and it becomes a scoped follow-up fix (a new, focused prompt
against the already-hardened codebase), not a reason to reopen the whole
build.

---

## 9. Phase 0 kickoff prompt (ready to paste now)

```
Read /prompts/sound-chat/SOUND_CHAT_MASTER_PLAN.md in full, start to end (in
chunks if needed — do not skim). Also read
/prompts/sound-chat/GGWAVE_DEEP_DIVE.md in full if you have not already —
every architecture decision in the master plan is backed by findings in that
document and you need the underlying reasoning, not just the conclusions.

There is no SOUND_CHAT_LOG.md yet — create
/prompts/sound-chat/SOUND_CHAT_LOG.md as you go, appending incrementally, same
discipline as the deep dive: dense bullets, file:line citations, verify
rather than trust.

Implement Phase 0 (Integration Spike) exactly as specified in the master
plan's Section 7: commit the .gitignore hygiene fix first, vendor the ggwave
artifact, make the one CSP edit, and prove the round trip works in-process.

Then build the Chromium fake-audio-capture Playwright harness described in
the master plan (steps 5-7): feed real encoder output, and degraded variants
of it (noise/SNR sweep, clipping, gain, dropouts, chunk-boundary
misalignment, resample artifacts), into a real Chromium instance as the fake
microphone input, and assert the real capture-to-decode pipeline handles
each correctly or fails gracefully. Also run the fuzz round-trip suite. This
is fully automatable — do not stop to ask for physical hardware access; you
have everything you need to do this yourself. Iterate until the harness is
genuinely thorough and everything passes or has a logged, justified
exception.

Do not write any Sound Chat feature code beyond this spike scaffold and the
test harness itself.

Follow every non-negotiable constraint and the file ownership map in the
master plan exactly. Do not touch worker/**, src/lib/husk/**, or
src/components/husk/** under any circumstance. The only existing-file edits
allowed in this phase are the .gitignore line and the single CSP addition in
src/server.ts — nothing else.

Run the verification battery from Section 5 before declaring the phase done
(confirm zero diff in worker/).

End by appending your findings to SOUND_CHAT_LOG.md and giving me the
Phase 1 kickoff prompt, filled in from the template in the master plan.
```
