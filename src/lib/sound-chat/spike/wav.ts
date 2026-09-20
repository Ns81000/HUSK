/**
 * Minimal 16-bit PCM RIFF/WAVE reader+writer for the Phase 0 fake-mic harness.
 *
 * Chromium's `--use-file-for-fake-audio-capture` consumes a `.wav` via
 * `media::AudioFileReader`, which requires 16 bits per sample and at most 2
 * channels; this module writes exactly that and nothing more.
 */

export type WavAudio = {
  sampleRate: number;
  samples: Float32Array;
};

const HEADER_BYTES = 44;

function writeAscii(view: DataView, offset: number, text: string): void {
  for (let i = 0; i < text.length; i += 1) {
    view.setUint8(offset + i, text.charCodeAt(i));
  }
}

function readAscii(view: DataView, offset: number, length: number): string {
  let text = "";
  for (let i = 0; i < length; i += 1) {
    text += String.fromCharCode(view.getUint8(offset + i));
  }
  return text;
}

/** F32 [-1, 1] -> mono 16-bit PCM WAV bytes. */
export function encodeWav16(audio: WavAudio): Uint8Array {
  const { sampleRate, samples } = audio;
  const dataBytes = samples.length * 2;
  const buffer = new ArrayBuffer(HEADER_BYTES + dataBytes);
  const view = new DataView(buffer);

  writeAscii(view, 0, "RIFF");
  view.setUint32(4, 36 + dataBytes, true);
  writeAscii(view, 8, "WAVE");
  writeAscii(view, 12, "fmt ");
  view.setUint32(16, 16, true); // PCM fmt chunk size
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true); // byte rate
  view.setUint16(32, 2, true); // block align
  view.setUint16(34, 16, true); // bits per sample
  writeAscii(view, 36, "data");
  view.setUint32(40, dataBytes, true);

  for (let i = 0; i < samples.length; i += 1) {
    const clamped = Math.max(-1, Math.min(1, samples[i] ?? 0));
    view.setInt16(HEADER_BYTES + i * 2, Math.round(clamped * 32767), true);
  }
  return new Uint8Array(buffer);
}

/** Reads the first PCM `data` chunk of a 16-bit WAV, mixing channels to mono. */
export function decodeWav16(bytes: Uint8Array): WavAudio {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (
    bytes.byteLength < HEADER_BYTES ||
    readAscii(view, 0, 4) !== "RIFF" ||
    readAscii(view, 8, 4) !== "WAVE"
  ) {
    throw new Error("not a RIFF/WAVE file");
  }

  let channels = 1;
  let bitsPerSample = 0;
  let sampleRate = 0;
  let dataOffset = -1;
  let dataBytes = 0;

  let cursor = 12;
  while (cursor + 8 <= bytes.byteLength) {
    const chunkId = readAscii(view, cursor, 4);
    const chunkSize = view.getUint32(cursor + 4, true);
    const body = cursor + 8;
    if (chunkId === "fmt ") {
      channels = view.getUint16(body + 2, true);
      sampleRate = view.getUint32(body + 4, true);
      bitsPerSample = view.getUint16(body + 14, true);
    } else if (chunkId === "data") {
      dataOffset = body;
      dataBytes = Math.min(chunkSize, bytes.byteLength - body);
    }
    cursor = body + chunkSize + (chunkSize % 2);
  }

  if (dataOffset < 0 || bitsPerSample !== 16 || channels < 1) {
    throw new Error(`unsupported WAV (bits=${bitsPerSample}, channels=${channels})`);
  }

  const frameCount = Math.floor(dataBytes / (2 * channels));
  const samples = new Float32Array(frameCount);
  for (let frame = 0; frame < frameCount; frame += 1) {
    let sum = 0;
    for (let channel = 0; channel < channels; channel += 1) {
      sum += view.getInt16(dataOffset + (frame * channels + channel) * 2, true);
    }
    samples[frame] = sum / channels / 32768;
  }
  return { sampleRate, samples };
}
