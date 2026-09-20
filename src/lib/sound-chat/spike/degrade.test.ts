import { describe, expect, it } from "vitest";
import {
  addPinkNoise,
  addWhiteNoise,
  applyGainDb,
  hardClip,
  mix,
  mulberry32,
  peak,
  pinkNoise,
  resample,
  rms,
  trimStart,
  whiteNoise,
  withDropouts,
  withEcho,
} from "./degrade";

const RATE = 48000;

function tone(seconds: number, frequency = 2000, amplitude = 0.25): Float32Array {
  const samples = new Float32Array(Math.round(seconds * RATE));
  for (let i = 0; i < samples.length; i += 1) {
    samples[i] = amplitude * Math.sin((2 * Math.PI * frequency * i) / RATE);
  }
  return samples;
}

describe("degradation primitives", () => {
  it("is deterministic for a given seed", () => {
    const a = mulberry32(7);
    const b = mulberry32(7);
    expect([a(), a(), a()]).toEqual([b(), b(), b()]);
  });

  it("measures rms and peak of a known sine", () => {
    const samples = tone(0.5, 2000, 0.25);
    expect(rms(samples)).toBeCloseTo(0.25 / Math.SQRT2, 3);
    expect(peak(samples)).toBeCloseTo(0.25, 3);
  });

  it("generates noise at an explicit rms level", () => {
    for (const target of [0.01, 0.002, 0.0005]) {
      // Statistical estimate over 200k samples: within 0.5% of the request.
      expect(rms(whiteNoise(200_000, target, 3)) / target).toBeGreaterThan(0.995);
      expect(rms(whiteNoise(200_000, target, 3)) / target).toBeLessThan(1.005);
      expect(rms(pinkNoise(200_000, target, 3)) / target).toBeGreaterThan(0.995);
      expect(rms(pinkNoise(200_000, target, 3)) / target).toBeLessThan(1.005);
    }
  });

  it("composes the requested SNR exactly, and mixes deterministically", () => {
    const clean = tone(1, 2000, 0.25);
    for (const snrDb of [40, 20, 6, 0]) {
      const targetNoiseRms = rms(clean) / 10 ** (snrDb / 20);
      const white = whiteNoise(clean.length, targetNoiseRms, 1);
      const pink = pinkNoise(clean.length, targetNoiseRms, 1);
      // Deterministic per seed; the small residual is the sample-RMS estimate
      // of a finite-length noise realisation, so allow 3% (0.26 dB).
      const whiteDb = 20 * Math.log10(rms(clean) / rms(white));
      const pinkDb = 20 * Math.log10(rms(clean) / rms(pink));
      expect(Math.abs(whiteDb - snrDb)).toBeLessThan(0.3);
      expect(Math.abs(pinkDb - snrDb)).toBeLessThan(0.3);
      expect(Array.from(addWhiteNoise(clean, snrDb, 1))).toEqual(Array.from(mix(clean, white)));
      expect(Array.from(addPinkNoise(clean, snrDb, 1))).toEqual(Array.from(mix(clean, pink)));
    }
  });

  it("clips without introducing NaN and respects the ceiling", () => {
    const clipped = hardClip(tone(0.2), 0.05);
    expect(peak(clipped)).toBeLessThanOrEqual(0.05 + 1e-6);
    expect(Number.isNaN(clipped[0] ?? 0)).toBe(false);
  });

  it("scales by gain in dB", () => {
    const quiet = applyGainDb(tone(0.2), -26);
    expect(peak(quiet)).toBeCloseTo(0.25 * 10 ** (-26 / 20), 4);
  });

  it("zeroes exactly the requested dropout budget", () => {
    const dropped = withDropouts(tone(0.5), { count: 3, dropoutMs: 10, sampleRate: RATE, seed: 5 });
    const expectedZeroes = 3 * Math.round((10 / 1000) * RATE);
    let zeroes = 0;
    for (let i = 0; i < dropped.length; i += 1) {
      if (dropped[i] === 0) zeroes += 1;
    }
    expect(zeroes).toBeGreaterThanOrEqual(expectedZeroes);
  });

  it("trims from the front and keeps the tail", () => {
    const samples = tone(1);
    const trimmed = trimStart(samples, 1000);
    expect(trimmed.length).toBe(samples.length - 1000);
    expect(trimmed[0]).toBe(samples[1000]);
  });

  it("preserves length close to the ratio when resampling out and back", () => {
    const samples = tone(1, 2000, 0.25);
    const down = resample(samples, 48000, 44100);
    const back = resample(down, 44100, 48000);
    expect(down.length).toBe(44100);
    expect(Math.abs(back.length - samples.length)).toBeLessThanOrEqual(2);
    // Linear-ish fidelity: energy survives the round trip.
    expect(rms(back)).toBeGreaterThan(rms(samples) * 0.9);
    expect(rms(back)).toBeLessThan(rms(samples) * 1.1);
  });

  it("reduces spectral purity measurably on a single tone (i.e. it really does resample)", () => {
    const samples = tone(0.5, 2000, 0.25);
    const back = resample(resample(samples, 48000, 44100), 44100, 48000);
    // A perfect pass-through would give a bit-identical array; interpolation cannot.
    let maxDelta = 0;
    const shorter = Math.min(samples.length, back.length);
    for (let i = 0; i < shorter; i += 1) {
      maxDelta = Math.max(maxDelta, Math.abs((samples[i] ?? 0) - (back[i] ?? 0)));
    }
    expect(maxDelta).toBeGreaterThan(0);
  });

  it("adds an echo that only affects samples after the delay", () => {
    const samples = tone(0.2);
    const echoed = withEcho(samples, 20, 0.3, RATE);
    const delay = Math.round((20 / 1000) * RATE);
    expect(echoed[10]).toBe(samples[10]);
    expect(echoed[delay + 10]).toBeCloseTo(
      (samples[delay + 10] ?? 0) + (samples[10] ?? 0) * 0.3,
      5,
    );
  });
});
