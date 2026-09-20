/**
 * The browser half of the Phase 0 fake-microphone harness.
 *
 * It wires the *real* spike modules together — vendored codec, locked instance
 * configuration, real `getUserMedia`, real `ScriptProcessor(1024, 1, 1)` — and
 * exposes the single async entry the Playwright spec calls. It is not feature
 * UI: there is no route, no component and no design-system surface here.
 *
 * The page is loaded directly from the Vite dev server
 * (`/src/lib/sound-chat/harness/page.ts`), exactly like a module under test: it
 * runs under the app's real CSP and real module graph, with no separate build
 * and no copy of the pipeline.
 */

import {
  attachCapture,
  requestMicrophone,
  type CaptureHandle,
  type MicrophoneProfile,
} from "../spike/audio-io";
import {
  CodecModuleError,
  float32ToBytes,
  openSoundChatCodec,
  type SoundChatCodec,
} from "../spike/codec";
import { fromHex, PRIMARY_PAYLOAD, toHex } from "./payloads";

export type SelfTransmitMode = "none" | "listen" | "pause-listening";

export type HarnessOptions = {
  /** AudioContext rate — the *device* rate, not the codec's 48000 constant. */
  deviceRate: number;
  profile: MicrophoneProfile;
  /** Total capture window, in ms. */
  captureMs: number;
  selfTransmit: SelfTransmitMode;
  /**
   * Stop this long after the last decode; `0` runs the whole capture window.
   * A multi-block transmission must not be cut short by the first block's decode.
   */
  settleAfterDecodeMs: number;
};

export type DecodeEvent = { hex: string; atMs: number };

export type HarnessSuccess = {
  ok: true;
  contextSampleRate: number;
  trackLabel: string;
  trackSampleRate: number;
  chunks: number;
  skipped: number;
  codecState: string;
  transmittedHex: string | null;
  transmitMs: number | null;
  decodes: DecodeEvent[];
  elapsedMs: number;
};

export type HarnessFailure = {
  ok: false;
  error: string;
  errorKind: "codec-module" | "browser" | "unknown";
};

export type HarnessResult = HarnessSuccess | HarnessFailure;

/** One encoded block, handed to the Node side as base64 (see `encodeHex`). */
export type EncodedBlock = { sampleCount: number; base64: string };

export type HarnessEntry = {
  prepare: (options: HarnessOptions) => void;
  encode: (hex: string) => Promise<EncodedBlock>;
  play: (hex: string) => Promise<{ sampleCount: number; durationMs: number }>;
  run: () => Promise<HarnessResult>;
};

declare global {
  interface Window {
    __soundChatHarness: HarnessEntry;
  }
}

/** The self-transmit pause outlives the audio, mirroring Phase 1's plan. */
const PAUSE_TAIL_MS = 500;

let prepared: { options: HarnessOptions } | undefined;
let codec: SoundChatCodec | undefined;
let context: AudioContext | undefined;

async function ensureContextAndCodec(): Promise<{ context: AudioContext; codec: SoundChatCodec }> {
  const audioContext =
    context ?? new AudioContext({ sampleRate: prepared?.options.deviceRate ?? 48000 });
  context = audioContext;
  await audioContext.resume();
  if (codec === undefined || codec.state !== "ready") {
    codec = await openSoundChatCodec({
      sampleRateInp: audioContext.sampleRate,
      sampleRateOut: audioContext.sampleRate,
    });
  }
  return { context: audioContext, codec };
}

async function runHarness(): Promise<HarnessResult> {
  if (prepared === undefined) throw new Error("the harness was not prepared");
  const { options } = prepared;

  let capture: CaptureHandle | undefined;
  try {
    const { context: audioContext, codec: activeCodec } = await ensureContextAndCodec();

    let transmittedHex: string | null = null;
    let transmitMs: number | null = null;
    if (options.selfTransmit !== "none") {
      const samples = activeCodec.encode(PRIMARY_PAYLOAD.bytes);
      transmitMs = (samples.length / audioContext.sampleRate) * 1000;
      transmittedHex = PRIMARY_PAYLOAD.hex;
    }

    const decodes: DecodeEvent[] = [];
    const state = { skipped: 0 };
    const startedAt = performance.now();

    const stream = await requestMicrophone(options.profile);
    capture = attachCapture({
      context: audioContext,
      stream,
      onChunk: (chunk) => {
        const elapsed = performance.now() - startedAt;
        const isPaused =
          options.selfTransmit === "pause-listening" &&
          transmitMs !== null &&
          elapsed < transmitMs + PAUSE_TAIL_MS;
        if (isPaused) {
          state.skipped += 1;
          return;
        }
        const decoded = activeCodec.decode(chunk);
        if (decoded !== null) decodes.push({ hex: toHex(decoded), atMs: Math.round(elapsed) });
      },
    });

    await new Promise<void>((resolve) => {
      const tick = () => {
        const elapsed = performance.now() - startedAt;
        const lastDecode = decodes.at(-1);
        const settled =
          options.settleAfterDecodeMs > 0 &&
          lastDecode !== undefined &&
          elapsed - lastDecode.atMs > options.settleAfterDecodeMs;
        if (elapsed >= options.captureMs || settled) {
          resolve();
          return;
        }
        setTimeout(tick, 120);
      };
      setTimeout(tick, 120);
    });

    return {
      ok: true,
      contextSampleRate: audioContext.sampleRate,
      trackLabel: capture.trackLabel,
      trackSampleRate: capture.trackSampleRate,
      chunks: capture.chunks,
      skipped: state.skipped,
      codecState: activeCodec.state,
      transmittedHex,
      transmitMs: transmitMs === null ? null : Math.round(transmitMs),
      decodes,
      elapsedMs: Math.round(performance.now() - startedAt),
    };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
      errorKind:
        error instanceof CodecModuleError
          ? "codec-module"
          : error instanceof Error
            ? "browser"
            : "unknown",
    };
  } finally {
    capture?.stop();
  }
}

/**
 * Samples -> base64. A raw `ArrayBuffer` does not survive Playwright's
 * `page.evaluate` serialisation (measured: it arrives as a zero-length buffer),
 * so the Tx samples cross the boundary as text.
 */
function toBase64(bytes: Uint8Array): string {
  const chunk = 8192;
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += chunk) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunk));
  }
  return btoa(binary);
}

/** Encodes one hex payload with the real Tx path; returns its samples as base64. */
async function encodeHex(hex: string): Promise<EncodedBlock> {
  const { codec: activeCodec } = await ensureContextAndCodec();
  const samples = activeCodec.encode(fromHex(hex));
  return { sampleCount: samples.length, base64: toBase64(float32ToBytes(samples)) };
}

/**
 * Encodes one hex payload and plays it through this page's own output — the
 * sound its own speaker would put into the room (and into its own microphone).
 * Not used by the WAV-fed capture runs; it exists so the browser Tx path can be
 * exercised on its own.
 */
async function playHex(hex: string): Promise<{ sampleCount: number; durationMs: number }> {
  const { context: audioContext, codec: activeCodec } = await ensureContextAndCodec();
  // `Float32Array.from` guarantees a plain ArrayBuffer, never a wasm view.
  const samples = Float32Array.from(activeCodec.encode(fromHex(hex)));
  const buffer = audioContext.createBuffer(1, samples.length, audioContext.sampleRate);
  buffer.copyToChannel(samples, 0);
  const source = audioContext.createBufferSource();
  source.buffer = buffer;
  source.connect(audioContext.destination);
  source.start();
  return {
    sampleCount: samples.length,
    durationMs: Math.round((samples.length / audioContext.sampleRate) * 1000),
  };
}

window.__soundChatHarness = {
  prepare: (options) => {
    prepared = { options };
  },
  encode: encodeHex,
  play: playHex,
  run: runHarness,
};
