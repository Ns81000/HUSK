import { afterAll, describe, expect, it } from "vitest";
import { CODEC_SAMPLES_PER_FRAME, openSoundChatCodec, type SoundChatCodec } from "./codec";
import { concat, silence } from "../harness/matrix";
import { PRIMARY_PAYLOAD, SEQUENCE_PAYLOADS, type TestPayload } from "../harness/payloads";

/**
 * Phase 0 finding suite: how the fixed-length decoder relates to the *capture*
 * frame grid (master plan Section 7 step 6, the chunk-boundary case, measured
 * rather than assumed).
 *
 * `decode_fixed()` never searches for where a transmission began. It computes
 * `historyStartId = historyIdFixed - totalTxs*framesPerTx` (`ggwave.cpp:1931`)
 * and analyses "the last N frames of the fed stream" as if they were one whole
 * block, where N is exactly the block length (90 frames at 48000/1024 with
 * payloadLength 64). The grid those frames sit on is anchored at the first
 * sample the receiver is fed.
 *
 * Consequences this file pins down, all measured here:
 * - A complete block that passes through the window decodes, whatever its phase
 *   relative to the feed grid (offsets up to 2048 samples were tested).
 * - Audio *missing* from the front of the block (a capture that began late)
 *   means the window never holds a whole block, so nothing decodes — graceful,
 *   and the reason the transport is turn-based with the listener already
 *   listening.
 * - Feeding a partial frame (not 1024 samples) permanently de-synchronises the
 *   receiver: subsequent complete blocks stop decoding. Capture must therefore
 *   always present whole frames.
 *
 * Every scenario runs on its own codec module: a shifted receiver cannot be
 * recovered in place.
 */

const codecs: SoundChatCodec[] = [];

afterAll(() => {
  for (const codec of codecs) codec.close();
});

async function fresh(): Promise<SoundChatCodec> {
  const codec = await openSoundChatCodec();
  codecs.push(codec);
  return codec;
}

/** Feeds whole 1024-sample frames only, exactly like a ScriptProcessor capture. */
function feed(codec: SoundChatCodec, waveform: Float32Array): number[] {
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

function block(codec: SoundChatCodec, payload: TestPayload): Float32Array {
  return codec.encode(payload.bytes);
}

describe("fixed-length frame alignment", () => {
  it("decodes once 89-90 frames of a complete block have passed through", async () => {
    const codec = await fresh();
    const at = feed(codec, block(codec, PRIMARY_PAYLOAD));
    console.log(`[align] clean frames-at-decode=${at.join(",")}`);
    expect(at).toEqual([89, 90]);
  });

  for (const offset of [1, 16, 64, 128, 256, 512, 768, 1023, 1024, 2048]) {
    it(`decodes a block that starts ${offset} samples off the feed grid`, async () => {
      const codec = await fresh();
      const at = feed(codec, concat(new Float32Array(offset), block(codec, PRIMARY_PAYLOAD)));
      console.log(`[align] phase-offset=${offset} decodes=${at.length} at=${at.join(",")}`);
      expect(at.length, `offset ${offset} should still decode`).toBeGreaterThan(0);
    });
  }

  for (const trim of [1, 512, 1024, 8192]) {
    it(`still decodes with ${trim} samples missing from the front`, async () => {
      const codec = await fresh();
      const waveform = block(codec, PRIMARY_PAYLOAD).subarray(trim);
      const at = feed(codec, waveform);
      console.log(`[align] front-trimmed=${trim} decodes=${at.length} at=${at.join(",")}`);
      // Reed-Solomon absorbs the lost tone groups; only a block that never fits
      // whole inside the window stops decoding.
      expect(at.length).toBeGreaterThan(0);
    });
  }

  it("does not decode once most of the block is missing", async () => {
    const codec = await fresh();
    const waveform = block(codec, PRIMARY_PAYLOAD).subarray(46080);
    const at = feed(codec, waveform);
    console.log(`[align] front-trimmed=46080 decodes=${at.length}`);
    expect(at).toEqual([]);
  });

  it("loses synchronisation permanently after a partial frame is fed", async () => {
    const codec = await fresh();
    const first = feed(codec, block(codec, PRIMARY_PAYLOAD));
    // One 192-sample fragment: what a naive "decode whatever the callback gave
    // me" loop produces whenever a buffer is cut short.
    codec.decode(new Float32Array(192));
    const second = feed(codec, block(codec, PRIMARY_PAYLOAD));
    console.log(`[align] partial-frame first=${first.join(",")} second=${second.join(",")}`);
    expect(first).toEqual([89, 90]);
    expect(second).toEqual([]);
  });

  it("decodes two frame-aligned blocks inside one continuous stream", async () => {
    const codec = await fresh();
    const at = feed(codec, concat(block(codec, PRIMARY_PAYLOAD), block(codec, PRIMARY_PAYLOAD)));
    console.log(`[align] two-blocks-one-stream decodes=${at.join(",")}`);
    expect(at.length).toBeGreaterThan(2);
  });

  it("decodes three different blocks with 400 ms gaps, whatever the gap's phase", async () => {
    const build = (codec: SoundChatCodec, gap: Float32Array): Float32Array =>
      concat(
        block(codec, SEQUENCE_PAYLOADS[0] ?? PRIMARY_PAYLOAD),
        gap,
        block(codec, SEQUENCE_PAYLOADS[1] ?? PRIMARY_PAYLOAD),
        gap,
        block(codec, SEQUENCE_PAYLOADS[2] ?? PRIMARY_PAYLOAD),
      );

    const whole = await fresh();
    const wholeGap = silence(400).subarray(0, 18 * CODEC_SAMPLES_PER_FRAME);
    const wholeAt = feed(whole, build(whole, wholeGap));

    const phased = await fresh();
    const phasedAt = feed(phased, build(phased, silence(400)));

    console.log(
      `[align] three-blocks whole-frame gaps=${wholeAt.length} (${wholeAt.join(",")}) | ` +
        `off-grid gaps=${phasedAt.length} (${phasedAt.join(",")})`,
    );
    expect(wholeAt.length).toBeGreaterThanOrEqual(3);
    expect(phasedAt.length).toBeGreaterThanOrEqual(3);
  });
});
