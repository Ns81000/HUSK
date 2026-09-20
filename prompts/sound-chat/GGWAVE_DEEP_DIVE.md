# ggwave — Deep Dive (pre-implementation recon for HUSK Sound Chat)

**Clone under inspection:** `C:\Users\Ns8pc\Videos\HUSK\ggwave`
**Commit:** `060aec73dd7123ccac200442f75bdc7369795ffe` ("emscripten: Emscripten fixup (#177)"), 2026-04-16, `git describe` → `ggwave-v0.4.3-2-g060aec7`, branch `master` == `origin/master`.
**Upstream:** `https://github.com/ggerganov/ggwave.git`
**Submodules declared but NOT checked out** (`git submodule status` shows `-` on all three): `bindings/ios` (ggwave-spm), `examples/third-party/ggsock`, `examples/third-party/imgui/imgui`. → iOS Swift-package source is not available locally.

## 0. Repro / housekeeping (answered up front)

- `ggwave` **is already ignored**: the `ggwave` line in `C:\Users\Ns8pc\Videos\HUSK\.gitignore` comes from an **uncommitted** edit (`git diff .gitignore` → `+ggwave`, inserted between `dist` and `dist-ssr`). HUSK `git status` shows ` M .gitignore` plus untracked `audit/`. **The ignore entry is not committed yet** — `git checkout .gitignore` / `git stash` would expose the whole clone to `git status`, so it could get accidentally staged. Flagging only; nothing added, nothing deleted.
- Nothing in the clone is referenced by HUSK source today: no `ggwave` string, and no `getUserMedia`/`AudioContext`/`AudioWorklet` anywhere in `C:\Users\Ns8pc\Videos\HUSK\src`.
- HUSK's real stack (from `package.json` + `vite.config.ts`): **Vite 8.1.5 + TanStack Start (React 19) via `@lovable.dev/vite-tanstack-config`**, Vitest 4, Playwright. There is a `worker/` sub-package (Cloudflare Worker, wrangler) and `src/server.ts` (154 lines) which is the SSR entry that applies security headers.
- `LICENSE` = **MIT, "Copyright (c) 2020 Georgi Gerganov"** (`ggwave/LICENSE:1-3`): the notice + permission text must accompany copies/substantial portions → keep an attribution/license page or a license-collecting build plugin when we bundle it. `src/reed-solomon/` is a separately-licensed vendored implementation with its own `LICENSE` file (not read in full — irrelevant if we consume the prebuilt wasm instead of vendoring source).
- `CHANGELOG.md` is stale: newest entry is v0.4.0 (2022-07-05) while the tree is v0.4.3 and the `[Unreleased]` section is empty → no documented notes for 0.4.1-0.4.3.

---

## 1. Core protocol mechanics

Files/paths covered: `include/ggwave/ggwave.h` (1016 lines: C API 26-345, C++ class 421-1012 incl. protocol table 520-535, constants 423-436, Resampler decl 830-876), `src/ggwave.cpp` (2112 lines: C API 47-225, DSS magic 231-249, ECC sizing 284-286, `prepare`/`alloc` 470-657, `init` 679-765, `encodeSize_*` 767-791, `encode` 793-1055, `decode` 1057-1194, Rx accessors 1256-1315, filters 1337-1404, Resampler 1410-1562, `decode_variable` 1568-1872, `decode_fixed` 1877-2045, protocol helpers 2047-2112), `src/reed-solomon/rs.hpp` (15-95 + grep of every `Encode`/`Decode`/`getWorkSize`), `README.md` (all 233 lines), `README-tmpl.md`, `CHANGELOG.md`, `tests/test-ggwave.cpp`, `tests/test-ggwave.c`.
Read in full: **YES** for the whole functional surface of `ggwave.cpp`/`ggwave.h`. Deliberately not line-by-line: `src/fft.h` (779 lines — grep-verified: the classic Ooura-family `rdft()` real FFT, tables live in caller-provided `wi`/`wf`, no external deps; wrapped by `ggwave.cpp:251-259`) and `src/reed-solomon/gf.hpp` (GF(256) log/exp tables).

### 1.1 Throughput: README claim vs. what the code actually does

Raw line rate = `bytesPerTx / (framesPerTx * frameTime)`; payload rate also subtracts the 3-byte variable-length header + ECC; end-to-end adds the 32 marker frames.

| protocol | raw line rate @48k/1024 | payload rate incl. header+ECC @N=140 | end-to-end for N=140 (incl. markers) |
|---|---|---|---|
| AUDIBLE/ULTRASOUND **Normal** | 15.63 B/s | 11.0 B/s | 140 B in 12.42 s = 11.3 B/s |
| AUDIBLE/ULTRASOUND **Fast** | 23.44 B/s | 16.5 B/s | 140 B in 9.26 s = 15.1 B/s |
| AUDIBLE/ULTRASOUND **Fastest** | 46.88 B/s | 33.0 B/s | 140 B in 6.08 s = 23.0 B/s |
| DT Fast / Fastest | 7.81 / 15.63 B/s | 5.5 / 11.0 B/s | 9.26 s / 6.08 s |
| MT Fast / Fastest | 3.91 / 7.81 B/s | 2.7 / 5.5 B/s | fixed-length only (no markers) |

Formulas (all from `ggwave.cpp`): `totalBytes = 3 + N + ECC(N)` (variable mode), `dataFrames = ceil(totalBytes/bytesPerTx)*framesPerTx`, `totalFrames = 2*16 + dataFrames` (variable) or `= dataFrames` (fixed, `m_nMarkerFrames = 0`, `ggwave.cpp:493-494`), frame = 1024/48000 s.

- **README's "8-16 bytes/sec" is a hand-wave**: it matches Fast/Normal at large payloads *without* markers; Fastest beats it (23-33 B/s), short messages fall far below it.
- **The marker tax dominates short messages**: 32 frames = **682.7 ms per variable-length transmission**, regardless of payload. A realistic chat line (24 B of our own framing → `1+24+2*(24/5)=34` encoded bytes → ceil(34/3)=12 chunks × 6 frames = 72 frames = 1.54 s, +0.68 s markers) = **2.22 s on AUDIBLE_FAST**, ≈10.8 B/s end-to-end. Fixed-length `payloadLength=64` + FASTEST = `ceil(88/3)*3 = 90 frames = 1.92 s` for up to 64 payload bytes ≈ 33 B/s.
- DSS changes none of these numbers (zero wire cost).

### 1.2 Reed-Solomon ECC: the exact overhead formula

`src/ggwave.cpp:284-286`:
```cpp
int getECCBytesForLength(int len) { return len < 4 ? 2 : GG_MAX(4, 2*(len/5)); }
```
- Integer division → **ECC quantised in steps of 2, jumping only at multiples of 5**: len 1-3→2, 4-14→4, 15-19→6, 20-24→8, …, **140→56**.
- Overhead `ECC/(N+ECC)` → 2/7 ≈ **28.6% for large N** (40% of payload). Small N is punished: N=4 → 33%.
- Two independent RS blocks: a **1-byte length word + 2 ECC bytes** header using `RS(1,2)` (`ggwave.cpp:809-811`; `getECCBytesForLength(1)=2`), then `RS(N, ECC(N))` over the payload (`ggwave.cpp:814-815`). **Both must decode** or nothing is returned.
- Vendored RS (`src/reed-solomon/rs.hpp`): `assert(msg_length + ecc_length < 256)` (lines 87, 157) → 255-symbol block limit; ggwave's `kMaxDataSize = 256` keeps `N+ECC ≤ 196`. No erasure positions are used by ggwave (`Decode(src, dst)`; the erase API exists but is not wired up), so all correction is plain RS. `Decode()` returns 0 on success / non-zero on failure → **that return value is the only integrity signal we ever get** (§3).
- Work buffer is tiny: `getWorkSize_bytes = ecc + 1 + 3*msg + 14*ecc*2` (`rs.hpp:33-35`) = 2045 B for (140,56).

### 1.3 The protocol table, straight from source (not the README)

`include/ggwave/ggwave.h:521-533`, fields `{name, freqStart(bin), framesPerTx, bytesPerTx, extra, enabled}`:

| # | enum | name | freqStart (bin) | frames/Tx | bytes/Tx | extra | nTones = 2·bytes/extra | Tx duration @48k/1024 |
|---|------|------|-----------------|-----------|----------|-------|------------------------|----------------------|
| 0 | `AUDIBLE_NORMAL` | `Normal` | 40 | 9 | 3 | 1 | 6 | 192.0 ms |
| 1 | `AUDIBLE_FAST` | `Fast` | 40 | 6 | 3 | 1 | 6 | 128.0 ms |
| 2 | `AUDIBLE_FASTEST` | `Fastest` | 40 | 3 | 3 | 1 | 6 | 64.0 ms |
| 3 | `ULTRASOUND_NORMAL` | `[U] Normal` | 320 | 9 | 3 | 1 | 6 | 192.0 ms |
| 4 | `ULTRASOUND_FAST` | `[U] Fast` | 320 | 6 | 3 | 1 | 6 | 128.0 ms |
| 5 | `ULTRASOUND_FASTEST` | `[U] Fastest` | 320 | 3 | 3 | 1 | 6 | 64.0 ms |
| 6 | `DT_NORMAL` | `[DT] Normal` | 24 | 9 | 1 | 1 | 2 | 192.0 ms |
| 7 | `DT_FAST` | `[DT] Fast` | 24 | 6 | 1 | 1 | 2 | 128.0 ms |
| 8 | `DT_FASTEST` | `[DT] Fastest` | 24 | 3 | 1 | 1 | 2 | 64.0 ms |
| 9 | `MT_NORMAL` | `[MT] Normal` | 24 | 9 | 1 | 2 | **1** | 9 frames **per nibble** |
| 10 | `MT_FAST` | `[MT] Fast` | 24 | 6 | 1 | 2 | 1 | 6 frames per nibble |
| 11 | `MT_FASTEST` | `[MT] Fastest` | 24 | 3 | 1 | 2 | 1 | 3 frames per nibble |
| 12-21 | `CUSTOM_0..CUSTOM_9` | `nullptr` | **0** | **0** | **0** | **0** | — | disabled + zero-initialised (see §5.2) |
| 22 | `GGWAVE_PROTOCOL_COUNT` | — | — | — | — | — | — | — |

`txDuration_ms = framesPerTx*1000*samplesPerFrame/sampleRate` (`ggwave.h:457-459`); all timings assume the defaults `sampleRate = 48000`, `samplesPerFrame = 1024` → frame = 21.333 ms.

Things the README does **not** tell you:
- **`DT` (dual-tone) and `MT` (mono-tone) are undocumented** in `README.md` — the "Technical details" section only describes the 3-byte/6-tone scheme, and no protocol table exists. Their bands are only derivable from source.
- **MT is per-nibble mono-tone**: `nTones()` = 1, and `encode()` uses `totalDataFrames = extra*ceil(totalBytes/bytesPerTx)*framesPerTx` (`ggwave.cpp:786,806`), so each byte takes `2*framesPerTx` frames, one tone at a time. DT sends 2 tones per Tx, 16 bins apart.
- **MT cannot be used with variable length at all**: `init` rejects it (`ggwave.cpp:720-723`, "Mono-tone protocols with variable length are not supported") and `decode_variable` skips `extra == 2` (`ggwave.cpp:1625-1628`). MT ⇒ fixed `payloadLength` only.
- `Protocols::kDefault()` is a function-local `static` built once; `Protocols::tx()` and `Protocols::rx()` are **separate copies** (`ggwave.cpp:382-392`), and each instance snapshots them during `prepare()` (`ggwave.cpp:565,571`).

### 1.4 Exact frequency bands (derived from code, then cross-checked against the decoder)

Model: `hzPerSample = sampleRate/samplesPerFrame` (`ggwave.cpp:488`) = **46.875 Hz** at defaults (= README's `dF`, `README.md:89`).
- Marker tone `i∈[0,15]`: `bin = freqStart + 2*i`, with a +1-bin variant for the "bit0" half → marker spans `freqStart .. freqStart+31` (`bitFreq()` at `ggwave.cpp:2110-2112` with `m_freqDelta_hz = 2*hzPerSample`, `ggwave.cpp:491`).
- Data nibble `b` of group `i∈[0, 2*bytesPerTx-1]`: `bin = freqStart + 16*i + b` — the decoder literally computes `bin = round(hzPerSample*freqStart*m_ihzPerSample) + 16*i` (`ggwave.cpp:1674-1675`) and the same in `decode_fixed` (`ggwave.cpp:1921-1990`).

| class | freqStart | lowest tone | highest tone | span |
|---|---|---|---|---|
| AUDIBLE | bin 40 | 40·46.875 = **1875.0 Hz** | (40+95)·46.875 = **6328.125 Hz** | 4.45 kHz |
| ULTRASOUND | bin 320 | **15000.0 Hz** | (320+95)·46.875 = **19453.125 Hz** | 4.45 kHz |
| DT | bin 24 | 24·46.875 = **1125.0 Hz** | (24+31)·46.875 = **2578.125 Hz** | 1.45 kHz |
| MT (data) | bin 24 | 1125.0 Hz | (24+15)·46.875 = **1828.125 Hz** | 0.70 kHz |

Cross-check: README claims `F0 = 1875.000` / `15000.000`, `dF = 46.875` (`README.md:89`) → **code and README agree**. But README's "4.5 kHz range divided in 96 equally-spaced frequencies" is off by one step: 96 tones at 46.875 Hz span 95·46.875 = **4453.125 Hz**, and only 6 groups × 16 tones = 96 tones exist for the 3-byte protocols (DT/MT use 32/16 tones).

**Honesty check on "near-inaudible":** ultrasound tops out at **19.45 kHz**, not 20-22 kHz.
- Most laptop/phone speakers do reproduce 15-19.4 kHz, often with audible IM distortion/harmonics in cheap drivers → the chirp is *quiet*, not *silent*.
- 15-19.4 kHz is clearly audible to many adults and unpleasant for children/young ears; the 15-16.4 kHz region (start marker + low nibbles) is exactly where small speakers resonate.
- Audible mode (1875-6328 Hz) is squarely inside speech/music; DT/MT (1125-2578 Hz) even more so. Any of these will be picked up by other mics in the room — relevant to a chat mode's threat model.

### 1.5 DSS ("Direct Sequence Spread") — what it really is

`ggwave.cpp:231-249, 732-734, 1728-1732, 2024-2028`:
- **Not spread spectrum, not security**: a **fixed, public 64-byte XOR mask** (`kDSSMagic`, hard-coded at `ggwave.cpp:236-241`) XORed over the payload (`getDSSMagic(i)` internally does `i % 64`).
- Wire cost **zero**; applied *before* RS encode on Tx and *after* RS decode on Rx.
- Stated purpose: "more homogeneous distribution of the sound energy across the spectrum" (avoid one dominant tone).
- Must be enabled on **both** ends (`GGWAVE_OPERATING_MODE_USE_DSS`), else payloads come back as garbage.
- **The repo's own test disables DSS for variable-length with an explicit comment** (`tests/test-ggwave.cpp:268-270`):
  `// it seems DSS is not suitable for "variable-length" transmission` / `// sometimes, the decoder incorrectly detects an early "end" marker when DSS is enabled`. DSS is only randomly exercised in fixed-length mode (line 299).
- Verdict for chat: **avoid DSS in variable-length** (no reliability gain, adds a documented failure mode). It is also **not obfuscation** — the mask is public and the audio is trivially recordable/replayable.

### 1.6 Variable-length vs fixed-length: exactly what changes

`ggwave.cpp:493-494, 578, 691-696, 730-731, 786, 808-811, 1877-2045`:

| | variable (`payloadLength <= 0`, default −1) | fixed (`payloadLength > 0`) |
|---|---|---|
| sound markers | 16 frames start + 16 end | **none** |
| in-band length | yes: 1 length byte + 2 RS bytes (3 B) | no (saves 3 B) |
| Tx payload size | `min(dataSize, 140)` | **exactly `payloadLength`**; shorter input **zero-padded** (`ggwave.cpp:730-731`) |
| max | `kMaxLengthVariable = 140` | `kMaxLengthFixed = 64` |
| Rx algorithm | marker detect → record → brute-force search over 256 sub-frame offsets | rolling FFT-spectrum history + per-tone vote |
| Rx failure signal | `m_rx.dataLength = -1` and `m_rx.framesToRecord = -1` (`ggwave.cpp:1757-1761`) — explicit, but unreachable from JS (§3.1) | none; it just keeps sliding |
| Rx memory | `amplitudeRecorded` = 2048×1024 floats = **8 MB** | `spectrumHistoryFixed` uint8 matrix (≈2 KB × frames) |
| extra gate | marker must be detected | `txDetectedTotal >= 0.75*txNeededTotal` tone quorum (`ggwave.cpp:2012`) before RS is attempted |

- Fixed-length mode has **no start marker**: a listener keeps a rolling spectrum window (`historyStartId`, `ggwave.cpp:1931-1952`) and can decode a transmission that began before it started listening. Great for an always-on chat listener; means *we* own framing + dedupe (message id inside our payload).
- Fixed-length pads with zeros, so trailing zero bytes are still transmitted on the wire (same nibble alphabet). Harmless, costs time.
- Fixed-length's 75% quorum is a free "is there even a signal?" gate; variable-length's equivalent is marker + RS.

### 1.7 Resampler: arbitrary rates, with caveats

`ggwave.cpp:1410-1562`, `include/ggwave/ggwave.h:830-876`:
- Sinc interpolation, `kWidth = 64` neighbours per output sample, table 2048 floats, `kDelaySize = 140`, `kSamplesPerZeroCrossing = 32`.
- **`m_samplesInp` is hard-coded to 4096 floats** (`ggwave.cpp:1416`) and `resample()` asserts `nSamples > kWidth` + `4096 >= nSamples + kWidth` (lines 1450-1451) — **asserts are compiled out in the emscripten Release build**. I traced both call sites: max plausible `nSamples` per call is ~2052 (96 kHz input vs 48 kHz operating, `samplesPerFrame = 1024`) ⇒ ~2× headroom, by construction rather than by guard. Don't feed >96 kHz capture.
- Rate limits `kSampleRateMin = 1000` / `kSampleRateMax = 96000` are enforced **only on `sampleRateInp`** (`ggwave.cpp:519-527`); `sampleRateOut` is never range-checked. Comment at `ggwave.cpp:599` ("min input sampling rate is 0.125*m_sampleRate") documents the 8× buffer sizing (lines 600-601).
- `m_needResampling = (sampleRateInp != sampleRate) || (sampleRateOut != sampleRate)` (`ggwave.cpp:500`). Setting the *device* rates and leaving the *operating* rate at 48000 is the fast path — the browser example does exactly that (`examples/ggwave-js/index-tmpl.html:70-75`).
- **Undocumented cross-device constraint (most likely silent interop bug):** tones are bin-index based and `hzPerSample = sampleRate/samplesPerFrame`, so **both peers must use the same `sampleRate` and `samplesPerFrame`** or the tone grids don't line up and nothing ever decodes. `sampleRateInp/Out` may differ freely (resampled internally); `sampleRate` / `samplesPerFrame` may not. Treat 48000/1024 as protocol constants.
- Resampler state is reset after ≥60 s of idle receive while resampling (`ggwave.cpp:1158-1161`) — an anti-drift hack; relevant if we ever see "works for a minute then degrades".

### 1.8 Binary safety, max payload, over-limit behaviour

- **The core is fully binary-safe.** `ggwave_encode(id, const void* payload, int size, ...)` / `ggwave_decode(id, const void*, int, void*)` (`ggwave.h:230-297`); header text: "The payloadBuffer can be any binary data … it can be any sequence of bytes" (227-228) and "the decoded data written to the payloadBuffer is NOT null terminated" (261). Nothing assumes UTF-8 (RS + nibble mapping are byte-oriented). ✅ Encrypted binary is fine.
- **Max payload: 140 B** (variable) / **64 B** (fixed); belt-and-braces `kMaxDataSize = 256` on `payload + ECC` (`ggwave.cpp:582-586`).
- **Over-limit behaviour is asymmetric and mostly silent:**
  - *Variable-length Tx with `dataSize > 140`:* **silently truncated to 140**, logged to stderr only (`ggprintf("Truncating data from %d to %d bytes\n", …)`, `ggwave.cpp:693-696`), then `init()` returns **true** and `encode()` returns a valid waveform of the first 140 bytes. `ggwave_encode` reports success → **no JS-visible error.** HUSK must chunk at the app layer.
  - *Fixed `payloadLength > 64`, `sampleRateInp` outside [1000, 96000], `samplesPerFrame > 1024`:* `prepare()` returns **false**, but **`ggwave_init` still returns a valid instance id** — the C wrapper only looks for a free slot (`ggwave.cpp:58-79`) and the C++ constructor discards `prepare()`'s return (`ggwave.cpp:460-462`). Result: an instance with all-null buffers → next `encode`/`decode` dereferences null inside wasm. JS sees nothing. (The `calloc`-failure path only logs "heap size mismatch", `ggwave.cpp:553-556`.)
  - `ggwave_ndecode` can return `-2` (output too small, `ggwave.cpp:183-185`) but **the JS binding calls `ggwave_decode` with a fixed 256-byte static buffer**, so JS can never hit `-2`.

### 1.9 Memory footprint per instance (computed from `alloc()`, not measured)

`ggwave.cpp:577-657`. Default parameters (variable length, Rx+Tx, F32 in/out, **no resampling**) allocate roughly:

| buffer | size |
|---|---|
| `m_rx.amplitudeRecorded` (2048 frames × 1024 samples × float) | **8.0 MB** |
| `m_tx.outputTmp` (2048 × 1024 × 4 B) | **8.0 MB** |
| `m_tx.outputI16` (2048 × 1024 × 2 B) | **4.0 MB** |
| `m_tx.bit0Amplitude` + `bit1Amplitude` (96 × 1024 floats each) | 0.75 MB |
| `m_rx.fftOut` (2048 floats) + spectrum/amplitude/amplitudeResampled (3×1024 floats) + `amplitudeTmp` (4 KB) | ~0.03 MB |
| `m_rx.amplitudeHistory` (4 × 1024 floats) + `amplitudeAverage` | 0.02 MB |
| everything else (data, tones, dataBits, RS work) | ~0.01 MB |
| **total** | **≈ 21-22 MB per instance** |

- These two 8 MB buffers (`amplitudeRecorded` for variable-length Rx, `outputTmp` for Tx F32 playback) are **1.25 s of 48 kHz audio buffer / 8.7 s of output buffer** sized by `kMaxRecordedFrames = 2048`. They exist regardless of message length.
- Consequence: `GGWAVE_MAX_INSTANCES = 4` (`ggwave.h:30`) ⇒ *up to ~85 MB* if you init 4 default instances. Even one instance forces the wasm heap (initial 16 MB by emscripten default, `ALLOW_MEMORY_GROWTH=1`) to grow to ≥32 MB.
- **Mitigations that actually work, from the source:**
  - Use **Rx-only** (`GGWAVE_OPERATING_MODE_RX`) or **Tx-only** to drop half (~13 MB Tx-only / ~8.5 MB Rx-only).
  - Use **fixed-length** (`payloadLength > 0`) → the 8 MB `amplitudeRecorded` is replaced by a small uint8 spectrum matrix (`ggwave.cpp:611-618`) → Rx-only fixed becomes ~0.2 MB.
  - Nothing removes the Tx `outputTmp`/`outputI16` except `TX_ONLY_TONES` (irrelevant for us).
- **UNVERIFIED by execution** (no emsdk in this clone): numbers are computed from the `ggalloc` sizes. Worth measuring in-browser with `performance.memory` / wasm `memory.buffer.byteLength` once integrated.

---

## 2. JavaScript / WASM bindings (what we would actually ship)

Files/paths covered: `bindings/javascript/emscripten.cpp` (all 136 lines), `bindings/javascript/package.json`, `package-tmpl.json`, `README.md`, `CMakeLists.txt`, `.gitignore`, the **prebuilt** `bindings/javascript/ggwave.js` (148,150 B — read as text and executed under Node 24), `examples/ggwave-js/index-tmpl.html` (all 190 lines), `examples/ggwave-js/README.md`, `examples/ggwave-js/CMakeLists.txt`, `examples/ggwave-wasm/main.js`, `examples/buttons/index-tmpl.html`, `tests/test-ggwave.js`, root `CMakeLists.txt` + `.github/workflows/build.yml`, npm registry metadata for `ggwave`, and the published tarball `ggwave-0.4.0.tgz`.
Read in full: **YES** (also *ran* both the clone artifact and the npm artifact in Node — everything marked "measured" below is executed output). Not read: the embedded ~81 KB wasm binary itself (only its base64 length measured).

### 2.1 npm package structure — and a version gap that changes our plan

Measured (registry + tarball, this session):

| | npm `ggwave` (published) | clone `bindings/javascript/ggwave.js` |
|---|---|---|
| version | **0.4.0, published 2022-07-05** (`dist-tags.latest = 0.4.0`) | HEAD is 0.4.3+2; file last touched 2023-09-08 (`bac95c8`) |
| files | 6: `ggwave.js` (153,955 B), `emscripten.cpp`, `CMakeLists.txt`, `package.json`, `package-tmpl.json`, `README.md` | artifact + build files |
| `package.json` | `main: ggwave.js` only — **no `exports`, no `module`, no `types`, no `browser`, no `files`** | same |
| module shape | CJS UMD tail: `module.exports = ggwave_factory` (+ AMD `define`); `var ggwave_factory = (() => …)()` | identical shape |
| test script | `"test": "echo \"todo: add tests\" && exit 0"` — **a stub** | same |
| API (measured `Object.keys`) | `init, free, encode, decode, getDefaultParameters, rxToggleProtocol, txToggleProtocol, disableLog, enableLog, ProtocolId, SampleFormat, GGWAVE_OPERATING_MODE_*` + internals (`HEAP8..F64`, `_malloc`, `_free`, `asm`, `run`, `BindingError`, …) | same **minus** `_malloc`/`_free`/`asm`/`run`, **plus** `rxDurationFrames`, `rxProtocolSetFreqStart`, `txProtocolSetFreqStart` |
| protocols exposed | AUDIBLE_*, ULTRASOUND_*, DT_*, CUSTOM_0..9 — **NO `MT_*`** (measured: `ProtocolId.GGWAVE_PROTOCOL_MT_FASTEST` is `undefined`) | all 12 incl. `MT_*` (measured: encode works) |
| artifact size | 153,955 B (base64 wasm blob 111,160 chars ≈ 83,370 B) | 148,150 B (blob 108,376 chars ≈ 81,282 B) |

Consequences:
- **`pnpm add ggwave` does NOT get the current library.** It gets a 2022 build that predates the 2023-09-08 `ggwave.js` refresh. Its `ProtocolId` numbering also differs from HEAD's (`CUSTOM_0 == 9` in npm vs `MT_NORMAL == 9` in HEAD; AUDIBLE 0-5 and DT 6-8 happen to line up, so only MT/CUSTOM break when mixing builds).
- The npm artifact lacks **`rxProtocolSetFreqStart`** → the band-tuning trick (§Ops) is unavailable; `rxDurationFrames` is missing too.
- It is **ESM-hostile CJS/UMD with no types**: Vite pre-bundles it, but TypeScript needs a hand-written `.d.ts`, and the factory arrives as the module's `default`. Not tested against Vite 8 (HUSK has no `node_modules` installed right now).
- Upside: the npm tarball *also ships* `emscripten.cpp` + `CMakeLists.txt`, so it doubles as a mini source drop if we ever want to patch the binding.

### 2.2 How the WASM is loaded (and what that means for Vite)

- `GGWAVE_WASM_SINGLE_FILE` **defaults ON** (`CMakeLists.txt:28`); `bindings/javascript/CMakeLists.txt:12-22` adds `-s SINGLE_FILE=1` and copies the result to `bindings/javascript/ggwave.js`. Other flags (`:24-30`): `--bind -s MODULARIZE=1 -s ALLOW_MEMORY_GROWTH=1 -s EXPORT_NAME='ggwave_factory'`.
- Measured: each artifact embeds **exactly one contiguous base64 blob** (sizes in §2.1) with **no `.wasm` fetch** — the wasm is data inside the JS.
- ⇒ For Vite: **no `?url` import, no `vite-plugin-wasm`, no top-level-await plugin, no asset copy step, no `public/` entry.** A plain `import` (or dynamic `import()`) of the JS file is sufficient.
- `_scriptDir` uses `document.currentScript` behind a `typeof document !== 'undefined'` guard → bundler- and Node/Worker-safe.
- **Bundler hazard (both artifacts):** the glue contains `require("fs")` and `require("path")` inside the `ENVIRONMENT_IS_NODE` branch. A browser-platform esbuild/Rollup run will try to resolve bare `fs`/`path`. If Vite's dep optimizer complains: `optimizeDeps: { exclude: ["ggwave"] }` plus aliasing those two builtins to an empty stub (or vendor the file and alias). **UNVERIFIED here** (no `node_modules` present) — cheap to spike.

### 2.3 Cross-origin isolation / SharedArrayBuffer: **NOT required**

- Measured on both artifacts: **`SharedArrayBuffer` = 0 occurrences, `pthread` = 0 occurrences**; no `-pthread`/`USE_PTHREADS`/`SHARED_MEMORY` flags in `CMakeLists.txt`.
- ⇒ **No COOP/COEP headers, no `crossOriginIsolated` requirement, no `src/server.ts` change for isolation.** That kills the biggest WASM gotcha. Everything is single-threaded; `ALLOW_MEMORY_GROWTH=1` is on (see §1.9 and §2.6).

### 2.4 CSP: the change we *do* have to make

- Both builds call `WebAssembly.instantiate(...)` (measured: 3-5 `WebAssembly` references). Modern browsers require **`'wasm-unsafe-eval'`** (or the legacy `'unsafe-eval'`) in `script-src` to compile wasm — Chrome 95+, Firefox 102+, Safari 16+ (per systemshardening.com's "WASM in the Browser" CSP write-up; secondary source, verify in-browser). HUSK's `buildCsp()` currently emits `script-src 'self' <hashes>` → **wasm compilation would be blocked.**
- **The npm 0.4.0 artifact additionally uses `new Function` once** — measured, inside `createNamedFunction()` which runs at load time to build `BindingError`/`InternalError`/`UnboundTypeError` (they show up in `Object.keys`). Under HUSK's CSP that is `'unsafe-eval'` territory, which we do **not** want to grant. **The clone's newer artifact has zero `new Function`** (measured) → strictly better CSP posture.
- ⇒ If we ship ggwave: add `'wasm-unsafe-eval'` to `script-src` in `src/server.ts:41`, and **prefer the newer artifact** (clone, or rebuild from the npm tarball's source) over npm's published JS.
- No `Permissions-Policy` header exists today, so `microphone` is unrestricted (nothing to change). `media-src` only matters for `<audio>`/blob-URL playback — WebAudio `AudioBufferSourceNode` playback is **not** covered by `media-src`, so that planned change may be unnecessary unless we adopt an AudioWorklet (whose module URL is governed by `script-src`, not `media-src`).

### 2.5 Bundle size (measured)

- Clone artifact: **148,150 B raw / 59,452 B gzip** (measured with .NET GZipStream, default level).
- npm artifact: 153,955 B raw → expect **~61-64 KB gzipped**.
- Contrast with the HUSK main bundle (~95 KB gzipped per the codebase audit): shipping this eagerly would grow the app bundle by ~60-65%. ⇒ **Lazy-load it** via dynamic `import()` behind the Sound Chat entry point so it becomes a separate chunk.
- The embedded wasm is only ~81 KB → the rest is emscripten glue + the base64 tax (~33% inflation). Avoidable only by rebuilding with `SINGLE_FILE=0` (adds an asset fetch; `'wasm-unsafe-eval'` still required).
- For HUSK's bundle-size discipline: this one dependency is comparable to the entire app. Any plan that assumes "it's a small library" is wrong.

### 2.6 Threading model & measured costs

- Both `encode` and `decode` are **synchronous and blocking on the calling thread** — no worker, no async, no callback. `decode()` is meant to be called repeatedly with fresh audio chunks and returns instantly when nothing is detected.
- The official browser example never uses AudioWorklet/MediaRecorder: **measured, zero occurrences of `AudioWorklet`/`MediaRecorder`/`worklet` in the entire repo** — it uses the deprecated `createScriptProcessor(1024, 1, 1)` with a `createJavaScriptNode` fallback (`examples/ggwave-js/index-tmpl.html:121-135`).
- Measured under Node 24 (x86-64, clone artifact, 24-byte payload):
  - `encode` AUDIBLE_FAST → 425,984 B / 2.22 s of audio: **7-8 ms**
  - `decode` of that whole buffer in one call: **17 ms**; fixed-64 AUDIBLE_FASTEST (368,640 B): **43 ms**
  - 20 × full-buffer decode of a variable-length ULTRASOUND_FAST waveform, **all 12 Rx protocols enabled: 135 ms (~6.8 ms/call)**
  - the same 20 calls with **only ULTRASOUND_FAST enabled: 27 ms (~1.35 ms/call)** → **~5× cheaper** — the cheapest perf win available (`rxToggleProtocol` before `init`)
  - random noise (180,224 B): `decode` 7 ms, returns nothing
- Steady-state chat cost is small: with 1024-frame chunks (21.3 ms cadence) the common path is well under ~1 ms. The expensive paths are (a) the one-shot analysis after a capture ends and (b) variable-length failure handling (§3). Budget for an occasional multi-10 ms main-thread stall, or move decode to a Worker (which needs its *own* module instance: +~22 MB wasm heap, §1.9).

### 2.7 Instance lifecycle (all measured)

- **One module instance hosts 4 ggwave instances** (`GGWAVE_MAX_INSTANCES = 4`, `ggwave.h:30`). Measured: six consecutive `init()` calls returned `0,1,2,3,-1,-1`; `init()` returns **−1** when full.
- **Calling `encode`/`decode` on the −1 id aborts the wasm module** (measured twice — the promise rejected with a *numeric* reason such as `60584896`, an internal pointer/abort, not a typed JS Error). Always check `id >= 0` and always `free()`.
- `free(id)` returns `undefined` (no error feedback); freeing an already-freed id only logs.
- **A single instance is reusable** for repeated `encode`/`decode` (measured: encode → decode → decode again on one instance). Hold one instance for the whole session; do **not** re-`init()` per message (each `init` allocates ~22 MB, §1.9).
- **`encode()` resets the receiver state** — `ggwave_encode` → `GGWave::init()` → `ggwave.cpp:746-762` zeroes `data`/`spectrum`/`amplitude`, sets `receiving = false`. And `decode()` refuses to run while Tx data is pending (`ggwave.cpp:1063-1066`, "Cannot decode while transmitting"). ⇒ **Use separate Tx and Rx instances** (2 of our 4 slots) or pause listening before sending (what the official demo does: `onSend()` → `captureStop.click()`, `index-tmpl.html:87`).
- **⚠️ Returned typed-array views silently go empty when wasm memory grows.** Measured: `encode()` returned a view with `length = 425984`, and after another `init()` the same view reported `length = 0` (heap growth detached the ArrayBuffer). Worse, the views alias **static C++ buffers** (`static std::vector<char> result`, `emscripten.cpp:73`; `static char output[256]`, `emscripten.cpp:87`), so they are also overwritten by the next call. ⇒ **Copy immediately** (`Uint8Array.from(view)` / `.slice()` / `Buffer.from(view)`), never store or hold the view across calls.

### 2.8 The browser example, line by line (`examples/ggwave-js/index-tmpl.html`)

- `ggwave_factory().then(obj => ggwave = obj)` at load (51-53) — one module, resolved once.
- `init()` (68-77): `new AudioContext({sampleRate: 48000})`; `parameters = ggwave.getDefaultParameters()`; **`parameters.sampleRateInp = context.sampleRate; parameters.sampleRateOut = context.sampleRate;`** while leaving `parameters.sampleRate` at the 48000 default → either zero resampling (if the browser honours 48k) or internal resampling to 48k. **`ggwave.init(...)`'s return value is never checked** (it can be −1 → later abort, §2.7).
- Tx (`onSend`, 83-99): pauses capture (`captureStop.click()`), `ggwave.encode(instance, txData.value, GGWAVE_PROTOCOL_AUDIBLE_FAST, 10)` → **volume 10/100**, `convertTypedArray(waveform, Float32Array)` → `createBuffer(1, len, context.sampleRate)` → `BufferSource.start(0)`.
- `getUserMedia` constraints (109-116): `{audio: {echoCancellation: false, autoGainControl: false, noiseSuppression: false}}`, with the author's own comment *"not sure if these are necessary to have"*. They **are** necessary in spirit (AGC/NS would mangle the tones) — keep them, but note they are hints: Safari ignores some, and iOS applies voice-processing in some configurations.
- Capture (118-168): `bufferSize = 1024` (== `samplesPerFrame`), 1 in / 1 out channel, `createScriptProcessor` with `createJavaScriptNode` fallback, `mediaStream.connect(recorder)` **and `recorder.connect(context.destination)`** (the latter is needed for ScriptProcessor to fire in Chromium — **and it routes mic to speakers: a feedback/echo loop**, the demo never mutes it).
- Feed/decode (137-144): **streaming, one chunk per audio callback**, `ggwave.decode(instance, convertTypedArray(new Float32Array(source.getChannelData(0)), Int8Array))`. The `convertTypedArray` dance exists because the binding takes bytes (`std::string`) while the default `sampleFormatInp` is F32 → the float *bytes* must be passed. **Do not pass a `Float32Array` directly** (embind reads element values, not bytes).
- Result handling (141-144): `if (res && res.length > 0) rxData.value = new TextDecoder().decode(res)` → **the demo cannot distinguish "no signal" from "failed decode"** (§3).
- Stop (175-185): `recorder.disconnect(context.destination)`, `mediaStream.disconnect(recorder)`, `recorder = null` — but **`track.stop()` is never called**, so the mic indicator can stay on. Also called once at load to establish the "paused" state (187).
- `examples/buttons/index-tmpl.html` (best prior art in the repo): fixed-length mode (`parameters.payloadLength = 3`), `GGWAVE_PROTOCOL_DT_FAST`, `operatingMode = RX_AND_TX | USE_DSS` set explicitly, and **two separate module instances** (two factory calls) so it can talk to FluentPet buttons with a tweaked playback rate (`sampleRateOut = context.sampleRate - 512`, a device-clock-drift hack — and a good demonstration of "never change `sampleRate`"). It validates `res.length === kPayloadLength` and matches the content against a small vocabulary — **exactly the pattern a chat UI needs** (fixed size + app-level validation + only then render).

### 2.9 API gaps in the JS/WASM binding vs the C++ core

Exposed: `getDefaultParameters, init, free, encode, decode, disableLog, enableLog, rxToggleProtocol, txToggleProtocol, rxProtocolSetFreqStart, txProtocolSetFreqStart, rxDurationFrames` (+ enums/constants). Missing vs `GGWave` (`ggwave.h:690-775`):
- `rxFramesToRecord()` / `rxFramesLeftToRecord()` / `rxFramesToAnalyze()` / `rxFramesLeftToAnalyze()` → **the "decode failed" signal (`framesToRecord == -1`) is invisible from JS**; the C API doesn't expose them either (only `ggwave_rxDurationFrames`, a different thing, and only in the newer artifact).
- `rxTakeSpectrum()` / `rxTakeAmplitude()` → no spectrum/level metering for a UI visualiser.
- `rxStopReceiving()`, `rxReceiving()`, `rxAnalyzing()`, `rxDataLength()`, `rxProtocolId()`, `txTones()`, `txHasData()`, `computeFFTR()`, `filter()`, `heapSize()`, `txTakeAmplitudeI16()`.
- `ggwave_ndecode` (bounds-checked decode).

All of the above are ≤ a dozen lines of `emscripten::function` wrappers in `bindings/javascript/emscripten.cpp` — **if we need any, we must build our own wasm** (emsdk + `emcmake`, see README "### Emscripten"). Nothing in this clone is prebuilt except the two artifacts listed in §2.1.

---

## 3. Reliability characteristics

Files/paths covered: `src/ggwave.cpp` (decode paths 1057-1194, 1568-2045, marker logic 1782-1871, failure path 1755-1770), `src/reed-solomon/rs.hpp`, `tests/test-ggwave.cpp` (noise helper 134-170, loopback tests 203-319), `include/ggwave/ggwave.h` (docs 239-297), `examples/waver/common.cpp` (Rx handling 691-723, status UI 1586-1602), `examples/waver/README.md`.
Read in full: **YES** for the failure/robustness logic. Live measurements included (Node, clone artifact).

### 3.1 What decode returns on failure — and why JS can't see it

| layer | "nothing yet" | "received but RS failed" | "invalid usage" |
|---|---|---|---|
| `GGWave::decode()` (`ggwave.cpp:1057-1194`) | returns **true** | returns **true** | returns **false** (Rx disabled / Tx pending) |
| `ggwave_decode()` (`ggwave.cpp:137-161`) | `0` | **`-1`** (`m_rx.dataLength == -1` via `rxTakeData`) | `-1` |
| JS binding (`emscripten.cpp:82-96`) | zero-length view | **zero-length view** | zero-length view |

**Measured:** random noise → view of `length 0`; silence → `0`; valid message → `24`. So **in JS there is no way to distinguish "corrupted/attempted transmission" from "silence".** That kills the naive "show a 'message didn't come through' toast" design.
- The failure signal *does* exist one layer down (`m_rx.dataLength = -1`, `m_rx.framesToRecord = -1`, `ggwave.cpp:1757-1761`) and waver uses it (`common.cpp:693-705` → renders a `Message::Error` "Failed to decode"), but neither the C API nor the JS binding exposes `rxFramesToRecord`.
- `GGWave::decode()` returning `false` is nearly unreachable in practice (misuse only), so `false` never means "bad audio".

### 3.2 Integrity: what we get for free, and what we must add

- **The only integrity signal is the RS decoder's return code** (`rs.hpp:256`; 0 = success). No CRC, no MAC; the only extra sanity checks are `1 <= decodedLength <= 140` (`ggwave.cpp:1697`) and a frame-count cross-check (`ggwave.cpp:1702-1709`).
- "Corrected too many errors" is **not** a distinct state: RS either decodes (returning a codeword) or fails. A rare mis-decode (undetected error) is possible in principle; the length word is protected by RS(3,1) only (1 correctable error).
- Correction capacity (GF(256), 1 byte = 1 symbol): `t = ECC/2` → **12 byte-errors** for the 64-byte fixed payload (ECC 24) and **28** for the 140-byte variable payload (ECC 56) — ~13-14% of the payload may be corrupted outright.
- **Free win for us:** since HUSK Sound Chat encrypts anyway, an **AEAD/HMAC tag over the plaintext supplies exactly the authenticated-integrity signal the library lacks** — it upgrades "RS said OK" to "RS said OK *and* this is really the message". Put the tag inside the 64/140-byte payload and treat a tag failure exactly like a decode failure (ignore, wait for a retransmission). This is the key design consequence of §3.1.

### 3.3 Noise / volume / SNR

- The repo's own tests are **loopback only** (encode → add uniform noise → decode in-process; no speaker, no mic, no room, no resampling): `addNoiseHelper(0.02, …)` for variable-length and `0.10` for fixed-length (`tests/test-ggwave.cpp:280,309`) = ±1% / ±5% of full scale uniform noise on top of waveforms generated at volume 25 / 10. Unit-test thresholds, not field numbers.
- The only robustness knob is **`soundMarkerThreshold`** (default 3.0, `ggwave.h:428`): a marker is accepted only when the power ratio between adjacent tone bins exceeds this factor (`ggwave.cpp:1789-1791, 1844-1846`). Not settable after init — only via `ggwave_Parameters`.
- Amplitude-invariance: both decoders compare *relative* bin powers and the fixed-length path normalises its spectrum to uint8 by its own max (`ggwave.cpp:1898-1901`) → mic gain doesn't matter, **only SNR and clipping** do. Tx peak ≈ `volume/100` (coincident tones are summed then divided by the tone count); the header advises 25 and warns above 50 (`ggwave.h:185-186`). At volume 100 phase alignment can push samples past ±1.0 → clipping. **Use 25-50.**
- No AGC/limiter/equaliser/reverb rejection anywhere. Room reverb + speaker/mic response are the real limiters, and the 15-19.4 kHz ultrasound band is device-dependent — waver's README lists **"In some cases ultrasound transmission is not supported (see #5)"** as a known issue.

### 3.4 Fixed vs variable failure behaviour (a UI-shaping difference)

- **Variable-length**: after a start marker the Rx records up to `recvDuration_frames` frames, then brute-force analyses, then resets. **Measured `rxDurationFrames`: 1805 frames = 38.5 s with all 12 protocols enabled; 1214 frames = 25.9 s with only `ULTRASOUND_FAST`; 623 frames = 13.3 s with only `ULTRASOUND_FASTEST`** — matching the source formula `2*16 + maxFramesPerTx*(…/minBytesPerTx + 1)` (`ggwave.cpp:1818-1822`) with the all-enabled `maxFramesPerTx = 9`. Consequences:
  - A truncated/aborted transmission leaves the Rx in "receiving" for up to that whole window *of fed audio* → the listener is effectively deaf until it expires, and **the JS binding has no `rxStopReceiving`** (measured API list). The only JS-visible way to abort is to discard and re-`init` the Rx instance (22 MB re-alloc) — or feed it a non-empty `encode()` call, which internally re-runs `init()` and clears `receiving` (source-verified, not measured; passing an *empty* payload traps, see §5.3).
  - The 256-offset brute-force is the CPU spike (§2.6).
- **Fixed-length**: no markers, no recording window, no brute force — a rolling FFT window with a 75% tone quorum (`ggwave.cpp:2012`). Cheap and never "stuck"; but **no failure signal at all** — a lost block is invisible unless the app expects a message.
- **Measured duplicate behaviour (both modes):** the same audio re-decodes on every `decode()` call (variable-length returned 24 B a second time; a fixed-length block decoded 2-4× while inside the window). **The library does no dedupe.** waver compensates with a 0.5 s `ImGui::GetTime() - rxTimestampLast > 0.5f` guard (`common.cpp:706`) — we need the equivalent, keyed on our own message id.
- **Measured multi-message behaviour:** three back-to-back fixed-length blocks, chunk-fed at 1024 samples, decoded as tags `[1,1,1,2,2,2,3,3]` (all three recovered, each 2-3×). The **same** stream fed in one `decode()` call returned only the **last** block — `rxTakeData` holds a single "last message" slot. ⇒ **Iterate: decode chunk → drain result → next chunk.** Never decode one big accumulated buffer.
- **Measured latency:** one 64-byte fixed block = 1.92 s of audio (90 frames); the first decode lands at ≈1.88-1.92 s of fed audio (the sliding window must fill first). Variable-length AUDIBLE_FAST, 24 B = 2.22 s total, decodable only near the end of the audio.

---

## 4. Prior art / real-world usage signals

Files/paths covered: `examples/waver/*` (`common.cpp` Rx + status-UI regions 600-760 and 1580-1660, `README.md`, `main.cpp` CLI flags), `examples/buttons/index-tmpl.html`, `examples/ggwave-js/index-tmpl.html`, `examples/ggwave-wasm/main.js`, `examples/r2t2/README.md`, `CHANGELOG.md`, `LICENSE`, plus **external** signals: the upstream issue tracker (not part of this clone) and the npm registry.
Read in full: **NO** for `examples/waver/common.cpp` (1881 lines: I read the Rx/UI/decoder-callback regions and grepped the rest; the remainder is ImGui rendering). Everything else was read fully. `examples/ggwave-py/*`, `examples/arduino-*`, `examples/esp32-rx`, `examples/rp2040-rx`, `examples/spectrogram`, `examples/ggwave-to-file` were **not** read (peripheral to a web chat), except their READMEs where cited.

### 4.1 waver — the closest existing product to HUSK Sound Chat

- **Architecture**: sound-only messaging, no internet ("The app does not connect to the internet and all information is transmitted only through sound", `waver/README.md`) — literally the Sound Chat pitch. Its file-sharing mode uses a **sound "broadcast offer" and then TCP/IP for the file payload** ("The files are transmitted over TCP/IP. The sound message is used only to initiate the network connections") — the same "sound as out-of-band channel" pattern HUSK could use for pairing.
- **Failure UX (the part we can't copy in JS)**: `rxTakeData(...) == -1` → push a message of type `Message::Error` with text **"Failed to decode"** (`common.cpp:693-705`) — the only place in the repo that surfaces a decode failure, and it relies on APIs (`rxFramesToRecord`) the JS binding does not expose.
- **Dedupe**: `else if (rxDataLengthLast > 0 && ImGui::GetTime() - rxTimestampLast > 0.5f)` — a **0.5 s rate limit** on reporting decoded messages (`common.cpp:706`): upstream has the same duplicate-decode problem and papered over it with a time guard. (Our measured 2-4× duplicates during chunked streaming say a time guard is not enough; use a message id.)
- **Progress/cancel UX**: "Receiving ..." + `ProgressBar(1 - framesLeftToRecord/framesToRecord)` + a **Stop** button wired to `rxStopReceiving()` (`common.cpp:1586-1602`); "Analyzing ..." + `ProgressBar(1 - framesLeftToAnalyze/framesToAnalyze)`; when idle, "Listening for waves (fixed-length N bytes)" / "(variable-length)" (`common.cpp:1653-1657`). Note: Stop + analysis progress are **not reachable from JS** (only `rxDurationFrames`, and only in the newer artifact).
- **Settings exposed**: volume, Tx protocol, DSS toggle, fixed-length toggle with payload size `DragInt(..., 1, 1, GGWave::kMaxLengthFixed)` (`common.cpp:1217-1226`) — and the UI **disables MT protocols when variable-length is selected** (`common.cpp:628`), independently confirming §1.6.
- **Their own size estimate** (`common.cpp:2198`): `msgLength_bytes = 1.4f*payloadLength` — the authors' rule of thumb for ECC overhead, matching our `ECC/payload = 2/5` ⇒ 1.4× for large payloads.
- CLI (`examples/waver/main.cpp:21-33`): `-d` = DSS, `-l` = payloadLength → DSS off by default in their CLI.

### 4.2 buttons (FluentPet) — the second-most useful reference

Covered in §2.8: fixed-length 3-byte payloads, DT_FAST, explicit `RX_AND_TX | USE_DSS` operating mode, two module instances, and payload validated against a vocabulary before the UI reacts. A good template for "validate before render".

### 4.3 Known upstream issues (external — this clone has no issue tracker copy)

Fetched from the live repo this session:
- **#5 (Jan 2021, open, labels `bug` + `wasm`)**: *"on MacOS & iOS Safari, the Web Demo can getText from hearable sound but not from Ultrasound. They both work on Mac Chrome."* → **ultrasound + Safari is a known, unfixed problem** — exactly HUSK's likely platforms. Audible protocols were fine there.
- **#84 (Feb 2023, open)**: *"not able to receive any messages sent using the ultrasonic protocols … consistent across the .js based examples … Ultrasonic transfers have been working really well in the Python and C++ versions and with Waver as well"* on the same device → a **browser/JS-specific ultrasound failure nobody has fixed**. Strong argument for prototyping the mic path in-browser before committing to ultrasound.
- **#77 (Sep 2022, closed)**: ggwave.js lacks waver's options; also quotes the `ScriptProcessorNode` deprecation warning. Corroborates §2.9 and the deprecated-capture-path risk.
- waver README "Known issues": the browser build has no on-screen keyboard (mobile input impossible) and *"In some cases ultrasound transmission is not supported"* (#5).
- `CHANGELOG.md` history contains exactly one reliability note: v0.3.1 — *"Fix out-of-bounds access in `ggwave_decode` (#53)"* (2021). Relevant because the Rx path parses untrusted audio; see Risks.

### 4.4 License / attribution

- MIT (`LICENSE`, "Copyright (c) 2020 Georgi Gerganov"). The vendored Reed-Solomon has its own `src/reed-solomon/LICENSE` (not read; irrelevant if we consume the prebuilt wasm).
- Requirement for HUSK: keep the copyright + permission notice reachable (an attribution/licenses page); no copyleft, no source-disclosure duty.
- The repo ships **prebuilt binaries** (`bindings/javascript/ggwave.js`, 148 KB, committed). If we vendor it, record the SHA-256 (`F4BD5E9E3B79DB9C599D197C83D250E1A514C0295F4856A26065B6E427C252F3` for the clone copy; npm 0.4.0's is `F3792B5C185345A35A935CA68A5064B97F979D13FBBA0062FF16F6B3B31A6113`).

---

## 5. Extra findings (dead code, quirks, undocumented capabilities, footguns)

Files/paths covered: everything already listed, plus `src/ggwave.cpp:577-657` (alloc maths), `2047-2112` (protocol helpers), `src/CMakeLists.txt`, `bindings/javascript/.gitignore`, `examples/arduino-tx-obsolete/ggwave.h`.
Read in full: **YES** for all cited code.

### 5.1 `minBytesPerTx()` can never return anything but 1 — and the docs imply otherwise

`ggwave.cpp:2062-2072`:
```cpp
int GGWave::minBytesPerTx(const Protocols & protocols) const {
    int res = 1;                       // <-- initialised to 1, not INT_MAX
    for (...) { if (enabled) res = GG_MIN(res, (int) protocol.bytesPerTx); }
    return res;
}
```
Every real protocol has `bytesPerTx >= 1`, so the result is **always 1** regardless of which protocols are enabled. Consequence: `recvDuration_frames` is always computed with the worst-case `1` (`ggwave.cpp:1818-1822`); my measured 1214 frames for a single-protocol `ULTRASOUND_FAST` Rx comes from `maxFramesPerTx = 6` alone (6·197 + 32), **not** from a smaller `minBytesPerTx`. It also means **any enabled `CUSTOM_*` protocol (bytesPerTx = 0) forces `minBytesPerTx == 0` → integer division by zero in `alloc()`** (`ggwave.cpp:580`) → failed init / broken instance.

### 5.2 `CUSTOM_0..CUSTOM_9` are unusable and dangerous

- They are zero-initialised with `name = nullptr`, `enabled = false` (`ggwave.h:520-535`, `ggwave.cpp:506-511`), and the only public setters are `ggwave_rxProtocolSetFreqStart` / `ggwave_txProtocolSetFreqStart` — **there is no API to set `framesPerTx`/`bytesPerTx`/`extra`**. "Custom protocols" cannot be configured through the public API at all; the slots exist for a patched build.
- Enabling one (e.g. JS `rxToggleProtocol(GGWAVE_PROTOCOL_CUSTOM_0, 1)` before `init`) → `minBytesPerTx == 0` → division by zero / broken instance (§1.8). **Never enable them.**
- Conversely the `*ProtocolSetFreqStart` setters are a *genuine* undocumented gift: they move a protocol's band (push the audible band above speech, or park ultrasound at 17-19 kHz). Caveats: they mutate the **global** `Protocols::tx()/rx()` tables → must be called **before `init()`**, and they apply to every instance in the module; and pushing `freqStart` too high causes out-of-bounds spectrum indexing, because `decode_fixed` only checks `binStart > m_samplesPerFrame` (`ggwave.cpp:1924`) while indexing up to `binStart + 95` in an array of exactly `samplesPerFrame` (`m_rx.spectrum`). Keep `freqStart <= 1024 - 96 = 928` (and remember it's a *bin* index, so `freq = freqStart * 46.875 Hz` at defaults).

### 5.3 `encode()` with a zero-length payload traps the wasm module

**Measured:** `g.encode(inst, new Uint8Array(0), ULTRASOUND_FAST, 25)` throws **`divide by zero`** (a wasm trap) in the newer artifact. The C++ test calls `init(0, nullptr, …)` but never `encode()` after it. ⇒ **never send an empty payload**; guard in our wrapper.

### 5.4 Logging is ON by default and prints the decoded payload

- `FILE * g_fptr = stderr;` (`ggwave.cpp:38`) and `ggprintf` is a no-op only if `GGWAVE_DISABLE_LOG` is defined (it isn't in the emscripten build). So in a browser every marker/decoded message is written to the console, including `ggprintf("Received sound data successfully: '%s'\n", m_rx.data.data())` (`ggwave.cpp:1735, 2031`). In a browser the payload is bytes (ciphertext), so it's noise rather than a leak — but **call `disableLog()` in our wrapper**. `ggwave_setLogFile` is documented "not thread-safe … do not call while any GGWave instances are running" (`ggwave.h:161`).

### 5.5 Sample format is welded to the JS reinterpretation

- The JS binding always returns raw bytes; the examples reinterpret them as `Float32Array` because the default `sampleFormatOut` is F32. If we ever set `sampleFormatOut = I16` (removing the `outputTmp` traffic), the JS side **must** reinterpret as `Int16Array`, and the capture side must be converted to bytes to match. Assumptions here produce silently garbled audio with no error.
- Internal detail: for `I16` output the C++ returns `m_tx.outputI16`, for every other format `m_tx.outputTmp` (`ggwave.cpp:1218-1235`); both are copied into the binding's static vector, so the JS contract is stable either way.

### 5.6 `TX_ONLY_TONES` + `txTones()` — a capability we don't need but should know exists

- `GGWAVE_OPERATING_MODE_TX_ONLY_TONES` + `txTones()` return a list of tone **bin indices** (with `-1` separators between simultaneous tones, `ggwave.h:546-558`, `ggwave.cpp:822-881`) instead of a waveform — "play the tones with your own synth" (PC-speaker `r2t2`, Arduino `arduino-tx`, embedded buzzer). Useful if HUSK ever wants a hardware/low-power beacon.
- ️ Quirk: for **MT** protocols the tone list emits **one tone per frame** (`2*i + i%2`) for the marker frames, while the waveform generator emits **all 16 marker tones simultaneously** (`ggwave.cpp:824-827` vs `925-931`). So `txTones()` is not a faithful description of the MT waveform. (I did **not** check which protocol the Arduino examples consume the list with — UNVERIFIED whether it bites in practice.)

### 5.7 Unused/unexposed helpers

- `GGWave::filter()` (Hann/Hamming/first-order high-pass, `ggwave.cpp:1337-1404`) and `computeFFTR()` are public C++ helpers used only by `examples/spectrogram` — not exposed to JS. A ready-made spectrum-visualiser foundation if we ever build our own binding.
- `examples/arduino-tx-obsolete/ggwave.h` is a **stale 753-line vendored copy** of the header inside an "obsolete" example dir — don't grep it as the real API.

### 5.8 Leftover experiments in the source (maturity signal)

- `// note : what is the purpose of this shuffle ? I forgot .. :(` followed by a commented-out `std::shuffle` of the Tx phase offsets (`ggwave.cpp:889-893`).
- Commented-out `ggalloc` overloads (`ggwave.cpp:401-428`), a commented-out `float→uint16` spectrum-history variant (`:1903-1907`), a commented-out I16 output copy in `encode` (`:1032-1035`), and an obsolete JS-resampling block in the browser example (`index-tmpl.html:146-161`).
- The `GG_MIN/GG_MAX` macros, the `int res = 1` initialisation bug (§5.1) and the MT marker-tone inconsistency (§5.6) together say: **hobby-grade codebase with real-world mileage. Great protocol, thin engineering hygiene** — its edge cases are ours to defend against.

### 5.9 Nothing here is addressed, sessioned, or replay-protected

- ggwave is a **broadcast medium with no addressing**: any receiver in range with the protocol enabled decodes any transmission (the `buttons` demo literally listens for a vocabulary of 3-byte commands). Identity, pairing, key agreement, freshness and dedupe are **entirely our layer**.
- The Tx waveform is **deterministic** — same payload + protocol + volume ⇒ byte-identical audio (the only randomisation in the code is commented out, §5.8). An eavesdropper can capture and replay a transmission bit-exactly. ⇒ our crypto layer **must** carry a nonce/counter, and the app **must** dedupe by message id.
- One-to-many is free (one transmission, many listeners) — nice for a room-broadcast mode — but there is **no collision avoidance**: two devices transmitting in the same band at the same time destroy each other. HUSK needs its own "who may speak" discipline (hold-to-talk / token / random backoff).

### 5.10 Server-side waveform generation exists (anti-pattern for us)

`examples/ggwave-to-file/README.md` documents an HTTP service: `curl 'https://ggwave-to-file.ggerganov.com/?m=Hello%20world!&p=4' -o hello.wav`, with local `.py`/`.php` variants in the same folder. Handy for demos/CDN-cached "audio QR codes", but it hands the payload to a third-party server → **never use it for an E2E-encrypted chat mode**. Listed because it is exactly the kind of shortcut a future implementer might reach for.

### 5.11 PairSonic is referenced but not in this repo

`README.md:42` lists **PairSonic** (seemoo-lab) as prior art for "Exchange contact information and public keys with nearby devices" using ggwave. Not vendored here; worth chasing separately — it is the closest published design to the pairing/key-exchange half of our problem.


---

## Risks & Gotchas

Ordered roughly by "how likely this bites us". Severity is my judgement, not upstream's.

1. **CSP blocks the wasm (HIGH, will 100% bite).** HUSK's `buildCsp()` (`src/server.ts:35-52`) emits `script-src 'self' <hashes>` with no `'wasm-unsafe-eval'`. `WebAssembly.instantiate` will be refused in Chromium (and per spec/docs in FF 102+/Safari 16+). Fix: append `'wasm-unsafe-eval'` to `script-src`; do **not** reach for `'unsafe-eval'`.
2. **The npm artifact needs `'unsafe-eval'` on top of that (HIGH if we use `pnpm add ggwave`).** Its glue calls `new Function` at load (measured, via `createNamedFunction`); the clone's newer artifact has zero `new Function` (measured). ⇒ vendor the newer artifact or rebuild.
3. **`pnpm add ggwave` installs a 4-year-old build (HIGH).** npm `latest` = 0.4.0 / 2022-07-05 while the tree is 0.4.3+ and a newer artifact was committed 2023-09. Missing: MT protocols, `rxDurationFrames`, `rxProtocolSetFreqStart`.
4. **CJS/UMD, no types, `require("fs")/require("path")` inside (MEDIUM).** Expect a Vite `optimizeDeps` fight; we must ship our own `.d.ts`. (Not verified against Vite 8 — spike early.)
5. **Bundle growth ~+60 KB gzipped (MEDIUM-HIGH vs the ~95 KB main bundle).** Dynamic `import()` behind the Sound Chat entry only.
6. **Returned typed-array views silently empty / alias static buffers (HIGH).** Measured: a view was 425,984 B, then `0` after another `init()`; every `encode`/`decode` overwrites the same static C++ buffer. **Copy immediately**; never hold a view or a waveform across another ggwave call.
7. **Only 4 instances per module; misusing a −1 id aborts the wasm module (HIGH).** Measured `0,1,2,3,-1,-1`; `encode(−1)`/`decode(−1)` rejected with numeric reasons (wasm abort), not typed errors. Check `id >= 0`, always `free()`, wrap calls in try/catch — a trapped module is dead for the page session.
8. **Silent truncation at 140 bytes (HIGH).** Over-limit input logs to stderr and reports success. Our chunker's tests must assert the encoded length, not "it returned".
9. **No JS-visible "decode failed" signal (HIGH — shapes the UX).** `-1` becomes a zero-length view, indistinguishable from silence. Mitigate with AEAD-tag detection + retransmission, or build a binding exposing `rxFramesToRecord`.
10. **No dedupe: the same audio re-decodes (HIGH).** Measured 2-4× per block. Without a message id we will render duplicate messages.
11. **One `decode()` spanning several messages loses all but the last (HIGH).** Measured (3-block stream → only tag 3). Stream chunk-by-chunk and drain after each chunk.
12. **`encode()` resets the receiver on the same instance (HIGH).** `ggwave_encode` → `init()` clears Rx state. Never Tx and Rx on one instance; pause capture while sending.

13. **A stuck variable-length reception window (MEDIUM).** Measured 623-1805 frames (13.3-38.5 s); **no `rxStopReceiving` in JS** → no cancel button; the analysis burst is the CPU spike. Fixed-length mode avoids both.
14. **`encode()` with an empty payload traps the module (MEDIUM).** Measured `divide by zero`.
15. **`CUSTOM_*` protocols are a loaded gun (MEDIUM).** Enabling one ⇒ `minBytesPerTx == 0` ⇒ division by zero / broken instance; `*ProtocolSetFreqStart` above ~928 bins indexes out of bounds (`m_rx.spectrum` is `samplesPerFrame` long). Clamp hard if we use band-shifting.
16. **Wrong operating `sampleRate`/`samplesPerFrame` = unfixable interop failure (MEDIUM, easy to cause while "optimising").** Tones are bin-index based; both ends must use 48000/1024. Only `sampleRateInp/Out` may vary. Document as protocol constants and assert at init.
17. **Invalid `sampleRateInp` (>96 kHz) or `payloadLength` (>64) ⇒ broken instance, silently (MEDIUM).** `ggwave_init` still returns an id; the next call aborts the module. Clamp/validate before `init`.
18. **Untrusted-audio parser with a memory-bug history (MEDIUM).** `CHANGELOG` v0.3.1 fixed an OOB in `ggwave_decode`; Resampler asserts aren't structurally guaranteed (and are compiled out in Release); `decode_fixed` indexes `binStart+95` behind a weaker check. In wasm the blast radius is module memory (no host RCE), but a corrupt decode can corrupt what we hand to crypto. ⇒ **always validate length + our AEAD tag before trusting.**
19. **~22 MB heap per instance (MEDIUM).** One Tx + one Rx ≈ 35-45 MB wasm memory (grow-on-demand); four instances ≈ 85 MB. Memory growth is also what detaches views (item 6).
20. **Deprecated capture path (MEDIUM, in 2026).** Upstream's only browser pattern is `createScriptProcessor` + a mic→destination loop. If we move to `AudioWorklet`, its module URL is governed by `script-src`, and a *worker* would need its own 22 MB module instance.
21. **Ultrasound is not trustworthy in browsers (HIGH for the "near-inaudible" pitch).** Issues #5 (open since 2021: Safari cannot receive ultrasound) and #84 (open since 2023: JS examples cannot receive ultrasound while Python/C++/Waver can on the same device) are unresolved. The band also tops out at 19.45 kHz — audible to many, unreproducible on some speakers. ⇒ **audible default**, ultrasound opt-in with a self-test, honest UI copy.
22. **Feedback / self-reception (MEDIUM).** The demo connects the mic node to the audio destination so ScriptProcessor fires; with our own tones playing we will re-decode our own transmission. No addressing ⇒ "ignore messages from me" must be part of dedupe.
23. **`soundMarkerThreshold` is init-only (LOW).** A live "sensitivity" slider would mean re-`init()` (22 MB churn) — make it a settings-time property.
24. **Replay / no freshness (MEDIUM, crypto design).** Deterministic waveforms + no nonce ⇒ trivial replay for anyone who records our audio. Mitigation lives in our crypto layer, not ggwave.
25. **Recon hygiene.** The clone is ignored only via an **uncommitted** `.gitignore` edit; `git checkout`/`stash` would expose ~11 MB of untracked library source to `git status`. Commit that line (or move the clone out of the repo) before implementation.

---

## Opportunities & Recommendations for HUSK Sound Chat

My synthesis, not a recap. Verdicts marked **[measured]** were executed against the real wasm; **[source]** are derived from code I read; **[UNVERIFIED]** still needs a browser test.

### The decision the evidence points at

**Use ggwave's fixed-length mode (64 B) + our own framing + our own AEAD tag. Do not use DSS. Do not use the npm package as-is. Do not commit to ultrasound.**

### 1. Fixed-length 64-byte payloads, one message per transmission **[measured]**

- Kills the 683 ms marker tax and the 3-byte header (a 64-B block is exactly **1.92 s** on FASTEST — measured 368,640 B / 90 frames, decode returned exactly 64 B with our prefix intact and zero padding).
- Removes the two worst Rx behaviours: the 13.3-38.5 s stuck reception window **[measured]** and the 256-offset brute-force CPU spike (the fixed path is a rolling window with a 75% tone quorum, `ggwave.cpp:2012`).
- Cuts Rx heap from ~8.5 MB to ~0.2 MB (the 8 MB `amplitudeRecorded` exists only in variable-length mode, `ggwave.cpp:611-618`).
- Free "signal present?" gate (75% quorum) before RS even runs.
- Cost we own: **no length field** → put `len` in our header; **no dedupe** → put a `msgId` in our header; **padded to 64 B** → fine.
- Multi-block streaming works **[measured]**: 3 back-to-back blocks decoded as tags `[1,1,1,2,2,2,3,3]` when chunk-fed → chunk-feed + drain + dedupe by msgId is the whole story.

### 2. Payload layout inside the 64 bytes

```
ver(1) | msgId(2) | fromPeerId(1) | len(1) | AEAD ciphertext+tag (up to 59) | pad to 64
```
- With a 16-byte AEAD tag (AES-GCM / ChaCha20-Poly1305) and a 4-byte header that leaves **39 bytes of plaintext**; long messages = multiple blocks with a `seq` field.
- **The AEAD tag is the integrity signal the library cannot give us** (`§3.1/§3.2`): JS cannot distinguish "failed decode" from "silence", so our tag *is* the failure detector — and it also defends against the decoder's rare mis-decodes and its memory-safety history (Risks 18).
- Nonce from `msgId`/counter — waveforms are deterministic **[source]**, so without a nonce every message is trivially replayable.

### 3. Which protocol: AUDIBLE_FASTEST for v1, ULTRASOUND_FASTEST opt-in

- Same wire rate for both (33 B/s payload at FASTEST); only the band differs (1875-6328 Hz vs 15000-19453 Hz).
- **Ultrasound is the riskiest browser path**: open issues #5 (Safari can't receive ultrasound, since 2021) and #84 (JS examples can't receive ultrasound while Python/C++/Waver can on the same device, since 2023), plus the 19.45 kHz ceiling. Ship audible first; add an "ultrasound self-test" before ever offering it.
- **Skip DT/MT**: DT halves the rate (5.5-15.6 B/s), MT is 2.6-7.8 B/s and rejected in variable-length mode; their 1125-2578 Hz band is the worst for speech/music interference. They exist for $3 microcontrollers, not browsers.

### 4. Skip DSS entirely

Zero wire cost, zero reliability benefit, and upstream's own test disables it for variable-length because it triggers early end-marker detection (`tests/test-ggwave.cpp:268-270`). It's a public XOR mask (`ggwave.cpp:236-241`) — no obfuscation value. Keep `operatingMode` plain: `RX` on the Rx instance, `TX` on the Tx instance.

### 5. Two instances, never one **[measured]**

- `encode()` resets Rx state on the same instance (`ggwave_encode` → `init()`, `ggwave.cpp:746-762`), and `decode()` refuses to run while Tx is pending. One **Rx-only** instance (always listening) + one **Tx-only** instance = 2 of 4 slots, ≈22 MB total.
- Don't re-`init` per message; the Tx path's `outputTmp`/`outputI16` (~12 MB) are unavoidable.

### 6. Binding choice — three tiers, pick one explicitly

| option | what you get | what you give up |
|---|---|---|
| **A. Vendor the clone's `bindings/javascript/ggwave.js`** (148 KB, sha `F4BD5E9E…`) | newest available artifact; MT + `rxDurationFrames` + freqStart setters; no `new Function` (CSP-friendly) | no failure/progress signal, no cancel; stale vs HEAD (2023-09) |
| **B. `pnpm add ggwave@0.4.0`** | simplest | 2022 build, no MT, no freqStart, **`new Function` at load ⇒ breaks under our CSP**, different `ProtocolId` numbering |
| **C. Build our own wasm with a ~30-line `emscripten.cpp` patch** | everything in A **plus** `rxFramesToRecord`, `rxFramesLeftToRecord`, `rxReceiving`, `rxStopReceiving`, a `decodeEx` returning `{len, protocolId}`, optionally `rxTakeSpectrum` for a visualiser | emsdk in CI + vendored-artifact hash; upstream drift |

- **Start at A** (fastest to ship, CSP-clean); **move to C when we want a real "receiving… / failed / retry" UX** — the C++ API already has all of it (`ggwave.h:735-762`), the shipped JS binding just doesn't expose it. waver's UI (`common.cpp:1586-1602`) is the blueprint and is unreachable through the shipped binding.
- If we stay on A permanently: accept no failure signal, implement retransmission (send each block 2-3×, dedupe by msgId — **[measured]** repeats decode multiple times and msgId absorbs that), and drive progress purely from our own protocol.

### 7. Capture/playback pipeline (copy the demo's structure, fix its bugs)

- `AudioContext({sampleRate: 48000})`; `sampleRateInp = sampleRateOut = context.sampleRate`; **never touch `parameters.sampleRate`/`samplesPerFrame`** (protocol constants; a mismatch is an unfixable interop failure, §1.7).
- `getUserMedia({audio: {echoCancellation: false, autoGainControl: false, noiseSuppression: false}})` — keep all three.
- `ScriptProcessor(1024, 1, 1)` for v1 (matching `samplesPerFrame`), but **do not connect it to `context.destination`** unless through a `GainNode(gain=0)`; the demo's mic→speaker loop feeds back.
- Reinterpret float↔bytes exactly like the demo (`convertTypedArray(new Float32Array(chunk), Int8Array)`); never pass a `Float32Array` to `decode` directly.
- **Copy every result out of the returned view immediately** (`Uint8Array.from(view)`) — views alias static buffers and are detached by heap growth **[measured]**.
- Stop cleanly: `track.stop()` on all tracks (the demo leaks the mic indicator) + ordered disconnects.
- AudioWorklet/MediaRecorder: **zero usage anywhere in the repo**; the binding is main-thread blocking but cheap in steady state (measured ~1.35 ms per whole-buffer decode with one Rx protocol). Defer the Worker/AudioWorklet question until measured in-browser; a Worker needs its own module instance (+22 MB).

### 8. Free wins from the library (use them)

- **`rxToggleProtocol` before `init()`** → ~5× cheaper decode **[measured 135 ms → 27 ms per 20 calls]** and fewer false positives. Enable exactly one Rx protocol per session.
- **`rxProtocolSetFreqStart` / `txProtocolSetFreqStart`** (newer artifact only) → move the band as a "room channel"/interference dodge; set before `init`, clamp to `freqStart ≤ 928`.
- **`disableLog()`** → stops the default console noise/payload dumps **[source]**.
- One-to-many broadcast is free; `TX_ONLY_TONES` exists if we ever want a hardware beacon.

### 9. Avoid outright

DSS (§1.5); DT/MT for a browser chat (§1.3); variable-length for a chat UI (§3.4); the `ggwave-to-file` HTTP service (§5.10 — third-party plaintext); empty-payload `encode()` (§5.3); `CUSTOM_*` protocols (§5.2); any "optimisation" that changes `sampleRate`/`samplesPerFrame`; and any "message didn't arrive" UI built on the library's return value — it doesn't exist; build it on our AEAD tag + a retransmit timer.

### 10. Server changes (beyond what was already planned)

- **`src/server.ts`: add `'wasm-unsafe-eval'` to `script-src`** — mandatory, or the wasm never compiles. The single most important finding in this file.
- **No COOP/COEP needed** (no SharedArrayBuffer, no pthreads — measured on both artifacts) → zero cross-origin-isolation work.
- Permissions-Policy: none is set today, so `microphone` is unrestricted; if we add one, include `microphone=(self)`.
- `media-src` is likely unnecessary (WebAudio playback isn't CSP-`media-src`-governed); revisit only if we use `<audio>`/blob playback or AudioWorklets.

### 11. Honest framing for the feature

- 64 B per 1.92 s ⇒ ~33 B/s ⇒ a 160-character message is **~4 blocks ≈ 8 s of sound** on FASTEST (~15 s on FAST). It's a "short notes, hold-to-talk" experience, not a messenger — set copy and expectations accordingly.
- "Near-inaudible" is only honest for ultrasound on hardware that can do it, and ultrasound is today's least reliable browser path (Risks 21). Audible mode will be clearly heard by everyone nearby — arguably the correct UX for an air-gapped chat (both parties see the transmission happen).
- ggwave is broadcast, unauthenticated, replayable, collision-prone; **all** security properties live in our crypto layer; the UI must own "transmitting…" / "receiving…" states because the library cannot.

### 12. Cheapest possible spike before committing (≤1 day)

1. Vendor the artifact + `'wasm-unsafe-eval'` in CSP; confirm the module loads under HUSK's CSP in Chrome/Safari/Firefox.
2. Two instances (Tx-only, Rx-only), `rxToggleProtocol` to one protocol, fixed `payloadLength = 64`; confirm round-trip.
3. Real mic → real speaker loopback on the two target platforms (this is exactly where upstream's open issues live).
4. Measure: decode cost per 21 ms chunk, wasm memory growth, duplicate-decode rate, and whether ultrasound is receivable at all on a MacBook + an iPhone.
