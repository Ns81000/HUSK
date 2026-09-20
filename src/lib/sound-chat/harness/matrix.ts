/**
 * The Phase 0 simulated-acoustic degradation matrix (master plan Section 7
 * steps 5-7). One definition, consumed by two runners:
 * - `spike/matrix.test.ts` — in-process, codec only, no browser.
 * - `harness/fake-mic.spec.ts` — the real capture pipeline in Chromium with the
 *   impaired WAV as the fake microphone.
 *
 * `expectation` is the contract each runner asserts:
 * - `decode`: every payload in `expected` must come back byte-exact.
 * - `graceful`: no crash, no hang, and anything decoded must be one of
 *   `allowed` (never garbage) — decoding nothing is also a pass.
 * - `silence`: nothing may decode at all.
 *
 * `expectation` per variant is not a wish: each value is the outcome measured
 * for that variant, in-process first (see `spike/matrix.test.ts` output and
 * `prompts/sound-chat/SOUND_CHAT_LOG.md`). Variants that were left permissive
 * before measuring are tightened here.
 */

import type { MicrophoneProfile } from "../spike/audio-io";
import {
  addPinkNoise,
  addWhiteNoise,
  applyGainDb,
  hardClip,
  overlay,
  resample,
  trimStart,
  withDropouts,
  withEcho,
} from "../spike/degrade";
import { FOREIGN_PAYLOAD, PRIMARY_PAYLOAD, SEQUENCE_PAYLOADS, type TestPayload } from "./payloads";

export type VariantExpectation = "decode" | "graceful" | "silence";

/** The 48 kHz waveform one transmitted block occupies. */
export type EncodeBlock = (payload: TestPayload) => Float32Array;

export type ChannelVariant = {
  id: string;
  label: string;
  expectation: VariantExpectation;
  /** Payloads the transmitter sends, in order, separated by silence. */
  payloads: TestPayload[];
  /** Every payload that must decode byte-exact. */
  expected: TestPayload[];
  /**
   * Every payload that may legitimately appear. Broader than `expected` where a
   * degradation has more than one valid outcome (cross-talk, collisions): a
   * payload from this list is never treated as garbage, but only `expected` is
   * required.
   */
  allowed: TestPayload[];
  /** Builds the waveform the fake microphone will hear, at 48000 Hz. */
  build: (encode: EncodeBlock) => Float32Array;
  /** Requested AudioContext rate (device-side, not the codec's 48000 constant). */
  deviceRate: number;
  /** Sample rate the WAV file is written at. */
  wavRate: number;
  /** Simulated "we are transmitting too" behaviour in the page. */
  selfTransmit: "none" | "listen" | "pause-listening";
  /** How long the page captures for, in ms. */
  captureMs: number;
  /**
   * Stop capturing this long after the last decode. `0` disables the early exit,
   * which a multi-block transmission needs: the page would otherwise end the run
   * 700 ms after the first block and never see the rest of the sequence.
   */
  settleAfterDecodeMs: number;
  /** Which WebRTC audio-processing chain the page asks the browser for. */
  profile: MicrophoneProfile;
  /** False for variants that only exist in a browser (device rate, mic chain). */
  inProcess: boolean;
  /** Human note for the log: what the variant is meant to prove. */
  note: string;
};

type VariantSpec = {
  id: string;
  label: string;
  expectation: VariantExpectation;
  note: string;
  build: ChannelVariant["build"];
  payloads?: TestPayload[];
  expected?: TestPayload[];
  allowed?: TestPayload[];
  deviceRate?: number;
  wavRate?: number;
  selfTransmit?: ChannelVariant["selfTransmit"];
  captureMs?: number;
  settleAfterDecodeMs?: number;
  profile?: MicrophoneProfile;
  inProcess?: boolean;
};

const RATE = 48000;

function resolve(spec: VariantSpec): ChannelVariant {
  const payloads = spec.payloads ?? [PRIMARY_PAYLOAD];
  return {
    id: spec.id,
    label: spec.label,
    expectation: spec.expectation,
    payloads,
    /**
     * A graceful variant may decode nothing, but whatever it decodes must be a
     * byte-exact payload from this same variant — never a blend or garbage.
     */
    expected: spec.expected ?? payloads,
    allowed: spec.allowed ?? spec.expected ?? payloads,
    build: spec.build,
    deviceRate: spec.deviceRate ?? RATE,
    wavRate: spec.wavRate ?? RATE,
    selfTransmit: spec.selfTransmit ?? "none",
    captureMs: spec.captureMs ?? (spec.expectation === "decode" ? 4200 : 5200),
    /** One transmission may end early; several must be waited out in full. */
    settleAfterDecodeMs: spec.settleAfterDecodeMs ?? (payloads.length > 1 ? 0 : 700),
    profile: spec.profile ?? "clean",
    inProcess: spec.inProcess ?? true,
    note: spec.note,
  };
}

export function silence(ms: number, rate = RATE): Float32Array {
  return new Float32Array(Math.round((ms / 1000) * rate));
}

export function concat(...buffers: Float32Array[]): Float32Array {
  const total = buffers.reduce((sum, buffer) => sum + buffer.length, 0);
  const out = new Float32Array(total);
  let offset = 0;
  for (const buffer of buffers) {
    out.set(buffer, offset);
    offset += buffer.length;
  }
  return out;
}

/** Shifts the waveform later in time by inserting silence in front of it. */
export function withLeadIn(samples: Float32Array, ms: number, rate = RATE): Float32Array {
  return concat(silence(ms, rate), samples);
}

/** Rewrites a 48 kHz waveform at another rate, for a WAV a real device plays. */
function atRate(samples: Float32Array, rate: number): Float32Array {
  return rate === RATE ? samples : resample(samples, RATE, rate);
}

const baseline: ChannelVariant["build"] = (encode) => encode(PRIMARY_PAYLOAD);

function sameLength(id: string, clean: Float32Array, out: Float32Array): Float32Array {
  if (out.length !== clean.length) {
    throw new Error(
      `${id}: impairment changed the sample count (${clean.length} -> ${out.length})`,
    );
  }
  return out;
}

/** Builds one impaired copy of a single transmitted block. */
function impairing(
  id: string,
  mutate: (clean: Float32Array) => Float32Array,
  payload: TestPayload = PRIMARY_PAYLOAD,
): ChannelVariant["build"] {
  return (encode) => sameLength(id, encode(payload), mutate(encode(payload)));
}

const NOISE_SWEEP: { snrDb: number; expectation: VariantExpectation }[] = [
  { snrDb: 40, expectation: "decode" },
  { snrDb: 30, expectation: "decode" },
  { snrDb: 20, expectation: "decode" },
  { snrDb: 12, expectation: "decode" },
  { snrDb: 6, expectation: "decode" },
  { snrDb: 0, expectation: "decode" },
  { snrDb: -6, expectation: "decode" },
  { snrDb: -12, expectation: "graceful" },
];

const WHITE_NOISE_VARIANTS: VariantSpec[] = NOISE_SWEEP.map(({ snrDb, expectation }) => ({
  id: `white-noise-${snrDb}db`,
  label: `white noise, ${snrDb} dB SNR`,
  expectation,
  note: "Uniform white noise (what ggwave's own loopback tests inject), scaled to an explicit SNR.",
  build: impairing(`white-noise-${snrDb}db`, (clean) => addWhiteNoise(clean, snrDb, 11)),
}));

const PINK_NOISE_SPECS: { snrDb: number; expectation: VariantExpectation }[] = [
  { snrDb: 24, expectation: "decode" },
  { snrDb: 12, expectation: "decode" },
  { snrDb: 0, expectation: "decode" },
];

const PINK_NOISE_VARIANTS: VariantSpec[] = PINK_NOISE_SPECS.map(({ snrDb, expectation }) => ({
  id: `pink-noise-${snrDb}db`,
  label: `pink noise, ${snrDb} dB SNR`,
  expectation,
  note: "Low-frequency-weighted noise: a room with speech or music in it, not hiss.",
  build: impairing(`pink-noise-${snrDb}db`, (clean) => addPinkNoise(clean, snrDb, 12)),
}));

const LEVEL_VARIANTS: VariantSpec[] = [
  {
    id: "clip-0.06",
    label: "hard-clipped at 0.06 (maxed phone speaker)",
    expectation: "decode",
    note: "The waveform peaks at 0.242, so a 0.06 ceiling flattens most of it.",
    build: impairing("clip-0.06", (clean) => hardClip(clean, 0.06)),
  },
  {
    id: "clip-0.02",
    label: "hard-clipped at 0.02 (severe)",
    expectation: "decode",
    note: "Deliberately past the point of usability: must fail without returning garbage.",
    build: impairing("clip-0.02", (clean) => hardClip(clean, 0.02)),
  },
  {
    id: "gain-plus-12db",
    label: "+12 dB (loud device, no clipping)",
    expectation: "decode",
    note: "Peak becomes ~0.963: the decoder compares relative bin powers, so level should not matter.",
    build: impairing("gain-plus-12db", (clean) => applyGainDb(clean, 12)),
  },
  {
    id: "gain-minus-20db",
    label: "-20 dB (quiet device)",
    expectation: "decode",
    note: "A phone at low volume.",
    build: impairing("gain-minus-20db", (clean) => applyGainDb(clean, -20)),
  },
  {
    id: "gain-minus-40db",
    label: "-40 dB (very quiet device)",
    expectation: "decode",
    note: "1/100 of nominal level: close to the 16-bit noise floor, so decode is not guaranteed.",
    build: impairing("gain-minus-40db", (clean) => applyGainDb(clean, -40)),
  },
  {
    id: "gain-minus-60db",
    label: "-60 dB (effectively silent)",
    expectation: "decode",
    note: "Quantised to a handful of LSBs: must not decode, must not error.",
    build: impairing("gain-minus-60db", (clean) => applyGainDb(clean, -60)),
  },
];

const DROPOUT_VARIANTS: VariantSpec[] = [
  {
    id: "dropouts-3x8ms",
    label: "3 x 8 ms dropouts",
    expectation: "decode",
    note: "Short zeroed segments: capture-buffer glitches, well inside Reed-Solomon capacity.",
    build: impairing("dropouts-3x8ms", (clean) =>
      withDropouts(clean, { count: 3, dropoutMs: 8, sampleRate: RATE, seed: 21 }),
    ),
  },
  {
    id: "dropouts-6x8ms",
    label: "6 x 8 ms dropouts",
    expectation: "decode",
    note: "48 ms of audio zeroed, spread over the block.",
    build: impairing("dropouts-6x8ms", (clean) =>
      withDropouts(clean, { count: 6, dropoutMs: 8, sampleRate: RATE, seed: 22 }),
    ),
  },
  {
    id: "dropouts-40x4ms",
    label: "40 x 4 ms dropouts",
    expectation: "decode",
    note: "160 ms zeroed (8% of the block) in 40 pieces: near or past the RS limit.",
    build: impairing("dropouts-40x4ms", (clean) =>
      withDropouts(clean, { count: 40, dropoutMs: 4, sampleRate: RATE, seed: 23 }),
    ),
  },
  {
    id: "dropouts-1x300ms",
    label: "one 300 ms dropout (15% of the block)",
    expectation: "graceful",
    note: "Contiguous loss of a sixth of the transmission: beyond RS capacity (12 of 64 bytes).",
    build: impairing("dropouts-1x300ms", (clean) =>
      withDropouts(clean, { count: 1, dropoutMs: 300, sampleRate: RATE, seed: 24 }),
    ),
  },
];

/**
 * Chunk-boundary misalignment: the capture starts mid-transmission, at an
 * offset that need not be a multiple of the 1024-sample ScriptProcessor buffer.
 * That is what really happens — the receiver has no idea when the sender began.
 *
 * Measured, in-process against the locked codec configuration: the block still
 * decodes with up to 8192 samples missing from its front (one ninth of the
 * 92160-sample block, within Reed-Solomon capacity), and stops decoding
 * entirely — without an error — from 21504 samples up, where the 90-frame
 * window can no longer hold a whole block. See `SOUND_CHAT_LOG.md`.
 */
const TRIM_SPECS: { offset: number; expectation: VariantExpectation }[] = [
  { offset: 1, expectation: "decode" },
  { offset: 512, expectation: "decode" },
  { offset: 1023, expectation: "decode" },
  { offset: 1024, expectation: "decode" },
  { offset: 1025, expectation: "decode" },
  { offset: 2048, expectation: "decode" },
  { offset: 4096, expectation: "decode" },
  { offset: 8192, expectation: "decode" },
  { offset: 21504, expectation: "graceful" },
  { offset: 46080, expectation: "graceful" },
  { offset: 89000, expectation: "graceful" },
  { offset: 91136, expectation: "graceful" },
  { offset: 92160, expectation: "graceful" },
];

const TRIM_VARIANTS: VariantSpec[] = TRIM_SPECS.map(({ offset, expectation }) => ({
  id: `trim-${offset}`,
  label: `capture starts ${offset} samples into the block`,
  expectation,
  note:
    `WAV begins ${offset} samples (${((offset / RATE) * 1000).toFixed(1)} ms) into the transmission` +
    (expectation === "decode"
      ? ": the lost tone groups are inside RS capacity."
      : ": no whole block fits any window, so nothing may decode."),
  build: (encode) => trimStart(encode(PRIMARY_PAYLOAD), offset),
}));

const RESAMPLE_VARIANTS: VariantSpec[] = [
  {
    id: "resample-44k-round-trip",
    label: "48000 -> 44100 -> 48000",
    expectation: "decode",
    note: "Mild device-rate resample artifacts (interpolator loss at the band edges) — measured to decode.",
    build: impairing("resample-44k", (clean) =>
      resample(resample(clean, 48000, 44100), 44100, 48000),
    ),
  },
  {
    id: "resample-32k-round-trip",
    label: "48000 -> 32000 -> 48000",
    expectation: "decode",
    note: "Stronger: 32 kHz cannot represent anything above 16 kHz — the audible band survives anyway.",
    build: impairing("resample-32k", (clean) =>
      resample(resample(clean, 48000, 32000), 32000, 48000),
    ),
  },
  {
    id: "resample-22k-round-trip",
    label: "48000 -> 22050 -> 48000",
    expectation: "decode",
    note: "Worst case: cuts at 11 kHz, above the 6328 Hz top tone but with heavy interpolation error.",
    build: impairing("resample-22k", (clean) =>
      resample(resample(clean, 48000, 22050), 22050, 48000),
    ),
  },
];

/**
 * Device-rate variants: the AudioContext and the WAV do not agree with the
 * codec's 48000 operating rate, so the resampler — and Chromium's own device
 * converter — is in the path. Browser-only: there is no capture device in Node.
 */
const DEVICE_RATE_VARIANTS: VariantSpec[] = [
  {
    id: "device-44100-native",
    label: "44100 Hz device, 44100 Hz WAV",
    expectation: "graceful",
    note: "A common real device rate: the codec resamples 44100 in/out, the protocol stays 48000/1024.",
    inProcess: false,
    deviceRate: 44100,
    wavRate: 44100,
    build: (encode) => atRate(encode(PRIMARY_PAYLOAD), 44100),
  },
  {
    id: "device-44100-mismatched",
    label: "44100 Hz context with a 48000 Hz WAV",
    expectation: "graceful",
    note: "Chromium converts 48000 -> 44100 for the track and the codec converts 44100 -> 48000.",
    inProcess: false,
    deviceRate: 44100,
    wavRate: 48000,
    build: baseline,
  },
  {
    id: "device-48000-wav-44100",
    label: "48000 Hz context with a 44100 Hz WAV",
    expectation: "graceful",
    note: "Chromium upsamples the file; the codec then sees a clean 48000 device rate.",
    inProcess: false,
    deviceRate: 48000,
    wavRate: 44100,
    build: (encode) => atRate(encode(PRIMARY_PAYLOAD), 44100),
  },
  {
    id: "device-96000",
    label: "96000 Hz context",
    expectation: "graceful",
    note: "Upper bound of ggwave's accepted input rates (kSampleRateMax): worth knowing it does not corrupt.",
    inProcess: false,
    deviceRate: 96000,
    wavRate: 48000,
    build: baseline,
  },
];

/**
 * Microphone processing. WebRTC's defaults run noise suppression, AGC and echo
 * cancellation on the captured signal; this is the single most likely way a real
 * phone could break the acoustic link. Browser-only.
 */
const PROFILE_VARIANTS: VariantSpec[] = [
  {
    id: "profile-browser-defaults",
    label: "getUserMedia default processing, clean block",
    expectation: "graceful",
    note: "echoCancellation + noiseSuppression + autoGainControl: does the browser mangle the FSK tones?",
    inProcess: false,
    profile: "browser-defaults",
    build: baseline,
  },
  {
    id: "profile-browser-defaults-noisy",
    label: "default processing with 20 dB SNR",
    expectation: "graceful",
    note: "Default processing plus noise: the realistic worst case for a naive getUserMedia call.",
    inProcess: false,
    build: impairing("profile-browser-defaults-noisy", (clean) => addWhiteNoise(clean, 20, 31)),
  },
];

const ROOM_VARIANTS: VariantSpec[] = [
  {
    id: "echo-20ms-30pct",
    label: "single 20 ms echo at -10 dB",
    expectation: "decode",
    note: "A cheap stand-in for a small room's first reflection (no real reverb model here) — measured to decode.",
    build: impairing("echo-20ms", (clean) => withEcho(clean, 20, 0.3, RATE)),
  },
  {
    id: "echo-5ms-60pct",
    label: "single 5 ms echo at -4 dB",
    expectation: "decode",
    note: "Tight, strong reflection: the same tone twice, 5 ms apart, smears every FFT frame — still decodes.",
    build: impairing("echo-5ms", (clean) => withEcho(clean, 5, 0.6, RATE)),
  },
];

/**
 * Cross-talk and collisions: a second device transmitting at the same time.
 * Both payloads are valid blocks, so anything decoded must be one of them,
 * byte-exact — never a blend of the two. Measured in-process: at half amplitude
 * the stronger transmission (ours) decodes and the foreign one does not; at
 * equal amplitude the 75% tone quorum gates both out and nothing decodes, which
 * is the collision case the transport has to detect by timeout, not by error.
 */
const INTERFERENCE_VARIANTS: VariantSpec[] = [
  {
    id: "crosstalk-foreign-half",
    label: "a second transmission overlaid at -6 dB",
    expectation: "decode",
    expected: [PRIMARY_PAYLOAD],
    allowed: [PRIMARY_PAYLOAD, FOREIGN_PAYLOAD],
    note: "Another session's block mixed in at half amplitude: the louder block wins, and the quieter one is never decoded.",
    build: (encode) => overlay(encode(PRIMARY_PAYLOAD), encode(FOREIGN_PAYLOAD), 0.5),
  },
  {
    id: "collision-simultaneous",
    label: "two transmissions starting at the same instant",
    expectation: "graceful",
    expected: [PRIMARY_PAYLOAD, FOREIGN_PAYLOAD],
    note: "Equal-amplitude collision: gated by the 75% tone quorum, must never return a corrupted blend.",
    build: (encode) => overlay(encode(PRIMARY_PAYLOAD), encode(FOREIGN_PAYLOAD), 1),
  },
];

/**
 * Self-reception (master plan Section 8 contract): our own transmission is in
 * the room, so our own microphone hears it. `listen` is the hazard,
 * `pause-listening` is the mitigation Phase 1 must implement. Browser-only,
 * because it needs the page's Tx path and a live capture device at once.
 */
const SELF_RECEPTION_VARIANTS: VariantSpec[] = [
  {
    id: "self-transmit-live",
    label: "own transmission with listening left on",
    expectation: "decode",
    selfTransmit: "listen",
    inProcess: false,
    captureMs: 5200,
    build: baseline,
    note: "Proves the hazard is real: the codec happily decodes the block we are sending.",
  },
  {
    id: "self-transmit-pause-listening",
    label: "own transmission with the Rx feed paused",
    expectation: "silence",
    selfTransmit: "pause-listening",
    inProcess: false,
    captureMs: 5200,
    build: baseline,
    note: "Proves pausing the Rx feed for the transmit window actually prevents self-decode.",
  },
  {
    id: "self-transmit-pause-noisy",
    label: "own transmission, Rx paused, 20 dB SNR",
    expectation: "graceful",
    expected: [PRIMARY_PAYLOAD],
    selfTransmit: "pause-listening",
    inProcess: false,
    captureMs: 5200,
    note: "Paused during the send, then listening resumes with only noise and the tail left in the room.",
    build: impairing("self-transmit-pause-noisy", (clean) => addWhiteNoise(clean, 20, 41)),
  },
];

const SESSION_VARIANTS: VariantSpec[] = [
  {
    id: "sequence-3-blocks",
    label: "three blocks back to back, 400 ms apart",
    expectation: "decode",
    payloads: SEQUENCE_PAYLOADS,
    expected: SEQUENCE_PAYLOADS,
    captureMs: 8200,
    note: "Rapid short messages: all three must be recovered, with the expected duplicate decodes.",
    build: (encode) =>
      concat(
        encode(SEQUENCE_PAYLOADS[0] ?? PRIMARY_PAYLOAD),
        silence(400),
        encode(SEQUENCE_PAYLOADS[1] ?? PRIMARY_PAYLOAD),
        silence(400),
        encode(SEQUENCE_PAYLOADS[2] ?? PRIMARY_PAYLOAD),
      ),
  },
  {
    id: "silence-only",
    label: "2.5 s of silence",
    expectation: "silence",
    note: "No signal at all: must return nothing, without an error state.",
    build: () => silence(2500),
  },
  {
    id: "cut-short-500ms",
    label: "transmission cut off after 500 ms",
    expectation: "graceful",
    note: "An aborted send: fewer than the ~89 frames a fixed-length block needs, so nothing may decode.",
    build: (encode) => encode(PRIMARY_PAYLOAD).slice(0, 24000),
  },
  {
    id: "lead-in-800ms",
    label: "800 ms of silence before the block",
    expectation: "decode",
    note: "The mirror image of truncation: capture starts well before the sender does.",
    build: (encode) => withLeadIn(encode(PRIMARY_PAYLOAD), 800),
    captureMs: 5200,
  },
];

const ALL_VARIANTS: VariantSpec[] = [
  {
    id: "clean",
    label: "unimpaired baseline",
    expectation: "decode",
    note: "The control: encoder output straight into the fake microphone.",
    build: baseline,
  },
  ...WHITE_NOISE_VARIANTS,
  ...PINK_NOISE_VARIANTS,
  ...LEVEL_VARIANTS,
  ...DROPOUT_VARIANTS,
  ...TRIM_VARIANTS,
  ...RESAMPLE_VARIANTS,
  ...DEVICE_RATE_VARIANTS,
  ...PROFILE_VARIANTS,
  ...ROOM_VARIANTS,
  ...INTERFERENCE_VARIANTS,
  ...SELF_RECEPTION_VARIANTS,
  ...SESSION_VARIANTS,
];

export const CHANNEL_MATRIX: ChannelVariant[] = ALL_VARIANTS.map(resolve);

/** Variants a Node-side runner (no capture device) can meaningfully exercise. */
export function inProcessVariants(): ChannelVariant[] {
  return CHANNEL_MATRIX.filter((variant) => variant.inProcess);
}

export function findVariant(id: string): ChannelVariant {
  const found = CHANNEL_MATRIX.find((variant) => variant.id === id);
  if (found === undefined) throw new Error(`unknown channel variant: ${id}`);
  return found;
}
