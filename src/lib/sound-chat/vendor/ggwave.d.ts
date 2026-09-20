/**
 * Hand-written types for the vendored ggwave Emscripten artifact
 * (`./ggwave.js`). The upstream package ships no `.d.ts`, and the artifact is
 * a UMD/CJS bundle, so this file is the only type surface TypeScript sees for
 * the `./ggwave.js` specifier.
 *
 * Shapes here were verified by executing the artifact under Node 24, not read
 * off the upstream docs (see prompts/sound-chat/SOUND_CHAT_LOG.md).
 */

/** An embind enum member. `value` holds the numeric wire value. */
export type GgwaveEnumValue = {
  readonly value: number;
};

export type GgwaveProtocolId = {
  readonly GGWAVE_PROTOCOL_AUDIBLE_NORMAL: GgwaveEnumValue;
  readonly GGWAVE_PROTOCOL_AUDIBLE_FAST: GgwaveEnumValue;
  readonly GGWAVE_PROTOCOL_AUDIBLE_FASTEST: GgwaveEnumValue;
  readonly GGWAVE_PROTOCOL_ULTRASOUND_NORMAL: GgwaveEnumValue;
  readonly GGWAVE_PROTOCOL_ULTRASOUND_FAST: GgwaveEnumValue;
  readonly GGWAVE_PROTOCOL_ULTRASOUND_FASTEST: GgwaveEnumValue;
  readonly GGWAVE_PROTOCOL_DT_NORMAL: GgwaveEnumValue;
  readonly GGWAVE_PROTOCOL_DT_FAST: GgwaveEnumValue;
  readonly GGWAVE_PROTOCOL_DT_FASTEST: GgwaveEnumValue;
  readonly GGWAVE_PROTOCOL_MT_NORMAL: GgwaveEnumValue;
  readonly GGWAVE_PROTOCOL_MT_FAST: GgwaveEnumValue;
  readonly GGWAVE_PROTOCOL_MT_FASTEST: GgwaveEnumValue;
  readonly GGWAVE_PROTOCOL_CUSTOM_0: GgwaveEnumValue;
  readonly GGWAVE_PROTOCOL_CUSTOM_1: GgwaveEnumValue;
  readonly GGWAVE_PROTOCOL_CUSTOM_2: GgwaveEnumValue;
  readonly GGWAVE_PROTOCOL_CUSTOM_3: GgwaveEnumValue;
  readonly GGWAVE_PROTOCOL_CUSTOM_4: GgwaveEnumValue;
  readonly GGWAVE_PROTOCOL_CUSTOM_5: GgwaveEnumValue;
  readonly GGWAVE_PROTOCOL_CUSTOM_6: GgwaveEnumValue;
  readonly GGWAVE_PROTOCOL_CUSTOM_7: GgwaveEnumValue;
  readonly GGWAVE_PROTOCOL_CUSTOM_8: GgwaveEnumValue;
  readonly GGWAVE_PROTOCOL_CUSTOM_9: GgwaveEnumValue;
};

export type GgwaveSampleFormat = {
  readonly GGWAVE_SAMPLE_FORMAT_UNDEFINED: GgwaveEnumValue;
  readonly GGWAVE_SAMPLE_FORMAT_U8: GgwaveEnumValue;
  readonly GGWAVE_SAMPLE_FORMAT_I8: GgwaveEnumValue;
  readonly GGWAVE_SAMPLE_FORMAT_U16: GgwaveEnumValue;
  readonly GGWAVE_SAMPLE_FORMAT_I16: GgwaveEnumValue;
  readonly GGWAVE_SAMPLE_FORMAT_F32: GgwaveEnumValue;
};

export type GgwaveParameters = {
  payloadLength: number;
  sampleRateInp: number;
  sampleRateOut: number;
  sampleRate: number;
  samplesPerFrame: number;
  soundMarkerThreshold: number;
  sampleFormatInp: GgwaveEnumValue;
  sampleFormatOut: GgwaveEnumValue;
  operatingMode: number;
};

/**
 * A typed array view into the wasm heap that aliases a static C++ buffer —
 * detached by the next wasm memory growth and overwritten by the next call.
 * Always copy (see the wrapper in `../spike/codec.ts`).
 */
export type GgwaveMemoryView = Int8Array;

export type GgwaveInstance = number;

export type GgwaveModule = {
  readonly ProtocolId: GgwaveProtocolId;
  readonly SampleFormat: GgwaveSampleFormat;
  readonly GGWAVE_OPERATING_MODE_RX: number;
  readonly GGWAVE_OPERATING_MODE_TX: number;
  readonly GGWAVE_OPERATING_MODE_RX_AND_TX: number;
  readonly GGWAVE_OPERATING_MODE_TX_ONLY_TONES: number;
  readonly GGWAVE_OPERATING_MODE_USE_DSS: number;
  getDefaultParameters(): GgwaveParameters;
  init(parameters: GgwaveParameters): GgwaveInstance;
  free(instance: GgwaveInstance): void;
  encode(
    instance: GgwaveInstance,
    payload: Uint8Array,
    protocolId: GgwaveEnumValue,
    volume: number,
  ): GgwaveMemoryView;
  decode(instance: GgwaveInstance, input: Uint8Array): GgwaveMemoryView;
  disableLog(): void;
  enableLog(): void;
  rxToggleProtocol(protocolId: GgwaveEnumValue, state: number): void;
  txToggleProtocol(protocolId: GgwaveEnumValue, state: number): void;
  rxDurationFrames(instance: GgwaveInstance): number;
};

export type GgwaveFactory = () => Promise<GgwaveModule>;

declare const ggwaveFactory: GgwaveFactory;
export default ggwaveFactory;
