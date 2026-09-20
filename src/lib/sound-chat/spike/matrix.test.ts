import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  CODEC_SAMPLES_PER_FRAME,
  type SoundChatCodec,
  flushReceiver,
  openSoundChatCodec,
} from "./codec";
import { inProcessVariants, CHANNEL_MATRIX, type ChannelVariant } from "../harness/matrix";
import { toHex } from "../harness/payloads";

/**
 * Phase 0, master plan Section 7 step 6 (the in-process half): the same
 * degradation matrix the Chromium harness runs, applied directly to the codec's
 * own decode input. This is the fast, deterministic read on what ggwave itself
 * survives; `harness/fake-mic.spec.ts` then re-runs the same matrix through the
 * real capture pipeline to see whether the browser layer agrees.
 */

let codec: SoundChatCodec;

beforeAll(async () => {
  codec = await openSoundChatCodec();
});

afterAll(() => {
  codec.close();
});

function feed(waveform: Float32Array): string[] {
  const decoded: string[] = [];
  // Whole 1024-sample frames only. A partial frame permanently de-synchronises
  // the fixed-length receiver (see `frame-alignment.test.ts`), and a real
  // ScriptProcessor capture only ever produces whole frames.
  const frames = Math.floor(waveform.length / CODEC_SAMPLES_PER_FRAME);
  for (let frame = 0; frame < frames; frame += 1) {
    const chunk = waveform.subarray(
      frame * CODEC_SAMPLES_PER_FRAME,
      (frame + 1) * CODEC_SAMPLES_PER_FRAME,
    );
    const block = codec.decode(chunk);
    if (block !== null) decoded.push(toHex(block));
  }
  return decoded;
}

type Result = {
  variant: ChannelVariant;
  decoded: string[];
  unique: string[];
  verdict: "pass" | "fail";
};

function runVariant(variant: ChannelVariant): Result {
  flushReceiver(codec);
  const waveform = variant.build((payload) => codec.encode(payload.bytes));
  const decoded = feed(waveform);
  const unique = [...new Set(decoded)];
  const allowed = new Set(variant.allowed.map((payload) => payload.hex));
  const garbage = unique.filter((hex) => !allowed.has(hex));

  if (garbage.length > 0) {
    return { variant, decoded, unique, verdict: "fail" };
  }
  if (variant.expectation === "decode") {
    const missing = variant.expected.filter((payload) => !unique.includes(payload.hex));
    if (missing.length > 0) return { variant, decoded, unique, verdict: "fail" };
  }
  if (variant.expectation === "silence" && unique.length > 0) {
    return { variant, decoded, unique, verdict: "fail" };
  }
  return { variant, decoded, unique, verdict: "pass" };
}

describe("in-process degradation matrix", () => {
  const variants = inProcessVariants();
  const results: Result[] = [];

  it("has an in-process runner for most of the matrix", () => {
    expect(variants.length).toBeGreaterThan(20);
    expect(CHANNEL_MATRIX.length - variants.length).toBeGreaterThan(5);
  });

  it("runs every browser-independent variant against the codec alone", () => {
    for (const variant of variants) {
      const result = runVariant(variant);
      results.push(result);
      console.log(
        `[in-process] ${result.variant.id} ${result.verdict} ` +
          `decodes=${result.decoded.length} unique=${result.unique.length} ` +
          `uniqueHex=${result.unique.map((hex) => hex.slice(0, 10)).join("|")}`,
      );
    }
    const failures = results.filter((result) => result.verdict === "fail");
    expect(
      failures.map((result) => result.variant.id),
      "every in-process variant must honour its contract",
    ).toEqual([]);
  });
});
