/**
 * Synthetic acoustic impairments for the Phase 0 fake-mic harness.
 *
 * Everything here is a pure function over F32 samples so the same variant can
 * be applied in-process (Vitest, against the codec alone) and to the WAV that
 * is fed into Chromium as a fake microphone. Noise uses uniform random values,
 * matching ggwave's own loopback tests (`addNoiseHelper`), and is scaled so its
 * RMS hits a requested signal-to-noise ratio relative to the waveform.
 */

/** Deterministic PRNG so every variant is reproducible from its seed. */
export function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function rms(samples: Float32Array): number {
  if (samples.length === 0) return 0;
  let sum = 0;
  for (let i = 0; i < samples.length; i += 1) {
    const value = samples[i] ?? 0;
    sum += value * value;
  }
  return Math.sqrt(sum / samples.length);
}

export function peak(samples: Float32Array): number {
  let max = 0;
  for (let i = 0; i < samples.length; i += 1) {
    max = Math.max(max, Math.abs(samples[i] ?? 0));
  }
  return max;
}

/** Sample-wise sum of two equal-length buffers. */
export function mix(base: Float32Array, addend: Float32Array): Float32Array {
  const out = new Float32Array(base.length);
  for (let i = 0; i < base.length; i += 1) {
    out[i] = (base[i] ?? 0) + (addend[i] ?? 0);
  }
  return out;
}

/** Uniform white noise at an explicit RMS level. */
export function whiteNoise(length: number, targetRms: number, seed: number): Float32Array {
  const random = mulberry32(seed);
  const amplitude = targetRms * Math.sqrt(3); // uniform [-A, A] has rms A/sqrt(3)
  const out = new Float32Array(length);
  for (let i = 0; i < length; i += 1) {
    out[i] = (random() * 2 - 1) * amplitude;
  }
  return out;
}

/** Paul Kellet's 7-pole pink-noise approximation at an explicit RMS level. */
export function pinkNoise(length: number, targetRms: number, seed: number): Float32Array {
  const random = mulberry32(seed);
  const out = new Float32Array(length);
  let b0 = 0;
  let b1 = 0;
  let b2 = 0;
  let b3 = 0;
  let b4 = 0;
  let b5 = 0;
  let b6 = 0;
  for (let i = 0; i < length; i += 1) {
    const white = random() * 2 - 1;
    b0 = 0.99886 * b0 + white * 0.0555179;
    b1 = 0.99332 * b1 + white * 0.0750759;
    b2 = 0.969 * b2 + white * 0.153852;
    b3 = 0.8665 * b3 + white * 0.3104856;
    b4 = 0.55 * b4 + white * 0.5329522;
    b5 = -0.7616 * b5 - white * 0.016898;
    out[i] = b0 + b1 + b2 + b3 + b4 + b5 + b6 + white * 0.5362;
    b6 = white * 0.115926;
  }
  const scale = targetRms / Math.max(rms(out), 1e-12);
  for (let i = 0; i < length; i += 1) {
    out[i] = (out[i] ?? 0) * scale;
  }
  return out;
}

/** Adds white noise at the requested SNR relative to `reference`. */
export function addWhiteNoise(reference: Float32Array, snrDb: number, seed: number): Float32Array {
  return mix(reference, whiteNoise(reference.length, rms(reference) / 10 ** (snrDb / 20), seed));
}

/** Adds pink noise at the requested SNR relative to `reference`. */
export function addPinkNoise(reference: Float32Array, snrDb: number, seed: number): Float32Array {
  return mix(reference, pinkNoise(reference.length, rms(reference) / 10 ** (snrDb / 20), seed));
}

/**
 * A music-like interferer: a harmonic tone complex under a slow tremolo.
 *
 * WHY this and not more noise: white and pink noise spread their energy evenly,
 * so they understate the real case. A room with music or speech in it puts most
 * of its energy at low frequencies — and the decoder's tones start at 1893 Hz,
 * so a 200 Hz fundamental with harmonics reaching past 6 kHz lands squarely
 * across the whole band. Amplitudes fall as 1/h so the stack is pink-ish rather
 * than a single dominant partial.
 */
export function musicLike(
  length: number,
  targetRms: number,
  seed: number,
  options?: { sampleRate?: number; fundamentalHz?: number; harmonics?: number },
): Float32Array {
  const sampleRate = options?.sampleRate ?? 48_000;
  const fundamental = options?.fundamentalHz ?? 200;
  const harmonics = options?.harmonics ?? 30;
  const random = mulberry32(seed);
  const phases: number[] = [];
  for (let h = 0; h < harmonics; h += 1) phases.push(random() * 2 * Math.PI);
  const out = new Float32Array(length);
  for (let i = 0; i < length; i += 1) {
    const t = i / sampleRate;
    let sum = 0;
    for (let h = 0; h < harmonics; h += 1) {
      const frequency = fundamental * (h + 1);
      if (frequency >= sampleRate / 2) break;
      sum += Math.sin(2 * Math.PI * frequency * t + (phases[h] ?? 0)) / (h + 1);
    }
    // 4 Hz tremolo: a held chord rather than a steady drone.
    const tremolo = 0.7 + 0.3 * Math.sin(2 * Math.PI * 4 * t);
    out[i] = sum * tremolo;
  }
  const scale = targetRms / Math.max(rms(out), 1e-12);
  for (let i = 0; i < length; i += 1) {
    out[i] = (out[i] ?? 0) * scale;
  }
  return out;
}

/** Mixes a music-like interferer in at the requested SNR relative to `reference`. */
export function addMusic(
  reference: Float32Array,
  snrDb: number,
  seed: number,
  options?: { sampleRate?: number; fundamentalHz?: number; harmonics?: number },
): Float32Array {
  return mix(
    reference,
    musicLike(reference.length, rms(reference) / 10 ** (snrDb / 20), seed, options),
  );
}

/**
 * A log sweep from `fromHz` to `toHz` — one tone at a time, crossing the whole
 * decoder band. The worst-case *stationary* interferer: unlike a tone complex
 * it is never absent from the band, it is simply somewhere else every moment.
 */
export function sweepTone(
  length: number,
  targetRms: number,
  fromHz: number,
  toHz: number,
  seed = 0,
  sampleRate = 48_000,
): Float32Array {
  const random = mulberry32(seed);
  const phase = random() * 2 * Math.PI;
  const logRatio = Math.log(toHz / fromHz);
  const durationSeconds = length / sampleRate;
  const out = new Float32Array(length);
  for (let i = 0; i < length; i += 1) {
    const t = i / sampleRate;
    // The integral of a log sweep's instantaneous frequency, so the tone is
    // continuous: at t = duration it has reached `toHz`.
    const phaseAt =
      2 * Math.PI * fromHz * ((Math.exp((logRatio * t) / durationSeconds) - 1) / logRatio);
    out[i] = Math.sin(phaseAt + phase);
  }
  const scale = targetRms / Math.max(rms(out), 1e-12);
  for (let i = 0; i < length; i += 1) {
    out[i] = (out[i] ?? 0) * scale;
  }
  return out;
}

/** Mixes a band-crossing sweep in at the requested SNR. */
export function addSweep(
  reference: Float32Array,
  snrDb: number,
  fromHz: number,
  toHz: number,
  seed = 0,
): Float32Array {
  return mix(
    reference,
    sweepTone(reference.length, rms(reference) / 10 ** (snrDb / 20), fromHz, toHz, seed),
  );
}

/**
 * Overlays a second waveform at a time offset — two devices that do not start
 * their transmissions at the same instant. `overlay` can only mix waveforms of
 * one length, which is a model of a *collision*; this is the model of ordinary
 * cross-talk between neighbours who are not synchronised at all.
 */
export function overlayOffset(
  base: Float32Array,
  other: Float32Array,
  level: number,
  offsetSamples: number,
): Float32Array {
  const out = Float32Array.from(base);
  for (let i = 0; i < other.length; i += 1) {
    const at = offsetSamples + i;
    if (at < 0 || at >= out.length) continue;
    out[at] = (out[at] ?? 0) + (other[i] ?? 0) * level;
  }
  return out;
}

/** Zeroes `count` random short segments — capture-buffer glitches. */
export function withDropouts(
  samples: Float32Array,
  options: { count: number; dropoutMs: number; sampleRate: number; seed: number },
): Float32Array {
  const out = Float32Array.from(samples);
  const random = mulberry32(options.seed);
  const length = Math.max(1, Math.round((options.dropoutMs / 1000) * options.sampleRate));
  for (let i = 0; i < options.count; i += 1) {
    const start = Math.floor(random() * Math.max(1, out.length - length));
    out.fill(0, start, start + length);
  }
  return out;
}

/** Cuts audio off the front: a capture that started mid-transmission. */
export function trimStart(samples: Float32Array, offsetSamples: number): Float32Array {
  return samples.subarray(Math.min(offsetSamples, samples.length));
}

/**
 * Windowed-sinc resampler (Hann-windowed, 16 taps each side). Applied out and
 * back, this emulates a device whose hardware rate is not a clean 48000.
 */
export function resample(input: Float32Array, fromRate: number, toRate: number): Float32Array {
  const ratio = toRate / fromRate;
  const outLength = Math.floor(input.length * ratio);
  const out = new Float32Array(outLength);
  const halfTaps = 16;
  const cutoff = Math.min(1, ratio) * 0.95;
  for (let i = 0; i < outLength; i += 1) {
    const center = i / ratio;
    const start = Math.ceil(center - halfTaps);
    const end = Math.floor(center + halfTaps);
    let sum = 0;
    let weight = 0;
    for (let j = start; j <= end; j += 1) {
      if (j < 0 || j >= input.length) continue;
      const x = center - j;
      const sinc = x === 0 ? 1 : Math.sin(Math.PI * cutoff * x) / (Math.PI * cutoff * x);
      const window = 0.5 + 0.5 * Math.cos((Math.PI * x) / halfTaps);
      const coefficient = sinc * window;
      sum += (input[j] ?? 0) * coefficient;
      weight += coefficient;
    }
    out[i] = weight === 0 ? 0 : sum / weight;
  }
  return out;
}

/** Overlays a second waveform (cross-talk, or a simultaneous transmission). */
export function overlay(base: Float32Array, other: Float32Array, level: number): Float32Array {
  const out = Float32Array.from(base);
  for (let i = 0; i < out.length; i += 1) {
    out[i] = (out[i] ?? 0) + (other[i] ?? 0) * level;
  }
  return out;
}

/** Echo: one delayed, attenuated copy — a cheap stand-in for room reverb. */
export function withEcho(
  samples: Float32Array,
  delayMs: number,
  level: number,
  sampleRate: number,
): Float32Array {
  const out = Float32Array.from(samples);
  const delay = Math.round((delayMs / 1000) * sampleRate);
  for (let i = delay; i < out.length; i += 1) {
    out[i] = (out[i] ?? 0) + (out[i - delay] ?? 0) * level;
  }
  return out;
}

/** Simulates a maximised speaker: everything above `ceiling` is flattened. */
export function hardClip(samples: Float32Array, ceiling: number): Float32Array {
  const out = new Float32Array(samples.length);
  for (let i = 0; i < samples.length; i += 1) {
    out[i] = Math.max(-ceiling, Math.min(ceiling, samples[i] ?? 0));
  }
  return out;
}

/** Simulates a quiet or loud device: linear gain expressed in dB. */
export function applyGainDb(samples: Float32Array, gainDb: number): Float32Array {
  const gain = 10 ** (gainDb / 20);
  const out = new Float32Array(samples.length);
  for (let i = 0; i < samples.length; i += 1) {
    out[i] = (samples[i] ?? 0) * gain;
  }
  return out;
}
