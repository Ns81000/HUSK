import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { toHex } from "../harness/payloads";
import {
  CODEC_PAYLOAD_LENGTH,
  CODEC_SAMPLES_PER_FRAME,
  flushReceiver,
  openSoundChatCodec,
  type SoundChatCodec,
} from "./codec";
import { addWhiteNoise, hardClip, mulberry32, resample } from "./degrade";

/**
 * Phase 0, master plan Section 7 step 7: fuzz the round trip.
 *
 * `encode -> feed whole frames -> decode` over a deterministic corpus of random
 * 64-byte blocks plus every boundary length of the locked wire format (master
 * plan Section 4), then the same corpus again through a few degraded channels.
 *
 * Two measured rules this file obeys (`frame-alignment.test.ts`):
 * - only whole 1024-sample frames are ever fed — a partial frame permanently
 *   de-synchronises the fixed-length receiver;
 * - the receiver is drained with silence before each transmission, because the
 *   codec re-decodes the previous block 2-4 times while it sits in the window.
 *
 * The library does no dedupe and msgId dedupe is Phase 2, so this suite asserts
 * on payload *bytes* and on "at least one decode", never on decode counts.
 */

/** Random 64-byte blocks. "Hundreds", per the plan. */
const RANDOM_PAYLOADS = 256;

/**
 * Boundary lengths: version byte only, the 5-byte header alone, the locked
 * single-block maximum (5-byte header + 39 bytes of plaintext = 44), one byte
 * short of a full block, and exactly a full block. Everything shorter than 64
 * is zero-padded by the encoder, so the decoded block is 64 bytes.
 */
const BOUNDARY_LENGTHS = [1, 5, 44, 63, 64];

/** Payloads re-run through each impairment; the plan asks for at least 40. */
const DEGRADED_SUBSET = 48;

function randomBytes(length: number, seed: number): Uint8Array {
  const random = mulberry32(seed);
  const bytes = new Uint8Array(length);
  for (let i = 0; i < length; i += 1) bytes[i] = Math.floor(random() * 256);
  return bytes;
}

/**
 * One block in the locked wire format: version 1, random msgId, random sender,
 * 39 bytes of "ciphertext", and — for half the corpus, like a real short
 * message — a zero-padded tail. Every byte value can appear inside a block.
 */
function fuzzBlock(seed: number): Uint8Array {
  const block = randomBytes(CODEC_PAYLOAD_LENGTH, seed);
  block[0] = 1;
  block[4] = 39;
  if (seed % 2 === 0) block.fill(0, 5 + 39);
  return block;
}

const CORPUS: Uint8Array[] = [
  ...Array.from({ length: RANDOM_PAYLOADS }, (_, index) => fuzzBlock(index + 1)),
  // The boundary payloads are prefixes of wire-format blocks, so they stay
  // plausible rather than being arbitrary nonsense.
  ...BOUNDARY_LENGTHS.map((length, index) => fuzzBlock(500 + index).subarray(0, length)),
];

/** ggwave's fixed-length Tx zero-pads a short payload out to the whole block. */
function padded(payload: Uint8Array): Uint8Array {
  const block = new Uint8Array(CODEC_PAYLOAD_LENGTH);
  block.set(payload);
  return block;
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  for (let i = 0; i < left.length; i += 1) {
    if (left[i] !== right[i]) return false;
  }
  return true;
}

/** Feeds whole 1024-sample frames only, exactly like a ScriptProcessor capture. */
function feed(codec: SoundChatCodec, waveform: Float32Array): Uint8Array[] {
  const blocks: Uint8Array[] = [];
  const frames = Math.floor(waveform.length / CODEC_SAMPLES_PER_FRAME);
  for (let frame = 0; frame < frames; frame += 1) {
    const chunk = waveform.subarray(
      frame * CODEC_SAMPLES_PER_FRAME,
      (frame + 1) * CODEC_SAMPLES_PER_FRAME,
    );
    const decoded = codec.decode(chunk);
    if (decoded !== null) blocks.push(decoded);
  }
  return blocks;
}

type RoundTrip = { index: number; payload: Uint8Array; decodes: number; mismatches: number };

function roundTrip(
  codec: SoundChatCodec,
  payload: Uint8Array,
  index: number,
  impair?: (waveform: Float32Array) => Float32Array,
): RoundTrip {
  flushReceiver(codec);
  const clean = codec.encode(payload);
  const blocks = feed(codec, impair === undefined ? clean : impair(clean));
  const expected = padded(payload);
  return {
    index,
    payload,
    decodes: blocks.length,
    mismatches: blocks.filter((block) => !equalBytes(block, expected)).length,
  };
}

function describeRun(run: RoundTrip): string {
  return `#${run.index} decodes=${run.decodes} mismatches=${run.mismatches} payload=${toHex(run.payload)}`;
}

function summarise(id: string, runs: RoundTrip[]): { corrupted: string[]; undecoded: string[] } {
  const corrupted = runs.filter((run) => run.mismatches > 0);
  const undecoded = runs.filter((run) => run.decodes === 0);
  const decodeEvents = runs.reduce((sum, run) => sum + run.decodes, 0);
  console.log(
    `[fuzz] ${id} payloads=${runs.length} decodeEvents=${decodeEvents} ` +
      `undecoded=${undecoded.length} mismatches=${corrupted.length}`,
  );
  return {
    corrupted: corrupted.map(describeRun),
    undecoded: undecoded.map(describeRun),
  };
}

/** The subset the plan asks for: a noisy channel, a cheap one, and a level case. */
const IMPAIRMENTS: { id: string; apply: (waveform: Float32Array) => Float32Array }[] = [
  { id: "white-noise-20db", apply: (waveform) => addWhiteNoise(waveform, 20, 71) },
  {
    id: "resample-44k-round-trip",
    apply: (waveform) => resample(resample(waveform, 48000, 44100), 44100, 48000),
  },
  { id: "clip-0.06", apply: (waveform) => hardClip(waveform, 0.06) },
];

let codec: SoundChatCodec;

beforeAll(async () => {
  codec = await openSoundChatCodec();
});

afterAll(() => {
  codec.close();
});

describe("fuzz round trip", () => {
  it(`round-trips ${CORPUS.length} random and boundary payloads byte-exact, unimpaired`, () => {
    const runs = CORPUS.map((payload, index) => roundTrip(codec, payload, index));
    const { corrupted, undecoded } = summarise("clean", runs);
    expect(corrupted, "a payload decoded to something other than itself").toEqual([]);
    expect(undecoded, "a payload never decoded at all").toEqual([]);
  }, 120_000);

  for (const impairment of IMPAIRMENTS) {
    it(`round-trips ${DEGRADED_SUBSET} payloads byte-exact through ${impairment.id}`, () => {
      const runs = CORPUS.slice(0, DEGRADED_SUBSET).map((payload, index) =>
        roundTrip(codec, payload, index, impairment.apply),
      );
      const { corrupted, undecoded } = summarise(impairment.id, runs);
      expect(
        corrupted,
        `${impairment.id}: a payload decoded to something other than itself`,
      ).toEqual([]);
      expect(undecoded, `${impairment.id}: a payload never decoded at all`).toEqual([]);
    }, 120_000);
  }
});
