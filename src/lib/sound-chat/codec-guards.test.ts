/**
 * Guard tests for the promoted codec (master plan Section 10.1, classes 2, 3, 7,
 * 10; the seam set in 10.3).
 *
 * Phase 0 measured that a partial frame permanently de-synchronises the
 * fixed-length receiver and pinned that as a *fact* about the codec; it never
 * enforced it. The independent verification pass found the consequence: the
 * obvious guard, placed where the codec call is, would latch the module dead on
 * the caller's own mistake. These tests pin the corrected contract —
 * whole-frame discipline enforced, misuse never mistaken for a module death,
 * and legal multi-frame feeds left legal.
 */
import { afterAll, describe, expect, it } from "vitest";
import {
  bytesToFloat32,
  CODEC_SAMPLES_PER_FRAME,
  CodecUsageError,
  openSoundChatCodec,
  type SoundChatCodec,
} from "./codec";
import { PRIMARY_PAYLOAD } from "./harness/payloads";

const codecs: SoundChatCodec[] = [];

afterAll(() => {
  for (const codec of codecs) codec.close();
});

async function fresh(): Promise<SoundChatCodec> {
  const codec = await openSoundChatCodec();
  codecs.push(codec);
  return codec;
}

/** Whole 1024-sample frames only, exactly like the capture pipeline. */
function feedWholeFrames(codec: SoundChatCodec, waveform: Float32Array): number[] {
  const at: number[] = [];
  const frames = Math.floor(waveform.length / CODEC_SAMPLES_PER_FRAME);
  for (let frame = 0; frame < frames; frame += 1) {
    const chunk = waveform.subarray(
      frame * CODEC_SAMPLES_PER_FRAME,
      (frame + 1) * CODEC_SAMPLES_PER_FRAME,
    );
    if (codec.decode(chunk) !== null) at.push(frame + 1);
  }
  return at;
}

describe("decode frame discipline", () => {
  it("refuses a partial frame, stays usable, and does not de-synchronise", async () => {
    const codec = await fresh();
    for (const length of [1, 192, 512, 1000, 1023]) {
      expect(() => codec.decode(new Float32Array(length)), `length ${length}`).toThrowError(
        CodecUsageError,
      );
    }
    expect(codec.state).toBe("ready");

    // No sample reached the wasm core, so the grid is untouched and a real block
    // still lands exactly where an untouched receiver lands it.
    const at = feedWholeFrames(codec, codec.encode(PRIMARY_PAYLOAD.bytes));
    console.log(`[guards] after refused partial frames, decodes at frames=${at.join(",")}`);
    expect(at).toEqual([89, 90]);
  });

  it("keeps whole multiples of the frame size legal", async () => {
    const codec = await fresh();
    for (const frames of [1, 2, 3]) {
      expect(codec.decode(new Float32Array(CODEC_SAMPLES_PER_FRAME * frames))).toBeNull();
    }
    expect(codec.state).toBe("ready");
    const at = feedWholeFrames(codec, codec.encode(PRIMARY_PAYLOAD.bytes));
    console.log(
      `[guards] after 6 frames of multi-frame silence, decodes at frames=${at.join(",")}`,
    );
    expect(at.length).toBeGreaterThan(0);
  });

  it("returns null for an empty chunk without touching the codec", async () => {
    const codec = await fresh();
    expect(codec.decode(new Float32Array(0))).toBeNull();
    expect(codec.state).toBe("ready");
  });
});

describe("encode guards", () => {
  it("refuses empty and over-length payloads, leaving the module usable", async () => {
    const codec = await fresh();
    expect(() => codec.encode(new Uint8Array(0))).toThrowError(CodecUsageError);
    expect(() => codec.encode(new Uint8Array(CODEC_SAMPLES_PER_FRAME + 1))).toThrowError(
      CodecUsageError,
    );
    // Both refusals are our misuse, not a wasm trap: nothing latched.
    expect(codec.state).toBe("ready");
    expect(codec.encode(new Uint8Array(64)).length).toBe(90 * CODEC_SAMPLES_PER_FRAME);
  });
});

describe("byte view helpers", () => {
  it("reports an unaligned view as misuse instead of a raw RangeError", () => {
    const backing = new Uint8Array(64);
    expect(bytesToFloat32(backing.subarray(0, 8)).length).toBe(2);
    // byteLength 8 is a multiple of 4, but byteOffset 1 is not: the raw
    // constructor would throw a bare RangeError that says nothing useful.
    expect(() => bytesToFloat32(backing.subarray(1, 9))).toThrowError(CodecUsageError);
  });

  it("rejects a byte length that is not a multiple of 4", () => {
    expect(() => bytesToFloat32(new Uint8Array(6))).toThrowError(CodecUsageError);
  });
});

describe("closed codec", () => {
  it("refuses further use as a usage error, not as a module death", async () => {
    const codec = await openSoundChatCodec();
    codec.close();
    expect(codec.state).toBe("closed");
    expect(() => codec.decode(new Float32Array(CODEC_SAMPLES_PER_FRAME))).toThrowError(
      CodecUsageError,
    );
    expect(() => codec.encode(new Uint8Array(64))).toThrowError(CodecUsageError);
    expect(codec.state).toBe("closed");
  });
});
