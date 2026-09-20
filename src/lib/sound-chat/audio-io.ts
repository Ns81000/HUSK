/**
 * Sound Chat audio I/O: AudioContext lifecycle, microphone permission states,
 * the locked capture pipeline, playback, and teardown. Promoted from the Phase
 * 0 spike's `audio-io.ts` (which the harness still uses directly, because it
 * deliberately creates non-48000 contexts to measure them).
 *
 * Measured rules this module exists to enforce (see
 * `prompts/sound-chat/SOUND_CHAT_LOG.md`):
 * - the AudioContext is created inside a user-gesture call stack (iOS
 *   requirement) and must be verified to actually run at 48000 Hz — a context
 *   the browser forced to a different rate decoded nothing in the harness at
 *   44100 Hz, so that failure is surfaced as a specific error, never silence.
 * - the Rx codec is fed exactly one 1024-sample chunk per `onaudioprocess`,
 *   decoded immediately; a partial or accumulated feed permanently
 *   de-synchronises the fixed-length receiver.
 * - the listener must already be listening before the peer transmits: a block
 *   only decodes once 90 whole frames (1.92 s) have passed through the window.
 * - the Rx feed pauses for the exact transmit window plus a tail, because
 *   unpaused self-transmission decodes (reproduced in Phase 0).
 * - every media track gets an explicit `track.stop()` on teardown (the
 *   reference implementation leaks the mic indicator without it).
 * - a hidden page's audio callbacks can stall; whole chunks are never torn,
 *   but a transmission spanning the gap is lost gracefully (decodes to null).
 *   The transport watches visibility and never starts a send while hidden.
 * - three failure kinds are deliberately kept apart (independent verification
 *   pass): a codec call that throws (the Rx path is unusable, the feed stops,
 *   `onModuleError`), a thrown misuse guard from our own caller error (same
 *   report, but the module itself is healthy), and an exception from the
 *   *application's* `onDecoded` (reported on its own channel, feed keeps
 *   running — a consumer bug must never present as a dead codec).
 * - teardown is idempotent: `close()` on an already-closed context rejects
 *   (measured Chromium `InvalidStateError`), so every close is
 *   rejection-handled. Nothing here may ever leak an unhandled rejection.
 */

import { CODEC_SAMPLES_PER_FRAME, type SoundChatCodec } from "./codec";

/** The one device rate Sound Chat runs at (a protocol constant, not a device fact). */
export const REQUIRED_SAMPLE_RATE = 48000;

/** The Rx feed stays paused this long past the transmit audio itself. */
export const RX_PAUSE_TAIL_SECONDS = 0.5;

const MICROPHONE_CONSTRAINTS: MediaTrackConstraints = {
  // WebRTC's default pipeline runs noise suppression, AGC and AEC, all of
  // which are hostile to an FSK tone burst.
  echoCancellation: false,
  noiseSuppression: false,
  autoGainControl: false,
};

export type MicrophoneAccess =
  | { kind: "granted"; stream: MediaStream }
  | { kind: "denied"; cause: string }
  | { kind: "missing"; cause: string }
  | { kind: "unsupported"; cause: string };

/**
 * Asks for the microphone with the locked "clean" constraints. Resolves with a
 * discriminated state instead of throwing: `denied` (permission refused or
 * blocked), `missing` (no microphone device exists), `unsupported` (no
 * `mediaDevices` — insecure context or browser without WebRTC capture).
 */
export async function requestMicrophoneAccess(): Promise<MicrophoneAccess> {
  if (typeof navigator === "undefined" || navigator.mediaDevices === undefined) {
    return {
      kind: "unsupported",
      cause:
        "this browser or context does not expose microphone capture (mediaDevices is unavailable)",
    };
  }
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: MICROPHONE_CONSTRAINTS });
    return { kind: "granted", stream };
  } catch (error) {
    const cause = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    if (
      error instanceof DOMException &&
      (error.name === "NotFoundError" ||
        error.name === "DevicesNotFoundError" ||
        error.name === "OverconstrainedError")
    ) {
      return { kind: "missing", cause };
    }
    return { kind: "denied", cause };
  }
}

/** The browser refused or could not deliver a 48000 Hz AudioContext. */
export class AudioContextRateError extends Error {
  override readonly name = "AudioContextRateError";
}

/**
 * Creates the session AudioContext at the locked rate. Must be called from a
 * user-gesture call stack (the UI drives this from its start button); iOS
 * refuses to unmute contexts created outside one.
 *
 * Throws `AudioContextRateError` when the browser ignores the requested rate —
 * that device cannot decode Sound Chat blocks, and the user must be told so
 * explicitly instead of staring at a silence that "does not work".
 */
export function createAudioContext(): AudioContext {
  const context = new AudioContext({ sampleRate: REQUIRED_SAMPLE_RATE });
  if (context.sampleRate !== REQUIRED_SAMPLE_RATE) {
    // Closing at the wrong rate still has to be rejection-handled: a leaked
    // unhandled rejection is a real error-report event (measured).
    void context.close().catch(() => {});
    throw new AudioContextRateError(
      `this device's audio runs at ${context.sampleRate} Hz; Sound Chat needs ${REQUIRED_SAMPLE_RATE} Hz and cannot decode on it`,
    );
  }
  return context;
}

/** Resumes a suspended context (autoplay policy) if it is not running yet. */
export async function ensureRunning(context: AudioContext): Promise<AudioContext> {
  if (context.state !== "running") {
    await context.resume();
  }
  return context;
}

export type ListenOptions = {
  context: AudioContext;
  stream: MediaStream;
  codec: SoundChatCodec;
  onDecoded: (payload: Uint8Array) => void;
  /**
   * Called when a codec call throws — the Rx path is unusable for the rest of
   * the session and the feed has stopped. That covers a real module death and
   * our own broken frame contract (a `CodecUsageError`), which leaves the
   * instance permanently de-synchronised; classify with `instanceof` to pick
   * the copy. Consumer errors never arrive here.
   */
  onModuleError?: (error: unknown) => void;
  /**
   * Called when `onDecoded` itself throws. The feed keeps running: one bad
   * consumer must not look like a dead codec. When omitted, the error is
   * reported on `console.error` rather than silently swallowed (master plan
   * constraint 6).
   */
  onDecodedError?: (error: unknown) => void;
};

export type ListenHandle = {
  /** Chunks delivered by the audio callback, paused or not. */
  readonly chunks: number;
  /** Chunks dropped because the Rx feed was paused for our own transmit. */
  readonly skippedWhilePaused: number;
  readonly paused: boolean;
  /**
   * Pauses the Rx feed for `seconds` plus the measured tail. Time is taken
   * from the AudioContext clock, not wall-clock timers, so it survives
   * background-tab timer throttling.
   */
  pause: (seconds: number) => void;
  stop: () => void;
};

/**
 * Attaches the microphone to the Rx codec: a `createScriptProcessor(1024, 1, 1)`
 * node feeding the codec exactly one chunk per audio callback, decoded
 * immediately (never accumulated). The node is muted into the destination only
 * so Chromium keeps pulling the graph.
 */
export function startListening(options: ListenOptions): ListenHandle {
  const { context, stream, codec, onDecoded } = options;
  const track = stream.getAudioTracks()[0];
  if (track === undefined) throw new Error("the microphone stream has no audio track");

  const source = context.createMediaStreamSource(stream);
  const processor = context.createScriptProcessor(CODEC_SAMPLES_PER_FRAME, 1, 1);
  const sink = context.createGain();
  sink.gain.value = 0;

  const state = { chunks: 0, skipped: 0, pausedUntil: 0, stopped: false };

  processor.onaudioprocess = (event) => {
    if (state.stopped) return;
    state.chunks += 1;
    if (context.currentTime < state.pausedUntil) {
      state.skipped += 1;
      return;
    }
    // Layer 1 — the codec. Only this may declare the feed dead: a thrown codec
    // call (or a misuse guard that means the Rx instance is permanently
    // de-synchronised) ends the feed, and it is reported as codec failure.
    let decoded: Uint8Array | null;
    try {
      // `getChannelData` hands back a reused buffer: finish with it
      // synchronously (the codec copies into wasm memory immediately).
      decoded = codec.decode(event.inputBuffer.getChannelData(0));
    } catch (error) {
      state.stopped = true;
      options.onModuleError?.(error);
      return;
    }
    if (decoded === null) return;

    // Layer 2 — the application. A consumer that throws is a consumer bug: it
    // must not stop the mic feed and must never be reported as a dead codec
    // (independent verification pass, master plan Section 10.1 class 1).
    try {
      onDecoded(decoded);
    } catch (error) {
      if (options.onDecodedError !== undefined) options.onDecodedError(error);
      else console.error("Sound Chat: the decoded-payload consumer threw", error);
    }
  };

  source.connect(processor);
  processor.connect(sink);
  sink.connect(context.destination);

  return {
    get chunks() {
      return state.chunks;
    },
    get skippedWhilePaused() {
      return state.skipped;
    },
    get paused() {
      return context.currentTime < state.pausedUntil;
    },
    pause(seconds: number) {
      state.pausedUntil = Math.max(
        state.pausedUntil,
        context.currentTime + seconds + RX_PAUSE_TAIL_SECONDS,
      );
    },
    stop() {
      state.stopped = true;
      processor.onaudioprocess = null;
      processor.disconnect();
      source.disconnect();
      sink.disconnect();
      // The reference implementation famously leaks this: the mic indicator
      // stays on without it.
      track.stop();
      stream.getTracks().forEach((each) => each.stop());
    },
  };
}

export type TransmitResult = {
  sampleCount: number;
  durationMs: number;
};

/**
 * Plays one encoded block through the speakers: codec encode -> copy ->
 * AudioBuffer -> AudioBufferSourceNode. The context is guaranteed 48000 Hz by
 * `createAudioContext`, so the encoded samples map 1:1 onto the buffer.
 */
export function transmit(
  context: AudioContext,
  codec: SoundChatCodec,
  payload: Uint8Array,
): TransmitResult {
  // `Float32Array.from` guarantees a plain ArrayBuffer-backed copy of the
  // codec's wasm-memory view, as `copyToChannel` requires.
  const samples = Float32Array.from(codec.encode(payload));
  const buffer = context.createBuffer(1, samples.length, context.sampleRate);
  buffer.copyToChannel(samples, 0);
  const source = context.createBufferSource();
  source.buffer = buffer;
  source.connect(context.destination);
  source.start();
  return {
    sampleCount: samples.length,
    durationMs: Math.round((samples.length / context.sampleRate) * 1000),
  };
}

/**
 * The composed send the transport uses every time: pause the Rx feed for the
 * exact transmit window (plus the measured tail) *before* the first sample
 * leaves the speaker, so our own transmission is never decoded by ourselves.
 */
export function transmitAndPause(
  listen: ListenHandle,
  context: AudioContext,
  codec: SoundChatCodec,
  payload: Uint8Array,
): TransmitResult {
  const samples = Float32Array.from(codec.encode(payload));
  const durationMs = Math.round((samples.length / context.sampleRate) * 1000);
  listen.pause(durationMs / 1000);
  const buffer = context.createBuffer(1, samples.length, context.sampleRate);
  buffer.copyToChannel(samples, 0);
  const source = context.createBufferSource();
  source.buffer = buffer;
  source.connect(context.destination);
  source.start();
  return { sampleCount: samples.length, durationMs };
}

/**
 * Full teardown for unmount: stop the capture (and every media track), then
 * close the AudioContext. Safe to call with partial state, and safe to call
 * more than once: measured in Chromium, `close()` on an already-closed context
 * rejects with `InvalidStateError`, which `void` alone would surface as an
 * unhandled rejection (React's dev double-mount makes a second call routine).
 */
export function teardownAudio(
  listen: ListenHandle | undefined,
  context: AudioContext | undefined,
): void {
  listen?.stop();
  void context?.close().catch(() => {});
}

export type Unsubscribe = () => void;

/**
 * Subscribes to page visibility. The transport uses this to hold its own sends
 * while hidden; the Rx feed keeps running (whole chunks are never torn by
 * throttling — a transmission spanning a hidden gap simply decodes to null).
 */
export function onVisibilityChange(listener: (hidden: boolean) => void): Unsubscribe {
  if (typeof document === "undefined") return () => {};
  const handler = () => listener(document.visibilityState === "hidden");
  document.addEventListener("visibilitychange", handler);
  return () => document.removeEventListener("visibilitychange", handler);
}
