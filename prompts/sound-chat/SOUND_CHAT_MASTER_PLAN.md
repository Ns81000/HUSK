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
2. **Edits to existing files are restricted to the following explicit approvals** (full ownership map in
   Section 6): one new button in `src/routes/index.tsx`; one precise,
   minimal edit to `src/server.ts`'s CSP (`'wasm-unsafe-eval'` in
   `script-src`, and optionally a `Permissions-Policy: microphone=(self)`
   header); the lint-ignore entries for vendored/generated Sound Chat scope in
   `eslint.config.js` (Phase 1 decision, already applied); and provenance
   updates in `src/lib/sound-chat/vendor/NOTICE.md`. No other existing file changes.
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

| Decision                     | Choice                                                                                                                                                                                                                                                                                                                                                                                                                             | Why (deep-dive reference)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Codec                        | **ggwave**, vendored                                                                                                                                                                                                                                                                                                                                                                                                               | Proven FSK + Reed-Solomon; not reinventing DSP                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| Codec artifact source        | **Vendor the clone's newer prebuilt `bindings/javascript/ggwave.js`** (SHA-256 `F4BD5E9E…`) into `src/lib/sound-chat/vendor/ggwave.js`. **Do not** `pnpm add ggwave` from npm.                                                                                                                                                                                                                                                     | npm's published build is a 4-year-old (2022) artifact missing protocol features, and it calls `new Function` at load — which would force `'unsafe-eval'` into our CSP. The newer clone artifact has no textual `new Function`, but its embind glue compiled one invoker per binding through the global `Function` constructor — so it needs the narrower `'wasm-unsafe-eval'` **plus** the documented option-b invoker patch. Provenance, upstream hash, and the current patched hash live in `src/lib/sound-chat/vendor/NOTICE.md`, the authority for artifact identity. |
| Transmission mode            | **Fixed-length, 64-byte blocks. No variable-length mode, ever.**                                                                                                                                                                                                                                                                                                                                                                   | Variable-length adds a 683ms marker tax, an unrecoverable 13–38 second "stuck receiving" window with no JS-exposed cancel, and an 8MB memory buffer we don't need. Fixed-length is cheaper, faster per byte, and never gets stuck                                                                                                                                                                                                                                                                                                                                         |
| Protocol                     | **`AUDIBLE_FASTEST` for v1. No ultrasound in v1.**                                                                                                                                                                                                                                                                                                                                                                                 | Ultrasound has two long-standing, unresolved browser-specific bugs (Safari cannot receive it at all; other browsers fail to receive it via JS even when the native app works on the same device) — confirmed against the live upstream issue tracker. Audible has no such problems. (Ultrasound may be revisited later as an experimental opt-in with a self-test, per the product decision already made — not in v1 scope)                                                                                                                                               |
| DSS mode                     | **Never enable.**                                                                                                                                                                                                                                                                                                                                                                                                                  | Zero wire-speed benefit, zero security/obfuscation value (it's a public, hardcoded XOR mask), and upstream's own tests disable it for exactly this reason                                                                                                                                                                                                                                                                                                                                                                                                                 |
| Duplex mode                  | **Half-duplex, turn-based** (unchanged from Rev. 1)                                                                                                                                                                                                                                                                                                                                                                                | Confirmed necessary: transmitting resets the codec's own receiver state on a shared instance, and our own speaker output would otherwise be picked up by our own mic                                                                                                                                                                                                                                                                                                                                                                                                      |
| Instances                    | **Two ggwave instances held for the whole session**: one Tx-only, one Rx-only. Never re-`init()` per message.                                                                                                                                                                                                                                                                                                                      | `init()` allocates ~13–22MB; re-initializing per message is wasteful and unnecessary. A shared instance's `encode()` call resets its own receive state, so Tx and Rx must be separate instances                                                                                                                                                                                                                                                                                                                                                                           |
| Instance ceiling             | **Hard cap of 4 live instances per loaded module — never approach it.** We use exactly 2 (Tx+Rx) for the whole session. Any future design that creates instances per-message or per-tab must re-check this ceiling first.                                                                                                                                                                                                          | Confirmed in the deep dive; exceeding it is one of the module-killing misuses alongside the empty-payload and invalid-id traps                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| Rx optimization              | **`rxToggleProtocol()` to enable exactly one protocol (`AUDIBLE_FASTEST`) before `init()`.** Call `disableLog()` on both instances.                                                                                                                                                                                                                                                                                                | Measured ~5x cheaper decode (135ms → 27ms per 20 calls) and fewer false positives versus leaving all 12 protocols enabled                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| Message integrity            | **Our own AEAD tag is the only integrity signal that exists.** The codec cannot distinguish "silence" from "corrupted transmission" in JavaScript — both return an empty result.                                                                                                                                                                                                                                                   | Confirmed: the underlying failure signal exists in the C++ layer but isn't exposed to JS at all. A failed AEAD tag verification must be treated exactly like "nothing received yet"                                                                                                                                                                                                                                                                                                                                                                                       |
| Dedupe                       | **By our own `msgId` in the payload header.** The codec re-decodes the same audio block 2–4 times as it streams through a sliding window — this is normal, expected behavior, not a bug to work around at the codec level                                                                                                                                                                                                          | Measured directly; the codec does no dedupe of its own                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| Retransmission               | **ACK-based, over the half-duplex turn cycle** (mirrors the existing chat's `localId`/ack-timeout/retry pattern) rather than blind repeated sends                                                                                                                                                                                                                                                                                  | Fits naturally with the half-duplex design already chosen; more efficient than blind repetition, and we already have a proven pattern to mirror                                                                                                                                                                                                                                                                                                                                                                                                                           |
| Self-reception               | **Pause the Rx instance's mic feed for the duration of our own transmission** (same technique the official ggwave browser demo uses)                                                                                                                                                                                                                                                                                               | Prevents decoding our own speaker output; simpler and more reliable than trying to filter it out after the fact                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| Wire format                  | See Section 4 below — 64-byte blocks, `ver\|msgId\|fromPeerId\|len\|ciphertext+AEAD tag`, padded                                                                                                                                                                                                                                                                                                                                   | Maximizes usable payload within the fixed 64-byte block while leaving room for the AEAD tag that carries our only integrity signal                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| Encryption                   | AES-256-GCM (or ChaCha20-Poly1305), key from a manually-typed pairing code (unchanged from Rev. 1)                                                                                                                                                                                                                                                                                                                                 | —                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| Message length               | **Cap at 2 blocks (~70 usable bytes / roughly 60–70 ASCII characters), ~3.9 seconds total transmit time on AUDIBLE_FASTEST.** Single very short messages fit in 1 block (~1.9s).                                                                                                                                                                                                                                                   | Recomputed from the deep dive's measured per-block timing — significantly faster and more predictable than the earlier variable-length estimate                                                                                                                                                                                                                                                                                                                                                                                                                           |
| Persistence                  | None — in-memory only (unchanged)                                                                                                                                                                                                                                                                                                                                                                                                  | Matches HUSK philosophy                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| Backend involvement          | None — 100% client-side (unchanged)                                                                                                                                                                                                                                                                                                                                                                                                | —                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| CSP change                   | Add `'wasm-unsafe-eval'` to `script-src` in `src/server.ts`. **Not** `'unsafe-eval'`.                                                                                                                                                                                                                                                                                                                                              | Required for `WebAssembly.instantiate` to run under HUSK's current CSP; confirmed via both spec behavior and direct inspection of the vendored artifact                                                                                                                                                                                                                                                                                                                                                                                                                   |
| COOP/COEP                    | **None needed.**                                                                                                                                                                                                                                                                                                                                                                                                                   | Confirmed: zero `SharedArrayBuffer`/pthread usage in either build artifact                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| Permissions-Policy           | Optional defense-in-depth: `microphone=(self)`. Not required — no policy exists today so mic access is currently unrestricted anyway.                                                                                                                                                                                                                                                                                              | —                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `media-src` CSP              | **Not needed.** WebAudio `AudioBufferSourceNode` playback isn't governed by `media-src`; only relevant if we later adopt `<audio>`/blob playback or AudioWorklet                                                                                                                                                                                                                                                                   | —                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| Bundle strategy              | **Lazy-load the vendored codec via dynamic `import()` behind the Sound Chat route/button only.** Never in the main bundle.                                                                                                                                                                                                                                                                                                         | The codec adds ~60KB gzipped — comparable to HUSK's entire current app bundle (~95KB gzipped). This must be an isolated chunk                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| Static-asset serving/caching | **Verify, don't assume:** the vendored `.wasm`/`.js` artifact must be emitted by Vite under `/assets/*` so it automatically inherits the existing `public/_headers` rule (`public, max-age=31536000, immutable`) and is served with the correct `application/wasm` content type by the Workers runtime.                                                                                                                            | Re-checked against the audit's `[09]` findings: `public/_headers` already has a working immutable-cache rule for `/assets/*` — we want the codec to fall under it for free, not invent new header rules                                                                                                                                                                                                                                                                                                                                                                   |
| Service worker               | **No changes needed, and `public/sw.js` stays off-limits.** `sw.js` already treats `/assets/*` as cache-first and leaves every other navigation (besides `/`) network-only — the same behavior `/r/<id>` already relies on. `/sound-chat` will behave the same way automatically: not available offline on first visit (needs the network once to fetch the code), but the acoustic transport itself needs no network once loaded. | Confirmed hand-written `sw.js` has no Workbox/build-time manifest to update, so there is no integration step here — but this must be verified empirically in Phase 0/5, not assumed                                                                                                                                                                                                                                                                                                                                                                                       |
| CI                           | **None exists in this repo** (no `.github/` workflows, confirmed in the audit) — all verification is manual and local before a manual `wrangler deploy`, same as the rest of the project. No CI setup is in scope for this feature.                                                                                                                                                                                                | Avoids inventing process this project doesn't use elsewhere                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| Capture technique            | `createScriptProcessor(1024, 1, 1)` (matches `samplesPerFrame`), fed to the Rx instance one chunk at a time, draining the result after every chunk — never accumulating into one large buffer before decoding                                                                                                                                                                                                                      | This is the only technique with real-world prior art in the ggwave ecosystem; `AudioWorklet` has zero prior art here and is deferred as a future improvement, not a v1 blocker                                                                                                                                                                                                                                                                                                                                                                                            |
| Sample rate / frame size     | **48000 Hz / 1024 samples are protocol constants — never change them.** Only `sampleRateInp`/`sampleRateOut` (device-side) may vary; the codec resamples internally.                                                                                                                                                                                                                                                               | Both peers must agree on these or nothing ever decodes — this is undocumented upstream and easy to break "by optimizing"                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| License                      | MIT (ggwave). Requires a reachable attribution notice in the UI (one line is enough, e.g. in the pairing/info panel)                                                                                                                                                                                                                                                                                                               | Standard MIT requirement — keep the notice reachable                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |

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

### Post-Phase-1 accuracy notes (independent verification pass, 2026-09-20)

These repair statements in Section 3 that the completed phases made stale or
imprecise. They do not reopen any locked decision; the CSP question in
particular stays closed (option (b), patched artifact — see
`src/lib/sound-chat/vendor/NOTICE.md` and the log).

- **Codec artifact source row**: what ships is the vendored prebuilt artifact
  **plus the recorded CSP patch**, so the file's SHA-256 is the patched hash
  (`B097B329…577F`, 147,139 bytes), not the clone's unpatched `F4BD5E9E…`. The
  clone's `F4BD5E9E…` remains the provenance of the bytes the patch was derived
  from. A test now asserts the patched size and hash against `NOTICE.md`.
- **CSP row**: unchanged and still accurate — `'wasm-unsafe-eval'` is present in
  `script-src` and `'unsafe-eval'` is not. Verified live: the harness prints
  `server-csp-has-unsafe-eval=false` and the codec encodes under the real CSP
  with zero `securitypolicyviolation` events.
- **Message-length row**: the "~70 usable bytes / 60–70 characters" figure stays
  a **pre-implementation estimate** until Phase 2 measures the real payload
  capacity of one and two blocks including `seq` overhead (Section 10.2 P10).
  Every document stating a byte/character budget must then agree with that
  measurement.
- **Also recorded here**: the verification pass amended two Phase 1 files
  (`audio-io.ts`, `codec.ts`) and one harness comment to close the defects it
  found. Those amendments are inside the Sound Chat namespace, are listed
  file-by-file in the log, and do not touch the locked configuration (two
  instances, `AUDIBLE_FASTEST`, fixed-length 64-byte blocks, 48000/1024).

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

- Usable plaintext per block: **43 bytes**, not the "~39" earlier revisions
  claimed — 64 minus the 5-byte header minus the 16-byte AEAD tag. Two blocks
  therefore carry ~86 bytes *before* the multi-block `seq` overhead, which
  Phase 2 measures and then records in every document that states a capacity
  (Section 10.2, P10).
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
   read `prompts/sound-chat/SOUND_CHAT_LOG.md` start to end — the single running
   log, append-only, never rewritten — and `prompts/sound-chat/GGWAVE_DEEP_DIVE.md`
   before relying on any finding attributed to it. Same discipline as the codebase
   audit and the ggwave deep dive: dense bullets, file:line citations, verify
   rather than trust. If this plan and the log materially disagree about phase
   status, scope, ownership, or past results, STOP and ask the human which record
   governs before editing implementation files.
2. **Implement exactly one phase.** Do not start the next phase even with
   context budget left — stop, log, hand off.
3. **Verification battery before declaring a phase done:**
   - `pnpm exec tsc --noEmit` (root)
   - `cd worker && pnpm exec tsc --noEmit` (must show **zero diff** — proves
     the "don't touch the worker" constraint held)
   - `pnpm test` (root) — all existing tests green, plus new ones
   - `pnpm run lint` and `pnpm run lint:anti-slop`
   - `pnpm run build`, and confirm via the harness build output that the vendored
     codec is its own `?url` asset, separate from the main JavaScript bundle;
     the codec reaches the browser through a classic `<script>` served under
     the existing `/assets/*` immutable header, not through the JavaScript
     module graph
   - Sound Chat regression coverage for the transport/codec layer:
     `pnpm exec vite build --config src/lib/sound-chat/harness/vite.config.ts`,
     then `pnpm exec playwright test --config
src/lib/sound-chat/harness/playwright.config.ts` (runs `pnpm dev` itself)
   - Sound Chat seam, guard and artifact-integrity coverage, in-process:
     `pnpm exec vitest run src/lib/sound-chat` — this includes the Section 10.3
     hostile-input set and the machine-checked artifact/doc assertions in
     `src/lib/sound-chat/provenance.test.ts`
   - `git diff --stat` reviewed by the agent to confirm only Section-6
     approved files changed
   - Independent commit-first verification: complete the phase work, commit it
     (including prompt/log edits current at that point), then run tests and
     builds, append their fresh results to `SOUND_CHAT_LOG.md`, commit the log
     separately, and push only after the branch is clean. Never stage test
     outputs, WAVs, probe scripts, or generated artifacts from this phase; the
     only approved tracked edits remain those listed in Section 6.
4. **Stop and ask** if a fix or design choice needs a human tradeoff decision.
5. **Every session ends by appending to the log** with: what was done, exact
   files touched, test/lint/build results (numbers, not vibes), bugs found and
   their status, open questions — then a ready-to-paste kickoff prompt for the
   next session, delivered **in the chat, never written into the log**. Do not
   use test-results probe scripts, patch drivers, or one-off build configs for
   final evidence unless those scripts are themselves deterministic and cited in
   the log; keep them out of commits.
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
   `SOUND_CHAT_LOG.md` records work and evidence only. Handoff prompts for the
   next agent must preserve the same scope, ownership, verification, commit,
   and plan/log reading requirements; a shorter prompt may not silently drop
   them.
10. **Pending work first.** A session that inherits unfinished work from a
    previous session completes that work before starting its own phase, and
    records in the log what was pending and what was done about it.
11. **Never assume — verify first.** Every claim a session builds on (this
    plan, the deep dive, the log, a handover note, a library's documented
    behaviour) is re-executed or re-measured in that session before it is
    relied on; anything that cannot be verified is logged as an open question,
    not treated as fact.
12. **Section 10 is binding on every remaining phase.** The defect classes in
    10.1, the crypto/protocol properties in 10.2, the hostile-input set in
    10.3 and the definition of done in 10.4 are not advice — a phase that
    cannot show them is not finished. Pass every phase's own new interface
    through the classes in 10.1 *before* logging the phase complete: a
    phase-boundary interface whose consumer does not exist yet (class 12) is
    exactly where Phase 0/1's defects hid.

### Kickoff prompt template

```text
Read /prompts/sound-chat/SOUND_CHAT_MASTER_PLAN.md in full, start to end (in
chunks if needed). Then read /prompts/sound-chat/SOUND_CHAT_LOG.md in full,
start to end, and /prompts/sound-chat/GGWAVE_DEEP_DIVE.md before relying on
any finding attributed to it. Do not trust the log, comments, prior handoffs,
or documentation blindly — verify current repo state against their claims
before continuing (re-run the verification battery, including the Sound Chat
codec/harness regression commands in Section 5, and measure everything
yourself).

Implement Phase [N]: [phase name] as specified in the master plan.
Do not start Phase [N+1].
Follow the non-negotiable constraints and the file ownership map exactly.
Run the full verification battery before declaring done, using the commit-first
workflow in Rule 3: commit phase work, then test/build/verify, then append
fresh log results, then commit the log and push.
Append your results to SOUND_CHAT_LOG.md (append only) and end by giving me
the next kickoff prompt for Phase [N+1] — in the chat, never inside the log.
```

---

## 6. File/folder ownership map

**New (fully owned by this feature):**

- `src/routes/sound-chat.tsx`
- `src/components/sound-chat/**`
- `src/lib/sound-chat/**` including the patched `src/lib/sound-chat/vendor/ggwave.js`
  (vendored artifact, provenance and both upstream plus patched hashes recorded in
  the adjacent `NOTICE.md`) and a co-located `LICENSE` or attribution note file
- `prompts/sound-chat/**` (this plan, the deep dive, the running log)

**Edited (minimal, explicit diffs only, logged every time):**

- `src/routes/index.tsx` — exactly one new `Button` + navigation
- `src/server.ts` — exactly: `'wasm-unsafe-eval'` added to `script-src`, and
  optionally a `Permissions-Policy: microphone=(self)` header. Nothing else.
- `eslint.config.js` — only the three Phase 1 lint-ignore entries for vendored
  or generated Sound Chat scope (`ggwave/**`, `test-results/**`, and the
  minified vendored artifact). No rule changes.
- `src/lib/sound-chat/vendor/NOTICE.md` — artifact provenance and hash updates
  only.

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

### Phase 0 — Integration Spike (completed and logged)

The deep-dive research phase is complete (`GGWAVE_DEEP_DIVE.md`). Phase 0 was
a small, disposable spike proving the locked decisions before real feature
code was built on them. Its acceptance state and pending handoff are recorded
in `SOUND_CHAT_LOG.md`; do not redo it, preserve its harness and regression
suites, and verify them fresh rather than treating old numbers as current.

1. Commit the `.gitignore` hygiene fix (Section 6).
2. Vendor the clone's newer `bindings/javascript/ggwave.js` into
   `src/lib/sound-chat/vendor/ggwave.js`; record its SHA-256 in the log.
3. Add `'wasm-unsafe-eval'` to `src/server.ts`'s CSP `script-src`. Confirm the
   module actually instantiates in Chrome (measured evidence); do not assert
   Safari/Firefox coverage unless actually executed.
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
8. Confirm the harness build emits the vendored codec as its own `?url` asset,
   separate from the main JavaScript bundle; the artifact reaches the browser
   through a classic `<script>`, not a dynamic JavaScript `import()`.

**Note on real acoustic transduction:** the fake-audio-capture technique
above validates every layer of _our_ software rigorously, but it necessarily
bypasses the actual physical transduction through a real speaker into a real
microphone through real air (frequency response rolloff, real room acoustics,
genuinely unpredictable ambient noise, real device firmware quirks). That
physical check is out of scope for these engineering phases — see the note
at the end of Section 8.

**Do not write any Sound Chat feature code beyond this spike scaffold.**

### Phase 1 — Core transport module (completed and logged)

- Phase 0 pending items were closed first (CSP/artifact option-b patch; lint
  scope; `?url` asset mechanism; 44100 Hz guard), and the results are recorded
  in `SOUND_CHAT_LOG.md`. Later phases preserve and re-verify that state rather
  than reopening it.
- `audio-io.ts`: `AudioContext` lifecycle (created lazily on a user gesture —
  iOS requires this), mic permission wrapper with granted/denied/unsupported
  states, `createScriptProcessor(1024, 1, 1)` capture feeding the Rx instance
  one chunk at a time with an immediate drain after each chunk (never
  accumulate into a large buffer before decoding — confirmed necessary),
  playback via `AudioBufferSourceNode`, full teardown on unmount, explicit
  `track.stop()` on all media tracks (the reference implementation famously
  leaks this), and Page Visibility handling.
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
- **Carried-in fixes from the verification pass — re-verify, do not
  reimplement.** The following are already applied and tested (log:
  "Independent verification pass"): the consumer-error boundary in
  `audio-io.ts` (a throwing callback no longer stops the feed or reports a dead
  module), the whole-frame guard in `codec.decode` (whole multiples of 1024 stay
  legal; a partial frame raises a usage error *outside* the module latch), the
  `bytesToFloat32` alignment precondition, rejection-handled `close()`, the
  removal of the dead `rxDurationFrames()`, and the machine-checked artifact
  test. Phase 2 must show these still hold after its own changes.
- **Every interface Phase 2 introduces must be passed through Section 10.1.**
  A new callback, a new state, a new parser entry point: nothing an application
  callback throws may stop the feed or latch anything off; every usage guard
  must leave `codec.state === "ready"`; every new mock must be able to throw,
  reject and return hostile shapes, with at least one test doing exactly that.
- **Satisfy and test every property in Section 10.2 (P1–P12)**: per-direction
  keys, no key+nonce reuse across reloads or sessions, AAD over the whole
  header, replay defeated by a *bounded* dedupe window, tag failure = nothing
  decoded, "heard but unreadable" distinguished from "silence", pairing code
  never acoustic, derivation arithmetic (entropy bits, iterations, salt) in the
  log, no secret ever logged or persisted, capacity measured not estimated,
  ACK/retry timing scaled to the measured transmit duration, all protocol state
  bounded.
- **Extend `transport-machine.ts` and its exhaustive transition-table test** if
  the protocol needs states or events Phase 1 did not define (collision
  detection, "heard but unreadable", per-frame send progress). Never infer new
  transport state from a scattered boolean.
- **Log the measured capacity arithmetic** and correct every document that
  states a byte or character budget (Section 4 and Section 3's message-length
  row must agree with the measurement).

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
- **Re-verify the Phase 1/2 interfaces against the real consumer before
  building on them (Section 10.1, class 12).** In particular the fatal-error
  callback: a codec-module failure and a broken frame contract must produce
  different, honest copy ("restart Sound Chat" vs "restart listening"), and a
  consumer error must be visible without killing the session.
- **Cover the whole Section 10.3 failure surface in the UI, not just the happy
  path**: mic denied / unsupported / wrong device rate; no peer heard; "a
  transmission was heard but this pairing code cannot read it"; ack timeout →
  retry → failure; collision; module died (really forced, not simulated);
  tab hidden mid-send; a message exactly at the measured cap.
- **Accessibility and honesty pass on every state**: `aria-live` on
  transmit/listen/error transitions, keyboard-only path through pairing and
  send, focus management, no emoji anywhere, and no copy that claims more than
  the protocol proves (Section 10.2, P7).

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
- _Build/ops_: confirm the vendored artifact's patched hash still matches on a
  fresh checkout (tamper/corruption check); confirm the codec asset is genuinely
  separate from the main JavaScript bundle (main bundle size unchanged) and the
  MIT attribution is actually reachable in the shipped UI.
- _Resource/performance_: long-running session memory growth (`AudioContext`
  nodes, listeners, timers all torn down correctly); many rapid short
  messages in sequence.
- _Seam classes from Section 10.1 — mandatory, not optional_: for every class,
  force the failure for real: an application callback that throws; a capture
  chunk that is not a whole frame; a teardown that runs twice against a real
  Chromium context; a `close()` that rejects; a wasm memory-growth event
  between encode and use of the returned view; a dead-code sweep of every
  symbol this feature added or promoted.
- _Artifact and document integrity_: corrupt one byte of a **copy** of the
  vendored artifact and confirm the provenance test actually fails (a test that
  cannot fail proves nothing); confirm every size, hash, capacity and count
  recorded in the docs matches the measurement the harness produced.

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
      (+ optional `Permissions-Policy`) — nothing broader; if the log required an
      approved Sound Chat edit elsewhere, its Section 6 approval is documented there
- [ ] No WebRTC/STUN/TURN anywhere in the feature (Rule 8)
- [ ] No emoji anywhere in Sound Chat's UI copy or source

**Codec correctness (does it actually work, per the deep dive's findings?)**

- [ ] Vendored artifact hash matches the patched hash recorded in
      `src/lib/sound-chat/vendor/NOTICE.md` (not the pre-patch upstream hash)
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
      existing immutable long-cache header; the codec is a separate `?url`
      asset reached through a classic `<script>`, not the JavaScript module graph
- [ ] Build output confirms the codec is a separate `?url` asset — the main
      JavaScript bundle's gzipped size is unchanged from before this feature (compare
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

**Seams, guards and honesty (Section 10 — the Phase 0/1 lesson)**

- [ ] Every defect class in Section 10.1 has a guard *and* a test that violates
      it, and both are green
- [ ] No application callback's exception can stop the feed or be reported as a
      codec failure; a consumer error is visible without killing the session
- [ ] Every usage guard leaves the codec usable (`state === "ready"`); only a
      genuine codec/module throw latches anything off
- [ ] Mocks can throw, reject and misbehave; at least one test per seam
      exercises that misbehaviour
- [ ] Teardown/close idempotency proven against measured browser behaviour
      (double teardown; rejection handled, not floating)
- [ ] Every recorded artifact fact (size, hash, absence of dynamic execution)
      and every capacity/budget is machine-checked by a test or shows its
      arithmetic in the log
- [ ] Dead code and unused exports swept; nothing left behind
- [ ] Each phase's log carries a "claims corrected this phase" list
- [ ] Replay rejected by the dedupe window; no key+nonce reuse across sessions
      or reloads; the pairing code is never acoustic; nothing secret is logged
      or persisted
- [ ] Every finding has a classification (real bug / latent-unreachable / doc
      error / by-design) and an explicit fix-now / fix-in-phase-*N* /
      accepted-with-reason decision

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

---

## 10. Verification discipline: the defect classes that must not slip

Added after the independent verification pass that closed Phase 1 (log:
"Independent verification pass — Phase 0/1"). That pass re-measured everything
and found **seven defects and two wrong claims** inside phases whose test suite
was 196 unit tests plus 58 real-Chromium harness cases, all green. Every one of
those defects lived in a *seam* no test could reach: a callback mock that could
not throw, a capture chunk that was never the wrong size, a teardown that never
ran twice, a `close()` that never rejected, a byte count typed by hand. **Depth
in one dimension is not coverage.** This section is binding for Phases 2–5: it
turns those classes into requirements, each with a guard *and* a test that
violates the guard.

### 10.1 Defect classes, the guard each needs, and the test that proves it

| # | Class | How it slipped in Phase 0/1 | Required guard | Required test (must fail before the fix) |
| :-- | :--- | :--- | :--- | :--- |
| 1 | **Error-source attribution** | One `try/catch` wrapped *both* the codec call and the application callback, so a throwing consumer was reported as a dead codec module and the mic feed latched off | Every callback boundary isolates consumer errors; library failure, our own misuse, and consumer failure are three distinguishable kinds, and only library failure may latch anything off | Consumer callback throws → the feed keeps decoding and the error is reported through its own channel; codec throws → feed stops, reported as codec failure. Both in one file, asserting they are *different* |
| 2 | **Unenforced invariant** | "Capture must present whole 1024-sample frames" was measured in Phase 0 and written into a comment plus a test that *demonstrates* the danger — never into a guard | Every measured invariant gets a guard at the API boundary that rejects the violation, and that guard sits **outside** any latch-on-throw wrapper (see class 10) | Feed 1 / 192 / 512 / 1000 / 1023 samples → typed usage error, module state still `ready`, and a following valid block still decodes |
| 3 | **Over-strict guard** | — (would have been introduced by the obvious fix for class 2) | A guard rejects only what is actually fatal; legal inputs stay legal | Boundary lengths on **both** sides: 0, 1, 1023, 1024, 2048, 3072 samples — the last three must still decode |
| 4 | **Mock fidelity** | The Phase 1 mocks structurally could not fail: `onDecoded` was a `vi.fn()` recorder, `close()` was `async close() { this.closed = true; }`, and every fired chunk was exactly 1024 samples | Mocks must be able to throw, reject, stall and return hostile shapes; the hostile behaviour is tested, not just the happy path | One test per seam where the mock misbehaves (throws / rejects / returns a short chunk / never fires) |
| 5 | **Lifecycle & idempotency** | `teardownAudio` was tested once with a real context and once with `undefined` — never twice with the same context, which is exactly what React's dev double-mount does | Every teardown/close/stop path is idempotent and rejection-handled; nothing assumes it is called once | Call each teardown twice (and after an error) against a mock whose `close()` rejects when already closed — mirroring measured Chromium behaviour; assert no rejection escapes and tracks/listeners release |
| 6 | **Unreleased resources** | Not enumerated as a per-phase obligation | Every timer, listener, AudioNode, `MediaStreamTrack` and wasm instance has an owner and a release point | Count before/after teardown: listeners removed, timers cleared, tracks stopped, no extra `init()` |
| 7 | **Doc / artifact drift** | `NOTICE.md` recorded 147,140 bytes for a 147,139-byte file; a harness comment still quoted the pre-patch 148,131; the plan's own budget read "~39" where the arithmetic is 43 | Any fact a human types about an artifact or a budget is machine-checked, or it does not go in the document | A test parses the document and asserts it against reality: artifact size, SHA-256, absence of `eval(`/`new Function` |
| 8 | **Evidence vs conclusion** | Phase 0's own run printed "module after empty-payload trap: usable" while the prose kept asserting the module dies permanently | Every phase ends by re-reading its own test/build output and listing the claims that output invalidates | A "claims corrected this phase" list in the log. An empty list is allowed; a missing list is not |
| 9 | **Dead code / unused exports** | `rxDurationFrames()` shipped, returns 0 in fixed-length mode and is called nowhere; Rule 6 already called dead code a finding, but no check existed | Every phase re-checks every symbol it added or promoted: caller, test, doc reference | A search proving zero callers, then deletion — or an explicit "kept because …" line |
| 10 | **Our misuse latched as module death** | `#guard()` latches `dead` on *any* throw inside a codec call, so a misuse guard placed inside it would mark a healthy module dead (this is how a naive class-2 fix breaks class 1) | Usage validation happens **before** the latch; only a genuine codec/module throw latches | Trigger every usage guard → `codec.state === "ready"` afterwards, and the next legitimate call succeeds |
| 11 | **Numbers discipline** | Byte/char/time budgets were estimated by hand and repeated across three documents with different values | Every budget is measured in-phase, shows its arithmetic in the log, and estimates are labelled as estimates | A measured capacity number in the log, and the same number in every document that states it |
| 12 | **Phase-boundary interfaces** | Phase 1 handed Phase 2/3 callbacks and a visibility subscription whose real consumers did not exist yet, so their failure modes were structurally untestable | A phase that hands an interface forward states its contract explicitly: what it guarantees, what it does *not* do, what it does on misuse | The receiving phase re-verifies the contract against reality **before** building on it, and adds the hostile-input test the earlier phase could not write |
| 13 | **Crypto / protocol properties** | Not yet built (Phase 2) — listed here so they cannot be discovered late | See 10.2: every property gets a guard, not a comment | Tampered tag, tampered AAD, replayed frame, wrong pairing code, cross-direction confusion, reload/session-restart nonce reuse |
| 14 | **Tooling hygiene** | A probe Playwright config inherited the default output directory and emptied the shared `test-results/` scratch directory (untracked, but it held that session's evidence) | Probe configurations pin `rootDir` **and** `outputDir` inside their own untracked folder; probe scripts and generated build outputs are never left in the shared scratch state | Confirm the shared scratch directory is intact after any probe run, and regenerate build outputs before the session ends |

### 10.2 Phase 2 crypto/protocol properties (guard + test each — never a comment)

These are *properties*, deliberately not a byte layout: Phase 2 chooses the
mechanism and justifies it in the log, but it may not ship a design that fails
any row here.

| # | Property | Why it is non-negotiable | Test that must exist |
| :-- | :--- | :--- | :--- |
| P1 | **Per-direction keys** (distinct Tx and Rx keys derived from the pairing secret, e.g. via HKDF with a role/peer byte) | Both peers share one secret; one shared key with per-side counters starting at 0 collides on nonce immediately | Encrypt a frame in each direction with the same plaintext/counter and assert the keyed material differs; a confused-direction decode must fail its tag |
| P2 | **No key+nonce reuse across sessions** (page reload, restart, re-pairing with the same code) | A deterministic counter that resets on reload silently reuses key+nonce under the same pairing code — AES-GCM's one catastrophic failure mode | Reload a session (fresh module state), send from the same code, and assert the session's nonce/key material differs; assert the nonce derivation includes a per-session random component |
| P3 | **AAD binds the whole header** (`ver`, `msgId`, `fromPeerId`, `len`, `seq`) | Otherwise an attacker can re-point a captured block at a different message id or peer and the tag still verifies | Flip each header byte in turn and assert verification fails |
| P4 | **Replay is defeated by the dedupe window, not by the nonce** (bounded, in-memory, per session) | The codec's waveforms are byte-identical for identical payloads — verified — so a recording replays perfectly and *decrypts*; only the receiver's seen-set stops it | Feed a captured frame twice (and a captured frame with a fresh envelope) → rendered once, second copy suppressed |
| P5 | **A failed AEAD tag = "nothing decoded"** | Never render, never surface as corruption; the sender's own ACK timeout drives retry | Corrupt a tag → the callback is not invoked, no error UI, session continues |
| P6 | **"Frames decoded but the tag failed" is distinguishable from "nothing heard"** | The codec already tells us *something* was in the air; that is the difference between a wrong pairing code and a silent room, and the UI copy depends on it | Two tests: no decode at all → "nothing received"; decode + tag failure → "a transmission was heard but this pairing code cannot read it" |
| P7 | **The pairing code is never transmitted acoustically**, and the acoustic confirmation proves *"same key, live channel"* only — never identity | Anyone in the room can record and replay; the plan must not claim more than it can prove (constraint 5 in Section 2) | Assert the pairing material never appears in a transmitted frame; assert the confirmation is a key-check, and log the honest limitation |
| P8 | **Key derivation is justified, not assumed** — WebCrypto offers PBKDF2/HKDF only (no Argon2); the manual code's entropy budget is stated, and keying does not use the raw code | A 4-digit code is ~13 bits; the log must state the real number and the iteration count, not "PBKDF2 or better" | A log entry with the arithmetic (alphabet size × length → bits, iterations, salt source) and a test that a wrong/short/mistyped code fails closed |
| P9 | **Nothing secret is logged or persisted** — `disableLog()` stays on, no key/nonce/plaintext/pairing code in logs or storage, in-memory only | HUSK's no-persistence constraint and the codec's own console logging | Assert the pairing code and key bytes never appear in any thrown message or logged string; assert no storage write |
| P10 | **Capacity is measured, not estimated** | Three documents already disagree on the byte budget (Section 4's "~39" is arithmetically 43 before `seq` overhead) | Measure real single-block and 2-block plaintext capacity in the suite, log it, and correct every document that states it |
| P11 | **Turn-taking, ACK and retry obey measured time** — never transmit while hidden; Rx feed paused for the exact transmit window plus tail; retry reuses the same `msgId`; ACK timeout scaled to the measured per-block transmit duration (~2 s), not a network-style constant; collision → jittered backoff; a codec/module failure during a send goes to `module_error`, never a retry | The medium is a shared room channel with no collision avoidance whatsoever | Tests for: retry reuses `msgId` and the duplicate is suppressed on the receiving side; ack timeout → backoff → retry; hidden tab holds the send; module failure during send cannot loop |
| P12 | **All protocol state is bounded** — dedupe window, retry queue, out-of-order `seq` buffers | An unbounded seen-set or buffer is a slow memory leak in a long session | Push well past the window and assert the structures stay bounded |

### 10.3 The hostile-input seam set (every remaining phase keeps this green)

Not a wish list — this is the regression surface that Phase 0/1 lacked. Extend
it with everything a phase introduces; never delete a case because it "cannot
happen".

- **audio-io**: consumer callback throws; codec call throws; codec returns null;
  the same payload decodes twice in a row; teardown twice with the same context;
  teardown after a module error; teardown with partial state; listen after stop;
  unsubscribe twice; a chunk that is not a whole frame; a `close()` that rejects
  (mirror the measured Chromium `InvalidStateError`).
- **codec**: empty payload; over-length payload; chunk lengths 0 / 1 / 1023 /
  1024 / 2048 / 3072; a chunk that is a non-zero-offset view; encode or decode
  after `close()`; encode or decode after a latched trap; a wasm memory growth
  between encode and use of the returned view; a misuse guard that must leave
  `state === "ready"`.
- **protocol** (Phase 2): truncated frame; zero-length frame; unknown version;
  unknown frame type; reserved byte values; wrong peer id; wrong `len` vs actual
  ciphertext; duplicate `msgId`; out-of-order / missing / duplicated `seq`;
  exactly-at-cap message; empty-after-header message; an ACK for a `msgId` that
  was never sent; an ACK arriving twice.
- **crypto** (Phase 2): wrong pairing code; one-character-off code; tampered
  ciphertext; tampered tag; each header byte flipped (AAD); replayed frame;
  replayed frame with a rewritten envelope; a frame from the previous session
  (reload); two peers whose counters deliberately collide.
- **transport** (Phase 2): ack timeout → backoff → retry with the same `msgId`;
  both sides transmitting at once (collision); module failure mid-send; hidden
  tab mid-send; stop mid-send; restart after `module_error`; a peer that never
  ACKs; a peer that never transmits; duplicate decode events (the codec
  redelivers 2–4 times by design) rendering once.

### 10.4 Definition of done (added to every phase's gate)

A phase is not done, and must not be logged as done, until all of these hold:

1. The Section 5 battery passes, including the Sound Chat unit and harness
   regressions, with the numbers this session observed.
2. The seam set in 10.3 is **extended for everything the phase introduced** and
   is green.
3. Every invariant the phase relies on has both a guard and a test that violates
   it; guards for our own misuse live outside any latch-on-throw wrapper.
4. Every recorded fact (artifact size/hash, capacities, counts, timings) is
   either machine-checked by a test or shows its arithmetic in the log.
5. The log contains a **"claims corrected this phase"** list — an empty list is
   allowed, a missing list is not.
6. Every finding is classified (**real bug / latent-unreachable / doc error /
   by-design**) with an explicit decision: fix now, fix in phase *N*, or accept
   with the reason stated. A finding with no decision is not accepted.
7. `git diff --stat` shows only Section 6 files, `worker/` shows zero diff, and
   no probe script, WAV, or generated artifact is staged.




