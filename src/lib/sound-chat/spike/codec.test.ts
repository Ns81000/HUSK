import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  CODEC_PAYLOAD_LENGTH,
  CODEC_SAMPLE_RATE,
  CODEC_SAMPLES_PER_FRAME,
  CodecUsageError,
  SoundChatCodec,
  flushReceiver,
  openSoundChatCodec,
} from "./codec";

/**
 * Phase 0, master plan Section 7 step 4: prove the locked codec configuration
 * round-trips in-process, with no audio hardware involved.
 *
 * Measurements printed by this file are what the log quotes; they are observed
 * here, never copied from the deep dive.
 */

let codec: SoundChatCodec;

beforeAll(async () => {
  codec = await openSoundChatCodec();
});

afterAll(() => {
  codec.close();
});

type DecodeEvent = { bytes: Uint8Array; atSample: number };

/** Feeds a waveform in capture-sized chunks, draining after every chunk. */
function feed(samples: Float32Array, chunkSize: number): DecodeEvent[] {
  const events: DecodeEvent[] = [];
  for (let offset = 0; offset < samples.length; offset += chunkSize) {
    const chunk = samples.subarray(offset, Math.min(offset + chunkSize, samples.length));
    const decoded = codec.decode(chunk);
    if (decoded !== null) {
      events.push({ bytes: decoded, atSample: offset + chunk.length });
    }
  }
  return events;
}

function wireFormatPayload(): Uint8Array {
  const payload = new Uint8Array(CODEC_PAYLOAD_LENGTH);
  payload[0] = 1; // version
  payload[1] = 0x12; // msgId hi
  payload[2] = 0x34; // msgId lo
  payload[3] = 0x0a; // fromPeerId
  payload[4] = 39; // ciphertext length
  for (let i = 0; i < 39; i += 1) {
    payload[5 + i] = 0x41 + (i % 26);
  }
  return payload;
}

describe("sound chat codec — locked Phase 0 configuration", () => {
  it("holds one Tx-only and one Rx-only instance over a whole session", () => {
    expect(codec.state).toBe("ready");
    expect(codec.sampleRate).toBe(CODEC_SAMPLE_RATE);
    expect(CODEC_SAMPLES_PER_FRAME).toBe(1024);
    expect(CODEC_PAYLOAD_LENGTH).toBe(64);
  });

  it("encodes the locked 64-byte wire format into one fixed-length block", () => {
    const samples = codec.encode(wireFormatPayload());
    console.log(`[phase0] waveform samples=${samples.length} bytes=${samples.byteLength}`);
    console.log(`[phase0] waveform duration=${samples.length / CODEC_SAMPLE_RATE}s`);
    const peak = samples.reduce((max, value) => Math.max(max, Math.abs(value)), 0);
    console.log(`[phase0] waveform peak=${peak.toFixed(4)}`);
    expect(samples.length).toBe(90 * CODEC_SAMPLES_PER_FRAME);
    expect(samples.length / CODEC_SAMPLE_RATE).toBeCloseTo(1.92, 6);
    expect(peak).toBeGreaterThan(0.01);
    expect(peak).toBeLessThan(1);
  });

  it("decodes that block back, byte for byte, out of a 1024-sample chunk stream", () => {
    const payload = wireFormatPayload();
    const samples = codec.encode(payload);
    flushReceiver(codec);
    const events = feed(samples, CODEC_SAMPLES_PER_FRAME);
    console.log(
      `[phase0] decode events=${events.length} at=${events.map((e) => e.atSample).join(",")}`,
    );
    expect(events.length).toBeGreaterThan(0);
    for (const event of events) {
      expect(Array.from(event.bytes)).toEqual(Array.from(payload));
    }
    const first = events[0];
    console.log(`[phase0] first decode after ${first?.atSample ?? -1} samples of feed`);
  });

  it("is binary-safe across the whole byte range", () => {
    const payload = new Uint8Array(CODEC_PAYLOAD_LENGTH);
    for (let i = 0; i < payload.length; i += 1) {
      payload[i] = (i * 7 + 0x80) % 256;
    }
    payload[0] = 0x00;
    payload[1] = 0x80;
    payload[2] = 0xff;
    flushReceiver(codec);
    const events = feed(codec.encode(payload), CODEC_SAMPLES_PER_FRAME);
    expect(events.length).toBeGreaterThan(0);
    expect(Array.from(events[0]?.bytes ?? new Uint8Array())).toEqual(Array.from(payload));
  });

  it("keeps re-decoding the same block after the transmission has ended", () => {
    const payload = wireFormatPayload();
    flushReceiver(codec);
    const events = feed(codec.encode(payload), CODEC_SAMPLES_PER_FRAME);
    const stale = flushReceiver(codec);
    console.log(
      `[phase0] in-transmission decodes=${events.length} post-transmission decodes=${stale}`,
    );
    // Not an assertion about a desired number: this is the measurement that
    // forces Phase 2's msgId dedupe rather than a time-based guard.
    expect(events.length + stale).toBeGreaterThan(1);
  });

  it("rejects an empty payload locally instead of trapping the module", () => {
    expect(() => codec.encode(new Uint8Array(0))).toThrow(CodecUsageError);
    expect(codec.state).toBe("ready");
  });

  it("rejects a payload longer than one block rather than truncating it silently", () => {
    expect(() => codec.encode(new Uint8Array(65))).toThrow(CodecUsageError);
    expect(codec.state).toBe("ready");
  });

  it("returns null (not an error) once the rolling window has drained", () => {
    flushReceiver(codec);
    const silence = new Float32Array(CODEC_SAMPLES_PER_FRAME * 10);
    expect(feed(silence, CODEC_SAMPLES_PER_FRAME)).toEqual([]);
  });
});
