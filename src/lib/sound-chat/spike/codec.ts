/**
 * Phase 0 spike: the thinnest honest wrapper around the two ggwave instances
 * the Sound Chat design locks in (master plan Section 3).
 *
 * Every rule enforced here is a measured finding from
 * `prompts/sound-chat/GGWAVE_DEEP_DIVE.md`, not defensive speculation:
 * - `init()` can return a negative id (module full) — never call the codec then.
 * - `encode()` with an empty payload traps the whole wasm module.
 * - every returned view aliases a static C++ buffer inside wasm memory: it is
 *   silently detached by the next memory growth and overwritten by the next
 *   call, so it is copied immediately and never held.
 * - a thrown codec call means the module is dead for the rest of the page
 *   session; the caller must offer a restart rather than retry.
 *
 * This file is a spike scaffold, not the Phase 1 module: it deliberately has
 * no transport state machine, no crypto, and no framing.
 */

import type { GgwaveEnumValue, GgwaveInstance, GgwaveModule } from "../vendor/ggwave";
import { loadGgwaveModule } from "../load-ggwave";

/** Protocol constants. Both peers must use these or nothing ever decodes. */
export const CODEC_SAMPLE_RATE = 48000;
export const CODEC_SAMPLES_PER_FRAME = 1024;
/** Fixed-length block size: the only Tx mode Sound Chat will ever use. */
export const CODEC_PAYLOAD_LENGTH = 64;
/** ggwave's own header recommends 25 and warns above 50 (clipping). */
export const CODEC_TX_VOLUME = 25;

export type CodecState = "ready" | "dead" | "closed";

/** Misuse caught before it can reach the codec. */
export class CodecUsageError extends Error {
  override readonly name = "CodecUsageError";
}

/** The wasm module is unusable for the rest of the page session. */
export class CodecModuleError extends Error {
  override readonly name = "CodecModuleError";
}

/** Everything except `AUDIBLE_FASTEST` is disabled before `init()`. */
const RX_PROTOCOLS_TO_DISABLE = [
  "GGWAVE_PROTOCOL_AUDIBLE_NORMAL",
  "GGWAVE_PROTOCOL_AUDIBLE_FAST",
  "GGWAVE_PROTOCOL_ULTRASOUND_NORMAL",
  "GGWAVE_PROTOCOL_ULTRASOUND_FAST",
  "GGWAVE_PROTOCOL_ULTRASOUND_FASTEST",
  "GGWAVE_PROTOCOL_DT_NORMAL",
  "GGWAVE_PROTOCOL_DT_FAST",
  "GGWAVE_PROTOCOL_DT_FASTEST",
  "GGWAVE_PROTOCOL_MT_NORMAL",
  "GGWAVE_PROTOCOL_MT_FAST",
  "GGWAVE_PROTOCOL_MT_FASTEST",
] as const;

const PROTOCOL_KEY = "GGWAVE_PROTOCOL_AUDIBLE_FASTEST";

/** Loads the vendored artifact through the environment-aware loader (see `vendor/load-ggwave.ts`). */
async function loadCodecModule(): Promise<GgwaveModule> {
  return loadGgwaveModule();
}

/**
 * Raw F32 samples -> the byte view the binding expects. The binding takes
 * `std::string`; a `Float32Array` passed directly would be marshalled
 * element-by-element (values, not bytes). No copy: the buffer must never be a
 * view into wasm memory.
 */
export function float32ToBytes(samples: Float32Array): Uint8Array {
  return new Uint8Array(samples.buffer, samples.byteOffset, samples.byteLength);
}

/** Byte view of a Tx waveform (or capture chunk) back to F32 samples. */
export function bytesToFloat32(bytes: Uint8Array): Float32Array {
  if (bytes.byteLength % 4 !== 0) {
    throw new CodecUsageError(`byte length ${bytes.byteLength} is not a multiple of 4`);
  }
  return new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4);
}

/**
 * Drains the Rx instance's rolling analysis window by feeding it silence.
 *
 * Measured in Phase 0: after a fixed-length block has decoded, the same block
 * keeps decoding for every subsequent chunk until ~90 fresh frames (1.92 s) of
 * different audio have passed through the window, and a *new* transmission fed
 * during that time can be preceded by the *old* block's decode events. Any
 * repeat measurement (and any real session) therefore has to drain or dedupe;
 * this helper exists so the spike can measure one transmission at a time.
 *
 * Returns how many stale decodes it had to drain.
 */
export function flushReceiver(codec: SoundChatCodec, frames = 120): number {
  const silence = new Float32Array(CODEC_SAMPLES_PER_FRAME);
  let stale = 0;
  for (let i = 0; i < frames; i += 1) {
    if (codec.decode(silence) !== null) stale += 1;
  }
  return stale;
}

export class SoundChatCodec {
  readonly #module: GgwaveModule;
  readonly #protocol: GgwaveEnumValue;
  readonly #tx: GgwaveInstance;
  readonly #rx: GgwaveInstance;
  #state: CodecState = "ready";

  constructor(
    module: GgwaveModule,
    protocol: GgwaveEnumValue,
    tx: GgwaveInstance,
    rx: GgwaveInstance,
  ) {
    this.#module = module;
    this.#protocol = protocol;
    this.#tx = tx;
    this.#rx = rx;
  }

  get state(): CodecState {
    return this.#state;
  }

  /** The single Rx protocol this codec will ever decode. */
  get protocol(): GgwaveEnumValue {
    return this.#protocol;
  }

  /** Samples per second the codec operates at — a protocol constant. */
  get sampleRate(): number {
    return CODEC_SAMPLE_RATE;
  }

  /**
   * Tx-only path: payload -> one fixed 64-byte block of F32 samples.
   * Longer-than-a-block payloads are rejected rather than silently truncated
   * by the C++ layer (`ggwave.cpp:693-696` truncates and still reports success).
   */
  encode(payload: Uint8Array): Float32Array {
    if (payload.length === 0) {
      throw new CodecUsageError("refusing to encode an empty payload: it traps the codec module");
    }
    if (payload.length > CODEC_PAYLOAD_LENGTH) {
      throw new CodecUsageError(
        `payload of ${payload.length} bytes exceeds the fixed ${CODEC_PAYLOAD_LENGTH}-byte block`,
      );
    }
    return this.#guard(() => {
      const view = this.#module.encode(this.#tx, payload, this.#protocol, CODEC_TX_VOLUME);
      return bytesToFloat32(Uint8Array.from(view));
    });
  }

  /**
   * Rx-only path: one capture chunk in, at most one decoded block out.
   * `null` covers every failure mode the codec can express — silence and a
   * corrupted transmission are indistinguishable from JavaScript.
   */
  decode(chunk: Float32Array): Uint8Array | null {
    if (chunk.length === 0) return null;
    return this.#guard(() => {
      const view = this.#module.decode(this.#rx, float32ToBytes(chunk));
      if (view.length === 0) return null;
      return Uint8Array.from(view);
    });
  }

  /** Frames the Rx instance would still record if it were receiving. */
  rxDurationFrames(): number {
    return this.#guard(() => this.#module.rxDurationFrames(this.#rx));
  }

  close(): void {
    if (this.#state === "closed") return;
    this.#module.free(this.#tx);
    this.#module.free(this.#rx);
    this.#state = "closed";
  }

  #guard<T>(work: () => T): T {
    if (this.#state === "dead") {
      throw new CodecModuleError("the sound codec module is unusable; restart Sound Chat");
    }
    if (this.#state === "closed") {
      throw new CodecUsageError("the sound codec was closed");
    }
    try {
      return work();
    } catch (cause) {
      // A thrown wasm trap kills the module for the rest of the page session,
      // so this is terminal by design rather than retryable.
      this.#state = "dead";
      throw new CodecModuleError(
        "the sound codec module died during this call; restart Sound Chat",
        {
          cause,
        },
      );
    }
  }
}

function fixedLengthParameters(module: GgwaveModule, operatingMode: number) {
  const parameters = module.getDefaultParameters();
  parameters.payloadLength = CODEC_PAYLOAD_LENGTH;
  parameters.sampleRate = CODEC_SAMPLE_RATE;
  parameters.samplesPerFrame = CODEC_SAMPLES_PER_FRAME;
  parameters.operatingMode = operatingMode;
  return parameters;
}

/**
 * Builds the two-instance, one-protocol configuration Phase 0 has to prove out:
 * one Tx-only and one Rx-only instance held for the whole session, never
 * re-initialised per message, with Rx narrowed to `AUDIBLE_FASTEST`, both
 * fixed-length, and logging switched off.
 *
 * `sampleRateInp`/`sampleRateOut` are the *device* rates and may differ freely
 * from 48000 — the codec resamples internally. `sampleRate`/`samplesPerFrame`
 * are protocol constants and stay fixed (see the master plan Section 3).
 */
export async function openSoundChatCodec(device?: {
  sampleRateInp?: number;
  sampleRateOut?: number;
}): Promise<SoundChatCodec> {
  const module = await loadCodecModule();
  module.disableLog();

  const protocol = module.ProtocolId[PROTOCOL_KEY];
  for (const key of RX_PROTOCOLS_TO_DISABLE) {
    module.rxToggleProtocol(module.ProtocolId[key], 0);
  }
  module.rxToggleProtocol(protocol, 1);

  const txParameters = fixedLengthParameters(module, module.GGWAVE_OPERATING_MODE_TX);
  const rxParameters = fixedLengthParameters(module, module.GGWAVE_OPERATING_MODE_RX);
  if (device?.sampleRateInp !== undefined) rxParameters.sampleRateInp = device.sampleRateInp;
  if (device?.sampleRateOut !== undefined) txParameters.sampleRateOut = device.sampleRateOut;

  const tx = module.init(txParameters);
  const rx = module.init(rxParameters);

  if (tx < 0 || rx < 0) {
    throw new CodecModuleError(`codec refused to allocate both instances (tx=${tx}, rx=${rx})`);
  }

  return new SoundChatCodec(module, protocol, tx, rx);
}
