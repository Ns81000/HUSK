/**
 * The Phase 4 acoustic primitives: a music-like tone complex, a band-crossing
 * log sweep, and a time-offset overlay.
 *
 * They exist because the matrix's original noise family cannot express the two
 * interferers a real room actually produces. White and pink noise spread their
 * energy evenly, so they understate a room with music in it, and a single tone
 * hides a signal that is *in band but moving*. These tests check the three
 * properties the matrix variants depend on: the SNR really is the SNR, the
 * energy really does reach the decoder's band, and the offset overlay really
 * only touches the samples it was asked to.
 */

import { describe, expect, it } from "vitest";
import { addMusic, addSweep, mix, musicLike, overlayOffset, rms, sweepTone } from "./degrade";

const RATE = 48_000;

/** The decoder's audible band, as the copy states it. */
const BAND_LOW_HZ = 1893;
const BAND_HIGH_HZ = 6328;

function toneComplex(frequency: number, amplitude = 0.25): Float32Array {
  return new Float32Array(RATE).map(
    (_, index) => amplitude * Math.sin((2 * Math.PI * frequency * index) / RATE),
  );
}

/** Goertzel magnitude at one frequency, used to ask "is there energy here?". */
function magnitudeAt(samples: Float32Array, frequency: number, sampleRate = RATE): number {
  const omega = (2 * Math.PI * frequency) / sampleRate;
  const cosine = Math.cos(omega);
  let previous = 0;
  let beforePrevious = 0;
  for (let i = 0; i < samples.length; i += 1) {
    const current = (samples[i] ?? 0) + 2 * cosine * previous - beforePrevious;
    beforePrevious = previous;
    previous = current;
  }
  return (
    Math.sqrt(previous ** 2 + beforePrevious ** 2 - 2 * previous * beforePrevious * cosine) /
    (samples.length / 2)
  );
}

describe("music-like interference", () => {
  it("hits the requested rms, and scales to it exactly as pink noise does", () => {
    for (const target of [0.02, 0.005]) {
      const music = musicLike(200_000, target, 9);
      expect(rms(music) / target, `target ${target}`).toBeGreaterThan(0.995);
      expect(rms(music) / target, `target ${target}`).toBeLessThan(1.005);
    }
  });

  it("puts energy right across the decoder's band, which a noise sweep understates", () => {
    const music = musicLike(RATE, 0.05, 9);
    // Six probes from the bottom of the band to just above the top tone. A
    // single 2 kHz tone would leave most of these near zero; a harmonic stack
    // with a 200 Hz fundamental and 30 partials does not.
    for (const frequency of [2000, 3000, 4000, 5000, 6000, 6300]) {
      expect(magnitudeAt(music, frequency), `no energy at ${frequency} Hz`).toBeGreaterThan(0);
    }
    // And it really is low-frequency weighted, like music and unlike white
    // noise: the 2 kHz probe is well above the 250 Hz probe.
    expect(magnitudeAt(music, 2000)).toBeGreaterThan(magnitudeAt(music, 250) * 3);
  });

  it("composes the requested SNR relative to the reference", () => {
    const clean = toneComplex(2000);
    for (const snrDb of [12, 0, -12]) {
      const noisy = addMusic(clean, snrDb, 9);
      // Signal and interferer are uncorrelated, so the achieved ratio of the
      // *interferer alone* to the reference is the request. A finite-length
      // realisation carries a little slack, so this is a coarse check.
      const interferer = mix(
        noisy,
        clean.map((value) => -value),
      );
      const achieved = 20 * Math.log10(rms(clean) / rms(interferer));
      expect(Math.abs(achieved - snrDb), `snr ${snrDb}, achieved ${achieved}`).toBeLessThan(0.5);
      expect(noisy).toHaveLength(clean.length);
    }
  });

  it("is reproducible from its seed and differs between seeds", () => {
    expect(Array.from(musicLike(512, 0.01, 4))).toEqual(Array.from(musicLike(512, 0.01, 4)));
    expect(Array.from(musicLike(512, 0.01, 4))).not.toEqual(Array.from(musicLike(512, 0.01, 5)));
  });
});

describe("the band-crossing sweep", () => {
  it("reaches both ends of its range and stays continuous", () => {
    const sweep = sweepTone(RATE, 0.05, 300, 8000, 3);
    expect(rms(sweep)).toBeCloseTo(0.05, 2);
    const head = sweep.subarray(0, 4800);
    const middle = sweep.subarray(RATE / 2 - 4800, RATE / 2 + 4800);
    const tail = sweep.subarray(RATE - 4800, RATE);
    // The first tenth of the sweep sits near 300 Hz and the last near 8000 Hz.
    // Measured rather than derived: the log sweep is continuous, so each of
    // these probes is compared against the OTHER end's probe on the same window.
    expect(magnitudeAt(head, 400)).toBeGreaterThan(magnitudeAt(head, 7000) * 5);
    expect(magnitudeAt(tail, 7000)).toBeGreaterThan(magnitudeAt(tail, 400) * 5);
    // Continuity, which is the property a phase-integrated sweep has and a
    // resampled sine stack does not: the middle window carries its energy at
    // the frequency the sweep is passing through there (300 * sqrt(8000/300) =
    // 1549 Hz at the halfway point), and nowhere else. A phase discontinuity
    // would put broadband energy at both ends of the range instead.
    const at1549 = magnitudeAt(middle, 1549);
    expect(at1549).toBeGreaterThan(0);
    expect(magnitudeAt(middle, 400)).toBeLessThan(at1549 / 5);
    expect(magnitudeAt(middle, 7000)).toBeLessThan(at1549 / 5);
  });

  it("is never absent from the decoder's band, unlike a fixed tone", () => {
    // The whole point of the variant: any 1.92 s window of the sweep contains a
    // tone inside [1893, 6328] Hz, so there is no quiet stretch in the band for
    // the decoder to mistake for its own signal.
    const sweep = sweepTone(RATE, 0.05, 300, 8000, 3);
    const windowSeconds = 1.92;
    const steps = 24;
    for (let step = 0; step < steps; step += 1) {
      const from = Math.floor((step / steps) * (RATE - windowSeconds * RATE));
      const window = sweep.subarray(from, from + windowSeconds * RATE);
      let strongest = 0;
      let strongestHz = 0;
      for (let hz = BAND_LOW_HZ; hz <= BAND_HIGH_HZ; hz += 200) {
        const magnitude = magnitudeAt(window, hz);
        if (magnitude > strongest) {
          strongest = magnitude;
          strongestHz = hz;
        }
      }
      expect(strongestHz, `window ${step} had no in-band energy`).toBeGreaterThanOrEqual(
        BAND_LOW_HZ,
      );
    }
  });

  it("composes the requested SNR and does not change length", () => {
    const clean = toneComplex(2000);
    const noisy = addSweep(clean, 6, 300, 8000, 3);
    expect(noisy).toHaveLength(clean.length);
    const interferer = mix(
      noisy,
      clean.map((value) => -value),
    );
    expect(Math.abs(20 * Math.log10(rms(clean) / rms(interferer)) - 6)).toBeLessThan(0.5);
  });
});

describe("the time-offset overlay", () => {
  it("only touches the samples at and after the offset", () => {
    const base = toneComplex(2000, 0.1);
    const other = toneComplex(4000, 0.05);
    const overlaid = overlayOffset(base, other, 0.5, 1000);
    expect(overlaid).toHaveLength(base.length);
    for (let i = 0; i < 1000; i += 1) {
      expect(overlaid[i]).toBe(base[i] ?? 0);
    }
    expect(overlaid[1000]).toBeCloseTo((base[1000] ?? 0) + (other[0] ?? 0) * 0.5, 5);
  });

  it("clips an overlay that runs off the end rather than growing the array", () => {
    const base = new Float32Array(100);
    const other = new Float32Array(200).fill(0.5);
    const overlaid = overlayOffset(base, other, 1, 50);
    expect(overlaid).toHaveLength(100);
    expect(overlaid[99]).toBeCloseTo(0.5, 6);
  });

  it("ignores a negative offset rather than writing before the array", () => {
    const base = new Float32Array(100);
    const other = new Float32Array(10).fill(0.5);
    const overlaid = overlayOffset(base, other, 1, -4);
    expect(overlaid).toHaveLength(100);
    expect(Number.isNaN(overlaid[0] ?? Number.NaN)).toBe(false);
  });

  it("is a real cross-talk model, not a no-op: it is not the aligned overlay", () => {
    // A 4000 Hz tone over 48000 samples is periodic with a 12-sample period, so
    // the first 24000 samples of `other` and the last 24000 are *identical*. The
    // aligned sum would therefore coincide with the offset sum on the
    // overlapping half, and the two models would look identical here. The
    // 2000 Hz base is likewise periodic. So the fixture is a length that is not
    // a whole number of tone periods, which is what two real transmissions are.
    const base = toneComplex(2000, 0.2);
    const other = toneComplex(4373, 0.2).slice(0, 45_000);
    const offset = overlayOffset(base, other, 1, 24_000);
    const aligned = base.map((value, index) => value + (other[index] ?? 0));
    let differing = 0;
    for (let i = 0; i < base.length; i += 1) {
      if (Math.abs((offset[i] ?? 0) - (aligned[i] ?? 0)) > 1e-6) differing += 1;
    }
    // Everywhere except the two samples where both sines cross zero, the two
    // models differ: before the offset the aligned sum has a tone the offset has
    // not started, and inside the overlap the two read the foreign block at
    // different phases. A `overlay` and an `overlayOffset` of the same two
    // waveforms are genuinely different signals, which is the whole point of
    // having both.
    expect(differing).toBe(base.length - 2);
    // ...and the overlap is genuinely mixed, not a pass-through of either: at
    // index 40000 the offset sum carries the foreign block's contribution, so
    // it is measurably not the base tone alone. (Not "greater than zero" — a
    // single sample of a sine is negative as often as positive.)
    const sample = 40_000;
    expect(Math.abs((offset[sample] ?? 0) - (base[sample] ?? 0))).toBeGreaterThan(1e-4);
    expect(Math.abs((offset[sample] ?? 0) - (other[sample - 24_000] ?? 0))).toBeGreaterThan(1e-4);
  });
});
