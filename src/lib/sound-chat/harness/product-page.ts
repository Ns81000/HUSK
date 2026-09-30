/**
 * The Phase 4 browser half: the PRODUCT's capture and send path, in a real
 * Chromium, driven through the same fake-microphone mechanism the Phase 0
 * harness uses.
 *
 * WHY THIS PAGE EXISTS. `harness/page.ts` drives `spike/audio-io`'s
 * `attachCapture` — a second implementation of the ScriptProcessor pipeline —
 * so the product's own `startListening` (its pause arithmetic and its
 * codec-error / consumer-error split) and `transmitAndPause` (the pause window
 * for a multi-block message) were never executed in a browser at all. Everything
 * the Phase 0 harness proved about the channel was proved about a copy of the
 * code. This page imports the product modules directly and nothing else, so a
 * measurement taken here is a measurement of the code the app runs.
 *
 * THE ONE THING THAT IS NOT PRODUCT CODE: the room. `transmitAndPause` connects
 * its `AudioBufferSourceNode` to `context.destination`, and Chromium's
 * `--use-file-for-fake-audio-capture` is a *file*, not a loopback — the page's
 * speaker output never reaches the fake microphone. Without a room, the
 * self-reception question cannot be asked at all. So the page builds one: a
 * `MediaStreamAudioDestinationNode` fed by both the fake microphone and a copy
 * of the very samples the product just played, handed to `startListening`. The
 * pause, the encode, the ScriptProcessor and the decode are all the product's;
 * only the speaker-to-microphone leg is a fixture, and the fixture's sample
 * count is reported so a spec can assert it matches what the product played.
 */

import {
  AudioContextRateError,
  createAudioContext,
  ensureRunning,
  requestMicrophoneAccess,
  startListening,
  teardownAudio,
  transmitAndPause,
  type ListenHandle,
} from "../audio-io";
import { CodecModuleError, openSoundChatCodec, type SoundChatCodec } from "../codec";
import { PRIMARY_PAYLOAD, SEQUENCE_PAYLOADS, toHex } from "./payloads";

/**
 * What the page does with the Rx feed while it is transmitting.
 *
 * `pause` is the product's own mitigation. `leave-open` is the control, and the
 * ONLY difference between the two arms is the `pauseSeconds` argument handed to
 * the same `transmitAndPause` call — so any difference in what the microphone
 * decodes is attributable to the pause and to nothing else.
 */
export type SelfTransmitMode = "none" | "leave-open" | "pause";

/** Which layer of `startListening` is made to throw, if any. */
export type FaultMode = "none" | "consumer" | "codec";

export type ProductRequest = {
  /** Total capture window, in ms. */
  captureMs: number;
  /** Stop this long after the last decode; `0` runs the whole capture window. */
  settleAfterDecodeMs: number;
  /** How many blocks to play through the speakers. */
  blocks: number;
  selfTransmit: SelfTransmitMode;
  fault: FaultMode;
};

export type ProductDecode = { hex: string; atMs: number; whilePaused: boolean };

export type ProductObservation = {
  ok: boolean;
  /** Populated when the pipeline could not be built at all. */
  error: string;
  errorKind: "none" | "rate" | "microphone" | "codec" | "browser";
  contextSampleRate: number;
  trackLabel: string;
  trackSampleRate: number;
  /** Every chunk the audio callback delivered, paused or not. */
  chunks: number;
  chunksBeforeSend: number;
  /** Chunks dropped because the feed was closed for our own transmit. */
  skippedWhilePaused: number;
  paused: boolean;
  decodes: ProductDecode[];
  moduleErrors: string[];
  consumerErrors: string[];
  /**
   * Context-clock seconds the feed was observed closed, rising edge to falling
   * edge. `-1` when it was never closed, which is the control arm's answer.
   */
  pausedWindowSeconds: number;
  /** What `transmitAndPause` returned for each block, in order. */
  transmittedMs: number[];
  /** The room fixture's own sample count per block, for cross-checking. */
  roomSampleCounts: number[];
  /**
   * `chunks - skippedWhilePaused`: chunks that actually reached the codec. A
   * closed feed must be *skipping*, not torn, so this has to keep growing.
   */
  chunksFedToCodec: number;
  codecState: string;
  elapsedMs: number;
};

export type ProductEntry = {
  run: (request: ProductRequest) => Promise<ProductObservation>;
};

declare global {
  interface Window {
    __soundChatProductHarness: ProductEntry;
  }
}

/** How long to let the receiver's 90-frame analysis window fill before Tx. */
const WARMUP_MS = 2600;

/** The scheduling lead `session.ts` uses, so a first block is never in the past. */
const TRANSMIT_LEAD_SECONDS = 0.05;

/** How often the pause poller samples the AudioContext clock. */
const POLL_MS = 16;

/**
 * A caught value, rendered for the log. `cause` is the one name the anti-slop
 * rules allow on an `unknown` parameter: this is the boundary where a throw
 * becomes a string, not somewhere a parsed value is being used unparsed.
 */
function describe(cause: unknown): string {
  return cause instanceof Error ? `${cause.name}: ${cause.message}` : String(cause);
}

function empty(
  errorKind: ProductObservation["errorKind"],
  error: string,
  contextSampleRate: number,
): ProductObservation {
  return {
    ok: false,
    error,
    errorKind,
    contextSampleRate,
    trackLabel: "",
    trackSampleRate: 0,
    chunks: 0,
    chunksBeforeSend: 0,
    skippedWhilePaused: 0,
    paused: false,
    decodes: [],
    moduleErrors: [],
    consumerErrors: [],
    pausedWindowSeconds: -1,
    transmittedMs: [],
    roomSampleCounts: [],
    chunksFedToCodec: 0,
    codecState: "none",
    elapsedMs: 0,
  };
}

/**
 * The room's speaker: plays the same samples the product just played, into the
 * room's microphone rather than out of a speaker. `transmitAndPause` hard-codes
 * `context.destination`, so this leg cannot be the product's own.
 */
function playIntoRoom(
  context: AudioContext,
  codec: SoundChatCodec,
  room: AudioNode,
  payload: Uint8Array,
  startAtSeconds: number,
): number {
  const samples = Float32Array.from(codec.encode(payload));
  const buffer = context.createBuffer(1, samples.length, context.sampleRate);
  buffer.copyToChannel(samples, 0);
  const source = context.createBufferSource();
  source.buffer = buffer;
  source.connect(room);
  source.start(startAtSeconds);
  return samples.length;
}

/**
 * Measures the pause window on the AudioContext clock rather than a wall clock:
 * the same clock `ListenHandle.pause` reads, so what this reports is the number
 * the product itself used. A closed feed is detected up to one poll late and
 * found open up to one poll late, so the measured window is the true one plus
 * between 0 and two poll intervals.
 */
function startPauseProbe(listen: ListenHandle, context: AudioContext) {
  let closedAt = -1;
  let openedAt = -1;
  const timer = setInterval(() => {
    if (listen.paused) {
      if (closedAt < 0) closedAt = context.currentTime;
      return;
    }
    if (closedAt >= 0 && openedAt < 0) openedAt = context.currentTime;
  }, POLL_MS);
  return {
    stop(): number {
      clearInterval(timer);
      if (closedAt < 0 || openedAt < 0) return -1;
      return openedAt - closedAt;
    },
  };
}

async function runProduct(request: ProductRequest): Promise<ProductObservation> {
  const startedAt = performance.now();
  let context: AudioContext | undefined;
  let codec: SoundChatCodec | undefined;
  let listen: ListenHandle | undefined;
  let microphone: MediaStream | undefined;
  try {
    // The product's own startup order, including its rate check: a device that
    // will not run at 48000 Hz has to be told so, not left decoding nothing.
    context = createAudioContext();
    await ensureRunning(context);
    const contextSampleRate = context.sampleRate;

    const access = await requestMicrophoneAccess();
    if (access.kind !== "granted") {
      return empty("microphone", access.cause, contextSampleRate);
    }
    microphone = access.stream;
    const track = access.stream.getAudioTracks()[0];
    const trackLabel = track?.label ?? "";
    const trackSampleRate = track?.getSettings().sampleRate ?? 0;

    try {
      codec = await openSoundChatCodec({
        sampleRateInp: context.sampleRate,
        sampleRateOut: context.sampleRate,
      });
    } catch (error) {
      return empty(
        error instanceof CodecModuleError ? "codec" : "browser",
        describe(error),
        contextSampleRate,
      );
    }

    // The room: this device's own microphone, plus this device's own speaker.
    const room = context.createMediaStreamDestination();
    context.createMediaStreamSource(access.stream).connect(room);

    if (request.fault === "codec") {
      // A throwing codec call, injected on the real instance rather than
      // through a stand-in object, so the rest of the pipeline stays the real
      // one and the only thing under test is `startListening`'s error split.
      Object.defineProperty(codec, "decode", {
        configurable: true,
        value: () => {
          throw new Error("injected codec failure");
        },
      });
    }

    const decodes: ProductDecode[] = [];
    const moduleErrors: string[] = [];
    const consumerErrors: string[] = [];

    listen = startListening({
      context,
      stream: room.stream,
      codec,
      onDecoded: (payload) => {
        if (request.fault === "consumer") throw new TypeError("injected consumer failure");
        decodes.push({
          hex: toHex(payload),
          atMs: Math.round(performance.now() - startedAt),
          whilePaused: listen?.paused ?? false,
        });
      },
      onModuleError: (error) => moduleErrors.push(describe(error)),
      onDecodedError: (error) => consumerErrors.push(describe(error)),
    });

    const probe = startPauseProbe(listen, context);
    await new Promise<void>((resolve) => setTimeout(resolve, WARMUP_MS));
    const chunksBeforeSend = listen.chunks;

    const transmittedMs: number[] = [];
    const roomSampleCounts: number[] = [];
    if (request.blocks > 0) {
      const payloads = [PRIMARY_PAYLOAD, SEQUENCE_PAYLOADS[0]].slice(0, request.blocks);
      // The block length, measured rather than assumed: the same division
      // `transmitAndPause` performs on the samples the codec just produced.
      const blockSeconds =
        Float32Array.from(codec.encode(PRIMARY_PAYLOAD.bytes)).length / context.sampleRate || 0;
      const startAt = context.currentTime + TRANSMIT_LEAD_SECONDS;
      for (const [index, payload] of payloads.entries()) {
        if (payload === undefined) continue;
        // The same arithmetic `SoundChatSession#transmitBlocks` uses: the first
        // block carries the pause for the *whole* window, the rest pass 0, and
        // the raw window goes in because `ListenHandle.pause` adds the measured
        // tail itself. Nothing here adds the tail a second time.
        const hold =
          request.selfTransmit === "pause" && index === 0 ? payloads.length * blockSeconds : 0;
        const at = startAt + index * blockSeconds;
        const result = transmitAndPause(listen, context, codec, payload.bytes, at, hold);
        transmittedMs.push(result.durationMs);
        roomSampleCounts.push(playIntoRoom(context, codec, room, payload.bytes, at));
      }
    }

    await new Promise<void>((resolve) => {
      const tick = () => {
        const elapsed = performance.now() - startedAt;
        const last = decodes.at(-1);
        const settled =
          request.settleAfterDecodeMs > 0 &&
          last !== undefined &&
          elapsed - last.atMs > request.settleAfterDecodeMs;
        if (elapsed >= request.captureMs || settled) {
          resolve();
          return;
        }
        setTimeout(tick, 120);
      };
      setTimeout(tick, 120);
    });
    const pausedWindowSeconds = probe.stop();

    return {
      ok: true,
      error: "",
      errorKind: "none",
      contextSampleRate,
      trackLabel,
      trackSampleRate,
      chunks: listen.chunks,
      chunksBeforeSend,
      skippedWhilePaused: listen.skippedWhilePaused,
      paused: listen.paused,
      decodes,
      moduleErrors,
      consumerErrors,
      pausedWindowSeconds,
      transmittedMs,
      roomSampleCounts,
      chunksFedToCodec: listen.chunks - listen.skippedWhilePaused,
      codecState: codec.state,
      elapsedMs: Math.round(performance.now() - startedAt),
    };
  } catch (error) {
    return empty(
      error instanceof AudioContextRateError ? "rate" : "browser",
      describe(error),
      context?.sampleRate ?? 0,
    );
  } finally {
    teardownAudio(listen, context);
    codec?.close();
    // `startListening` was given the room's stream, so the microphone track it
    // would normally release is this page's to release.
    microphone?.getTracks().forEach((each) => each.stop());
  }
}

window.__soundChatProductHarness = {
  run: (request) => runProduct(request),
};
