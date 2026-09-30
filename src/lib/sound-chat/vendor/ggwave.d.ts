/**
 * Hand-written types for the vendored ggwave Emscripten artifact
 * (`./ggwave.js`). The upstream package ships no `.d.ts`, and the artifact is
 * a UMD/CJS bundle, so this file is the only type surface TypeScript sees for
 * the `./ggwave.js` specifier.
 *
 * Shapes here were verified by executing the artifact under Node 24, not read
 * off the upstream docs (see prompts/sound-chat/SOUND_CHAT_LOG.md).
 *
 * Execution is the *only* way to check this surface: none of these export names
 * appears anywhere as text in `ggwave.js`, because embind registers them from
 * inside the wasm binary. The running module exposes **36** exports; this file
 * declares **17** of them (2 enum objects, 5 operating-mode constants, 10
 * functions) and Sound Chat calls **10**. The rest are embind internals
 * (`HEAP*`, `__embind_*`, `dynCall_*`, the error classes), deliberately not
 * declared. A grep for a binding name
 * in the artifact therefore proves nothing — `provenance.test.ts` counts
 * dynamic-execution *sites*, and a new check should count `Object.keys(module)`.
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
 * Always copy (see the wrapper in `../codec.ts`).
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
  /** Kept with no caller on purpose: re-enabling a logger is never wanted here. */
  enableLog(): void;
  rxToggleProtocol(protocolId: GgwaveEnumValue, state: number): void;
  /**
   * Kept with no caller on purpose (master plan Section 10.1 class 9 requires the
   * line): the Tx-side twin of `rxToggleProtocol`, and nothing in Sound Chat
   * ever narrows the Tx protocols — the locked config is one Rx protocol and an
   * unmodified default Tx set.
   */
  txToggleProtocol(protocolId: GgwaveEnumValue, state: number): void;
  /**
   * Declared because the artifact really exports it, and *kept with no caller*
   * on purpose (master plan Section 10.1 class 9 requires the line): it is the
   * variable-length Rx window size, measured to be meaningless in fixed-length
   * mode, and Phase 0's measurement showed it returning 0. Sound Chat never
   * enables variable-length mode, so nothing may call this.
   */
  rxDurationFrames(instance: GgwaveInstance): number;
};

export type GgwaveFactory = () => Promise<GgwaveModule>;

declare const ggwaveFactory: GgwaveFactory;
export default ggwaveFactory;
