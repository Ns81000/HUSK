import { describe, expect, it } from "vitest";
import { decodeWav16, encodeWav16 } from "./wav";

const RATE = 48000;

function ramp(frames: number): Float32Array {
  const samples = new Float32Array(frames);
  for (let i = 0; i < frames; i += 1) {
    samples[i] = 0.5 * Math.sin((2 * Math.PI * 1000 * i) / RATE);
  }
  return samples;
}

describe("16-bit PCM wav round trip", () => {
  it("writes a canonical 44-byte-headed mono PCM file", () => {
    const bytes = encodeWav16({ sampleRate: RATE, samples: ramp(1024) });
    expect(bytes.byteLength).toBe(44 + 1024 * 2);
    const view = new DataView(bytes.buffer);
    expect(String.fromCharCode(...bytes.subarray(0, 4))).toBe("RIFF");
    expect(String.fromCharCode(...bytes.subarray(8, 12))).toBe("WAVE");
    expect(view.getUint16(20, true)).toBe(1); // PCM
    expect(view.getUint16(22, true)).toBe(1); // mono
    expect(view.getUint32(24, true)).toBe(RATE);
    expect(view.getUint16(34, true)).toBe(16);
    expect(view.getUint32(40, true)).toBe(1024 * 2);
  });

  it("round-trips within 16-bit quantisation", () => {
    const original = ramp(4096);
    const decoded = decodeWav16(encodeWav16({ sampleRate: RATE, samples: original }));
    expect(decoded.sampleRate).toBe(RATE);
    expect(decoded.samples.length).toBe(original.length);
    let maxDelta = 0;
    for (let i = 0; i < original.length; i += 1) {
      maxDelta = Math.max(maxDelta, Math.abs((original[i] ?? 0) - (decoded.samples[i] ?? 0)));
    }
    expect(maxDelta).toBeLessThan(1 / 32767);
  });

  it("clamps out-of-range samples instead of wrapping them", () => {
    const hot = Float32Array.from([2, -2, 0.5]);
    const decoded = decodeWav16(encodeWav16({ sampleRate: RATE, samples: hot })).samples;
    expect(decoded[0]).toBeCloseTo(1, 4);
    expect(decoded[1]).toBeCloseTo(-1, 4);
    expect(decoded[2]).toBeCloseTo(0.5, 4);
  });

  it("rejects non-wav input", () => {
    expect(() => decodeWav16(new Uint8Array(64))).toThrow();
  });
});
