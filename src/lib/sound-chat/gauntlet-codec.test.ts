/**
 * Phase 4 gauntlet — CODEC FRAGILITY.
 *
 * Every measurement here runs against the **real** vendored ggwave module,
 * obtained through the repo's own loader (`load-ggwave.ts`), never a mock: the
 * questions in this category are exactly the ones a mock cannot answer ("what
 * does the wasm module do when it is handed an empty payload, a bad instance
 * id, a 65th byte?"). The wrapper is exercised the same way: through
 * `openSoundChatCodec()` where the shipped construction path is the thing under
 * test, and through the public `SoundChatCodec` constructor where a facade over
 * a real module is needed to count wasm calls or to force a heap growth.
 *
 * `codec.ts` labels half of its rules *policy* and half *measurement*, and the
 * comments cite the deep dive for both. This file separates the two: for every
 * rule it either re-measures the underlying wasm behaviour, or proves the
 * wrapper's guard makes the behaviour unreachable.
 */

import { afterAll, describe, expect, it } from "vitest";
import {
  bytesToFloat32,
  CODEC_PAYLOAD_LENGTH,
  CODEC_SAMPLE_RATE,
  CODEC_SAMPLES_PER_FRAME,
  CODEC_TX_VOLUME,
  CodecModuleError,
  CodecUsageError,
  float32ToBytes,
  flushReceiver,
  openSoundChatCodec,
  SoundChatCodec,
} from "./codec";
import { loadGgwaveModule } from "./load-ggwave";
import type { GgwaveMemoryView, GgwaveModule, GgwaveParameters } from "./vendor/ggwave";

/** The locked waveform length: 90 fixed-length frames of 1024 samples. */
const WAVEFORM_SAMPLES = 90 * CODEC_SAMPLES_PER_FRAME;
/** The byte length of that waveform — the C++ side always emits this much. */
const WAVEFORM_BYTES = WAVEFORM_SAMPLES * 4;
/** Frames in one block, for feeding the receiver. */
const WAVEFORM_FRAMES = WAVEFORM_SAMPLES / CODEC_SAMPLES_PER_FRAME;

const opened: SoundChatCodec[] = [];

afterAll(() => {
  for (const codec of opened) codec.close();
});

async function shippedCodec(): Promise<SoundChatCodec> {
  const codec = await openSoundChatCodec();
  opened.push(codec);
  return codec;
}

function lockedParameters(module: GgwaveModule, operatingMode: number): GgwaveParameters {
  const parameters = module.getDefaultParameters();
  parameters.payloadLength = CODEC_PAYLOAD_LENGTH;
  parameters.sampleRate = CODEC_SAMPLE_RATE;
  parameters.samplesPerFrame = CODEC_SAMPLES_PER_FRAME;
  parameters.operatingMode = operatingMode;
  return parameters;
}

function wirePayload(): Uint8Array {
  const payload = new Uint8Array(CODEC_PAYLOAD_LENGTH);
  payload[0] = 1;
  for (let i = 1; i < payload.length; i += 1) payload[i] = (i * 11) % 256;
  return payload;
}

function frameOfSilence(): Float32Array {
  return new Float32Array(CODEC_SAMPLES_PER_FRAME);
}

/**
 * Content digest, so "is this still the block I was given?" is decidable.
 *
 * A raw `GgwaveMemoryView` is accepted deliberately, and digested *in place*:
 * that view aliases a static C++ buffer inside wasm, and the aliasing is the
 * very thing under test ("the next call overwrites the one you were handed").
 * Copying it here — `Uint8Array.from(view)` or a fresh view over the same
 * bytes — would snapshot the content and hide the overwrite, so the fix is to
 * widen this parameter rather than to convert at the call site.
 */
function digest(bytes: Uint8Array | Float32Array | GgwaveMemoryView): number {
  const view = bytes instanceof Float32Array ? new Uint8Array(bytes.buffer) : bytes;
  let hash = 0;
  // Iterated, not indexed: a digest has no reason to care about an element's
  // offset, and `noUncheckedIndexedAccess` would demand a `?? 0` per byte that
  // could only ever be a lie.
  for (const byte of view) hash = (hash * 31 + byte) | 0;
  return hash;
}

/** What a value was, as one loggable line. */
function show(value: unknown): string {
  if (value instanceof Error) return `${value.name}: ${value.message.slice(0, 90)}`;
  return `${Object.prototype.toString.call(value)} ${String(value)}`;
}

/** Runs a call and reduces it to a line, so a trap is data, not a test failure. */
function attempt<T>(work: () => T): string {
  try {
    const value = work();
    if (Array.isArray(value)) return `ok:${value.join(",")}`;
    // The binding hands back views, not scalars; only the length is meaningful.
    if (ArrayBuffer.isView(value)) return `ok:${value.byteLength}`;
    return `ok:${String(value)}`;
  } catch (error) {
    return `threw:${show(error)}`;
  }
}

function caughtCause(error: unknown): unknown {
  return error instanceof Error ? error.cause : undefined;
}

/** A real module behind a counting facade. */
type Facade = {
  readonly codec: SoundChatCodec;
  readonly calls: {
    readonly init: number;
    readonly encode: number;
    readonly decode: number;
    readonly free: number;
  };
  /** The last view wasm returned, still aliasing its static C++ buffer. */
  readonly lastEncodeView: () => GgwaveMemoryView | undefined;
  /** The same for the Rx direction, whose result the wrapper must also copy. */
  readonly lastDecodeView: () => GgwaveMemoryView | undefined;
  /** Every instance id the wrapper has actually handed to wasm. */
  readonly encodeIds: readonly number[];
  readonly decodeIds: readonly number[];
  /**
   * Grows the wasm heap, which detaches every outstanding view. Measured: one
   * `encode()` with an unrelated protocol at a loud volume grows the heap from
   * 16 MiB to 20 MiB on its own, so it needs no spare instance slot.
   */
  readonly growHeap: () => void;
};

/**
 * The facade answers three questions a plain module cannot: *did the wrapper
 * call wasm at all* (call counts and the ids it used), and *what did the view the
 * wrapper was handed look like* (the raw view is captured before the wrapper's
 * copy discards it). The module behind it is the real artifact, loaded through
 * the shipped loader.
 */
async function facadedCodec(): Promise<Facade> {
  const raw = await loadGgwaveModule();
  raw.disableLog();
  const protocol = raw.ProtocolId.GGWAVE_PROTOCOL_AUDIBLE_FASTEST;
  const calls = { init: 0, encode: 0, decode: 0, free: 0 };
  const encodeIds: number[] = [];
  const decodeIds: number[] = [];
  let lastEncodeView: GgwaveMemoryView | undefined;
  let lastDecodeView: GgwaveMemoryView | undefined;

  const facade: GgwaveModule = {
    ProtocolId: raw.ProtocolId,
    SampleFormat: raw.SampleFormat,
    GGWAVE_OPERATING_MODE_RX: raw.GGWAVE_OPERATING_MODE_RX,
    GGWAVE_OPERATING_MODE_TX: raw.GGWAVE_OPERATING_MODE_TX,
    GGWAVE_OPERATING_MODE_RX_AND_TX: raw.GGWAVE_OPERATING_MODE_RX_AND_TX,
    GGWAVE_OPERATING_MODE_TX_ONLY_TONES: raw.GGWAVE_OPERATING_MODE_TX_ONLY_TONES,
    GGWAVE_OPERATING_MODE_USE_DSS: raw.GGWAVE_OPERATING_MODE_USE_DSS,
    getDefaultParameters: () => raw.getDefaultParameters(),
    init: (parameters) => {
      calls.init += 1;
      return raw.init(parameters);
    },
    free: (instance) => {
      calls.free += 1;
      raw.free(instance);
    },
    encode: (instance, payload, protocolId, volume) => {
      calls.encode += 1;
      encodeIds.push(instance);
      const view = raw.encode(instance, payload, protocolId, volume);
      lastEncodeView = view;
      return view;
    },
    decode: (instance, input) => {
      calls.decode += 1;
      decodeIds.push(instance);
      const view = raw.decode(instance, input);
      lastDecodeView = view;
      return view;
    },
    disableLog: () => raw.disableLog(),
    enableLog: () => raw.enableLog(),
    rxToggleProtocol: (protocolId, state) => raw.rxToggleProtocol(protocolId, state),
    txToggleProtocol: (protocolId, state) => raw.txToggleProtocol(protocolId, state),
    rxDurationFrames: (instance) => raw.rxDurationFrames(instance),
  };

  const tx = facade.init(lockedParameters(raw, raw.GGWAVE_OPERATING_MODE_TX));
  const rx = facade.init(lockedParameters(raw, raw.GGWAVE_OPERATING_MODE_RX));
  expect(tx).toBeGreaterThanOrEqual(0);
  expect(rx).toBeGreaterThanOrEqual(0);

  return {
    codec: new SoundChatCodec(facade, protocol, tx, rx),
    calls,
    lastEncodeView: () => lastEncodeView,
    lastDecodeView: () => lastDecodeView,
    encodeIds,
    decodeIds,
    growHeap: () => {
      raw.encode(
        tx,
        new Uint8Array(CODEC_PAYLOAD_LENGTH),
        raw.ProtocolId.GGWAVE_PROTOCOL_DT_NORMAL,
        50,
      );
    },
  };
}

/** Feeds a waveform one whole frame at a time, as the capture pipeline does. */
function feedFrames(
  codec: SoundChatCodec,
  waveform: Float32Array,
  visit: (decoded: Uint8Array, frame: number) => void,
): void {
  for (let frame = 0; frame * CODEC_SAMPLES_PER_FRAME < waveform.length; frame += 1) {
    const chunk = waveform.subarray(
      frame * CODEC_SAMPLES_PER_FRAME,
      (frame + 1) * CODEC_SAMPLES_PER_FRAME,
    );
    const decoded = codec.decode(chunk);
    if (decoded !== null) visit(decoded, frame + 1);
  }
}

// ---------------------------------------------------------------------------
// 1. What the wasm module does when misused (real module, no wrapper)
// ---------------------------------------------------------------------------

describe("raw module: the instance pool", () => {
  it("holds four instances and reports a full pool as -1", async () => {
    const module = await loadGgwaveModule();
    module.disableLog();
    const ids: number[] = [];
    for (let i = 0; i < 6; i += 1) {
      ids.push(module.init(lockedParameters(module, module.GGWAVE_OPERATING_MODE_TX)));
    }
    console.log(`[gauntlet] six init() calls: ${ids.join(",")}`);
    expect(ids.slice(0, 4)).toEqual([0, 1, 2, 3]);
    expect(ids.slice(4)).toEqual([-1, -1]);
  });

  it("reuses a freed id, so a stale id can name a *different* instance later", async () => {
    const module = await loadGgwaveModule();
    module.disableLog();
    const first = module.init(lockedParameters(module, module.GGWAVE_OPERATING_MODE_TX));
    module.free(first);
    const second = module.init(lockedParameters(module, module.GGWAVE_OPERATING_MODE_TX));
    console.log(`[gauntlet] free(${first}) then init() -> ${second}`);
    expect(second).toBe(first);
  });
});

describe("raw module: the empty-payload trap", () => {
  it("traps with a wasm RuntimeError and the module keeps encoding and decoding", async () => {
    const module = await loadGgwaveModule();
    module.disableLog();
    const tx = module.init(lockedParameters(module, module.GGWAVE_OPERATING_MODE_TX));

    const trapped = attempt(() =>
      module.encode(tx, new Uint8Array(0), module.ProtocolId.GGWAVE_PROTOCOL_AUDIBLE_FASTEST, 25),
    );
    console.log(`[gauntlet] raw encode(tx, empty) -> ${trapped}`);
    expect(trapped).toContain("threw:RuntimeError");

    // The claim `codec.ts:12-14` leans on, measured: the module survives.
    const after = attempt(() =>
      module.encode(
        tx,
        new Uint8Array(CODEC_PAYLOAD_LENGTH),
        module.ProtocolId.GGWAVE_PROTOCOL_AUDIBLE_FASTEST,
        25,
      ),
    );
    console.log(`[gauntlet] raw encode after the trap -> ${after}`);
    expect(after).toBe(`ok:${WAVEFORM_BYTES}`);

    // A full round trip on the same module afterwards: the trap is a
    // divide-by-zero, not a corrupted heap.
    const rx = module.init(lockedParameters(module, module.GGWAVE_OPERATING_MODE_RX));
    const payload = wirePayload();
    const waveform = Uint8Array.from(
      module.encode(tx, payload, module.ProtocolId.GGWAVE_PROTOCOL_AUDIBLE_FASTEST, 25),
    );
    const hits: number[] = [];
    for (let frame = 0; frame < WAVEFORM_FRAMES; frame += 1) {
      const bytes = waveform.subarray(
        frame * CODEC_SAMPLES_PER_FRAME * 4,
        (frame + 1) * CODEC_SAMPLES_PER_FRAME * 4,
      );
      if (module.decode(rx, bytes).length > 0) hits.push(frame + 1);
    }
    console.log(`[gauntlet] decodes after the trap, in frames: ${hits.join(",")}`);
    expect(hits).toEqual([89, 90]);
  });
});

describe("raw module: invalid instance ids", () => {
  it("encode(-1) aborts with a numeric reason, not an Error, and the module lives on", async () => {
    const module = await loadGgwaveModule();
    module.disableLog();
    const tx = module.init(lockedParameters(module, module.GGWAVE_OPERATING_MODE_TX));

    let reason: unknown = "nothing thrown";
    try {
      module.encode(-1, new Uint8Array(64), module.ProtocolId.GGWAVE_PROTOCOL_AUDIBLE_FASTEST, 25);
    } catch (error) {
      reason = error;
    }
    console.log(`[gauntlet] encode(-1) threw ${show(reason)}; isError=${reason instanceof Error}`);
    // The abort reason is a bare number, and its value varies with the call
    // site (79184 from a virgin module, 1730328 from the wrapper's path), so
    // nothing may parse it — only note that it is not an `Error`.
    expect(reason).not.toBeInstanceOf(Error);
    expect(Number.isInteger(reason)).toBe(true);

    const after = attempt(() =>
      module.encode(tx, new Uint8Array(64), module.ProtocolId.GGWAVE_PROTOCOL_AUDIBLE_FASTEST, 25),
    );
    console.log(`[gauntlet] live instance after the abort -> ${after}`);
    expect(after).toBe(`ok:${WAVEFORM_BYTES}`);
  });

  it("refutes the 'decode on a bad id aborts' half of the claim: it is a silent no-op", async () => {
    const module = await loadGgwaveModule();
    module.disableLog();
    const virgin = attempt(() => module.decode(-1, new Uint8Array(4096)));
    console.log(`[gauntlet] decode(-1) on a virgin module -> ${virgin}`);
    expect(virgin).toBe("ok:0");

    // The same for a *freed* id: the module has no idea the instance is gone.
    const rx = module.init(lockedParameters(module, module.GGWAVE_OPERATING_MODE_RX));
    module.free(rx);
    expect(attempt(() => module.decode(rx, new Uint8Array(4096)))).toBe("ok:0");

    // ...while `encode` on that same freed id does abort.
    const tx = module.init(lockedParameters(module, module.GGWAVE_OPERATING_MODE_TX));
    module.free(tx);
    const freed = attempt(() =>
      module.encode(tx, new Uint8Array(64), module.ProtocolId.GGWAVE_PROTOCOL_AUDIBLE_FASTEST, 25),
    );
    console.log(`[gauntlet] encode on a freed id -> ${freed}`);
    expect(freed).toContain("threw:");
  });
});

describe("raw module: free() is total", () => {
  it("never throws for a double free, for -1, or for an id that never existed", async () => {
    const module = await loadGgwaveModule();
    module.disableLog();
    const tx = module.init(lockedParameters(module, module.GGWAVE_OPERATING_MODE_TX));
    console.log(
      `[gauntlet] free x2=${attempt(() => module.free(tx))} free(-1)=${attempt(() => module.free(-1))} free(99)=${attempt(() => module.free(99))}`,
    );
    expect(attempt(() => module.free(tx))).toBe("ok:undefined");
    expect(attempt(() => module.free(tx))).toBe("ok:undefined");
    expect(attempt(() => module.free(-1))).toBe("ok:undefined");
    expect(attempt(() => module.free(99))).toBe("ok:undefined");
  });
});

describe("raw module: binding-level input checks", () => {
  it("rejects a wrongly typed payload with an embind BindingError, not a trap", async () => {
    const module = await loadGgwaveModule();
    module.disableLog();
    const tx = module.init(lockedParameters(module, module.GGWAVE_OPERATING_MODE_TX));
    // Safety: the casts are the probe. The binding is declared to take a
    // `Uint8Array`; handing it something else is the case under test.
    const asFloat = attempt(() =>
      module.encode(
        tx,
        new Float32Array(16) as unknown as Uint8Array,
        module.ProtocolId.GGWAVE_PROTOCOL_AUDIBLE_FASTEST,
        25,
      ),
    );
    console.log(`[gauntlet] encode(Float32Array payload) -> ${asFloat}`);
    expect(asFloat).toContain("threw:BindingError");

    const rx = module.init(lockedParameters(module, module.GGWAVE_OPERATING_MODE_RX));
    const asFloatInput = attempt(() =>
      module.decode(rx, new Float32Array(1024) as unknown as Uint8Array),
    );
    expect(asFloatInput).toContain("threw:BindingError");

    // The module is healthy after both binding rejections.
    expect(attempt(() => module.decode(rx, new Uint8Array(4096)))).toBe("ok:0");
    expect(
      attempt(() =>
        module.encode(
          tx,
          new Uint8Array(64),
          module.ProtocolId.GGWAVE_PROTOCOL_AUDIBLE_FASTEST,
          25,
        ),
      ),
    ).toBe(`ok:${WAVEFORM_BYTES}`);
  });

  it("accepts 65 and 128 bytes silently and still emits exactly one block", async () => {
    const module = await loadGgwaveModule();
    module.disableLog();
    const tx = module.init(lockedParameters(module, module.GGWAVE_OPERATING_MODE_TX));
    const long = attempt(() =>
      module.encode(tx, new Uint8Array(128), module.ProtocolId.GGWAVE_PROTOCOL_AUDIBLE_FASTEST, 25),
    );
    console.log(`[gauntlet] raw encode with a 128-byte payload -> ${long}`);
    expect(long).toBe(`ok:${WAVEFORM_BYTES}`);
  });

  it("aborts at volume 255 and still emits a block at volume 0", async () => {
    const module = await loadGgwaveModule();
    module.disableLog();
    const tx = module.init(lockedParameters(module, module.GGWAVE_OPERATING_MODE_TX));
    const loud = attempt(() =>
      module.encode(tx, new Uint8Array(64), module.ProtocolId.GGWAVE_PROTOCOL_AUDIBLE_FASTEST, 255),
    );
    const silent = attempt(() =>
      module.encode(tx, new Uint8Array(64), module.ProtocolId.GGWAVE_PROTOCOL_AUDIBLE_FASTEST, 0),
    );
    console.log(
      `[gauntlet] volume 255 -> ${loud}; volume 0 -> ${silent}; ours is ${CODEC_TX_VOLUME}`,
    );
    expect(loud).toContain("threw:");
    expect(silent).toBe(`ok:${WAVEFORM_BYTES}`);
    expect(CODEC_TX_VOLUME).toBe(25);
  });

  it("refuses to encode on an Rx instance (RangeError) without harming its state", async () => {
    const module = await loadGgwaveModule();
    module.disableLog();
    const tx = module.init(lockedParameters(module, module.GGWAVE_OPERATING_MODE_TX));
    const rx = module.init(lockedParameters(module, module.GGWAVE_OPERATING_MODE_RX));
    const payload = wirePayload();
    const waveform = Uint8Array.from(
      module.encode(tx, payload, module.ProtocolId.GGWAVE_PROTOCOL_AUDIBLE_FASTEST, 25),
    );

    const wrongMode = attempt(() =>
      module.encode(rx, payload, module.ProtocolId.GGWAVE_PROTOCOL_AUDIBLE_FASTEST, 25),
    );
    console.log(`[gauntlet] encode on the Rx instance -> ${wrongMode}`);
    expect(wrongMode).toContain("threw:RangeError");

    const hits: number[] = [];
    for (let frame = 0; frame < WAVEFORM_FRAMES; frame += 1) {
      const bytes = waveform.subarray(
        frame * CODEC_SAMPLES_PER_FRAME * 4,
        (frame + 1) * CODEC_SAMPLES_PER_FRAME * 4,
      );
      if (module.decode(rx, bytes).length > 0) hits.push(frame + 1);
    }
    console.log(`[gauntlet] decodes after encode-on-Rx: frames ${hits.join(",")}`);
    expect(hits).toEqual([89, 90]);
  });

  it("treats decode on a Tx instance as a silent no-op", async () => {
    const module = await loadGgwaveModule();
    module.disableLog();
    const tx = module.init(lockedParameters(module, module.GGWAVE_OPERATING_MODE_TX));
    const waveform = Uint8Array.from(
      module.encode(tx, new Uint8Array(64), module.ProtocolId.GGWAVE_PROTOCOL_AUDIBLE_FASTEST, 25),
    );
    expect(attempt(() => module.decode(tx, waveform.subarray(0, 4096)))).toBe("ok:0");
    expect(
      attempt(() =>
        module.encode(
          tx,
          new Uint8Array(64),
          module.ProtocolId.GGWAVE_PROTOCOL_AUDIBLE_FASTEST,
          25,
        ),
      ),
    ).toBe(`ok:${WAVEFORM_BYTES}`);
  });

  it("treats a zero-length and a one-byte decode input as a no-op", async () => {
    const module = await loadGgwaveModule();
    module.disableLog();
    const rx = module.init(lockedParameters(module, module.GGWAVE_OPERATING_MODE_RX));
    expect(attempt(() => module.decode(rx, new Uint8Array(0)))).toBe("ok:0");
    expect(attempt(() => module.decode(rx, new Uint8Array(1)))).toBe("ok:0");
    expect(attempt(() => module.decode(rx, new Uint8Array(4096)))).toBe("ok:0");
  });
});

describe("raw module: the returned view is not yours", () => {
  it("is overwritten by the very next call on the same instance", async () => {
    const module = await loadGgwaveModule();
    module.disableLog();
    const tx = module.init(lockedParameters(module, module.GGWAVE_OPERATING_MODE_TX));
    const first = module.encode(
      tx,
      new Uint8Array(CODEC_PAYLOAD_LENGTH).fill(0x11),
      module.ProtocolId.GGWAVE_PROTOCOL_AUDIBLE_FASTEST,
      25,
    );
    const snapshot = digest(first);
    const second = module.encode(
      tx,
      new Uint8Array(CODEC_PAYLOAD_LENGTH).fill(0x22),
      module.ProtocolId.GGWAVE_PROTOCOL_AUDIBLE_FASTEST,
      25,
    );
    console.log(
      `[gauntlet] same buffer=${first.buffer === second.buffer} same offset=${first.byteOffset === second.byteOffset} content changed by the next encode=${digest(first) !== snapshot}`,
    );
    expect(first.buffer).toBe(second.buffer);
    expect(digest(first)).not.toBe(snapshot);
  });

  it("is silently detached by a heap growth, and copying it afterwards throws", async () => {
    const module = await loadGgwaveModule();
    module.disableLog();
    const tx = module.init(lockedParameters(module, module.GGWAVE_OPERATING_MODE_TX));
    const held = module.encode(
      tx,
      wirePayload(),
      module.ProtocolId.GGWAVE_PROTOCOL_AUDIBLE_FASTEST,
      25,
    );
    const before = held.buffer.byteLength;
    module.encode(tx, new Uint8Array(64), module.ProtocolId.GGWAVE_PROTOCOL_DT_NORMAL, 50);
    // The heap size has to be read from a *fresh* view: the held one is already
    // detached, which is the whole point of this test.
    const after = module.encode(
      tx,
      wirePayload(),
      module.ProtocolId.GGWAVE_PROTOCOL_AUDIBLE_FASTEST,
      25,
    ).buffer.byteLength;
    console.log(
      `[gauntlet] heap ${before} -> ${after}; held.length=${held.length}; late copy=${attempt(() => Uint8Array.from(held).length)}`,
    );
    expect(before).toBe(16_777_216);
    expect(after).toBeGreaterThan(before);
    expect(held.length).toBe(0);
    expect(held.buffer.byteLength).toBe(0);
    // Not a silent empty copy: the late copy throws, which inside `#guard()`
    // would be reported as a module death.
    expect(attempt(() => Uint8Array.from(held))).toContain("threw:TypeError");
  });
});

// ---------------------------------------------------------------------------
// 2. The suspected slot leak in openSoundChatCodec
// ---------------------------------------------------------------------------

describe("openSoundChatCodec: a half-satisfied allocation leaks an instance", () => {
  it("leaks exactly one slot when the second init() fails (mirror of codec.ts:263-275)", async () => {
    const module = await loadGgwaveModule();
    module.disableLog();

    // Three of the four slots are already taken, leaving room for exactly one.
    const fillerA = module.init(lockedParameters(module, module.GGWAVE_OPERATING_MODE_TX));
    const fillerB = module.init(lockedParameters(module, module.GGWAVE_OPERATING_MODE_TX));
    const fillerC = module.init(lockedParameters(module, module.GGWAVE_OPERATING_MODE_TX));
    console.log(`[gauntlet] pre-filled slots: ${fillerA},${fillerB},${fillerC}`);

    // ---- the allocation block of openSoundChatCodec, verbatim (codec.ts:263-275)
    const tx = module.init(lockedParameters(module, module.GGWAVE_OPERATING_MODE_TX));
    const rx = module.init(lockedParameters(module, module.GGWAVE_OPERATING_MODE_RX));
    // ---- end of the mirrored block
    expect({ tx, rx }).toEqual({ tx: 3, rx: -1 });
    // `tx >= 0` and `rx < 0` throws `CodecModuleError` here, freeing neither.

    // Proof of the leak: after releasing the three fillers, exactly ONE slot is
    // available again — the one the failed call took and never gave back.
    module.free(fillerA);
    module.free(fillerB);
    module.free(fillerC);
    const recovered = [
      module.init(lockedParameters(module, module.GGWAVE_OPERATING_MODE_TX)),
      module.init(lockedParameters(module, module.GGWAVE_OPERATING_MODE_TX)),
      module.init(lockedParameters(module, module.GGWAVE_OPERATING_MODE_TX)),
      module.init(lockedParameters(module, module.GGWAVE_OPERATING_MODE_TX)),
    ];
    console.log(`[gauntlet] slots left after releasing the fillers: ${recovered.join(",")}`);
    expect(recovered.slice(0, 3).every((id) => id >= 0)).toBe(true);
    expect(recovered[3]).toBe(-1);
  });

  it("is unreachable in production: every loadGgwaveModule() hands out a fresh 4-slot pool", async () => {
    // `load-ggwave.ts:80` calls the factory per invocation, so N codecs need N
    // pools; a shared pool would refuse the third pair of instances.
    const codecs = await Promise.all([shippedCodec(), shippedCodec(), shippedCodec()]);
    for (const codec of codecs) {
      expect(codec.state).toBe("ready");
      expect(codec.encode(wirePayload()).length).toBe(WAVEFORM_SAMPLES);
    }
    // A codec that is never closed does not starve the next one either.
    const abandoned = await shippedCodec();
    expect(abandoned.encode(wirePayload()).length).toBe(WAVEFORM_SAMPLES);
    expect((await shippedCodec()).state).toBe("ready");
  });
});

// ---------------------------------------------------------------------------
// 3. The wrapper: guards, latch, close
// ---------------------------------------------------------------------------

describe("wrapper: misuse guards never reach wasm", () => {
  it("refuses an empty payload without a single wasm call", async () => {
    const { codec, calls } = await facadedCodec();
    expect(() => codec.encode(new Uint8Array(0))).toThrow(CodecUsageError);
    expect(() => codec.encode(new Uint8Array(0).subarray(0, 0))).toThrow(CodecUsageError);
    console.log(`[gauntlet] wasm encode calls after two empty payloads: ${calls.encode}`);
    expect(calls.encode).toBe(0);
    expect(codec.state).toBe("ready");
    expect(codec.encode(wirePayload()).length).toBe(WAVEFORM_SAMPLES);
  });

  it("refuses an over-length payload without a wasm call, at 65 and at 4096", async () => {
    const { codec, calls } = await facadedCodec();
    for (const length of [65, 1024, 4096]) {
      expect(() => codec.encode(new Uint8Array(length)), `payload ${length}`).toThrow(
        CodecUsageError,
      );
    }
    expect(calls.encode).toBe(0);
    expect(codec.state).toBe("ready");
  });

  it("refuses a partial frame without a wasm call, and keeps whole multiples legal", async () => {
    const { codec, calls } = await facadedCodec();
    for (const length of [1, 2, 1023, 1025, 3071]) {
      expect(() => codec.decode(new Float32Array(length)), `chunk ${length}`).toThrow(
        CodecUsageError,
      );
    }
    expect(calls.decode).toBe(0);
    expect(codec.state).toBe("ready");
    for (const frames of [1, 2, 3]) {
      expect(codec.decode(new Float32Array(CODEC_SAMPLES_PER_FRAME * frames))).toBeNull();
    }
    expect(calls.decode).toBe(3);
  });

  it("returns null for a zero-length chunk without a wasm call", async () => {
    const { codec, calls } = await facadedCodec();
    expect(codec.decode(new Float32Array(0))).toBeNull();
    expect(calls.decode).toBe(0);
    expect(codec.state).toBe("ready");
  });

  it("encodes every legal payload length and never mutates the caller's bytes", async () => {
    const codec = await shippedCodec();
    for (const length of [1, 2, 31, 63, CODEC_PAYLOAD_LENGTH]) {
      const payload = wirePayload().subarray(0, length);
      const before = digest(payload);
      expect(codec.encode(payload).length, `payload ${length}`).toBe(WAVEFORM_SAMPLES);
      expect(digest(payload)).toBe(before);
    }
  });

  it("hands back a compact, non-wasm-backed buffer", async () => {
    const { codec, lastEncodeView } = await facadedCodec();
    const samples = codec.encode(wirePayload());
    const raw = lastEncodeView();
    console.log(
      `[gauntlet] copy buffer=${samples.buffer.byteLength} raw buffer=${raw?.buffer.byteLength} same=${samples.buffer === raw?.buffer}`,
    );
    expect(raw).toBeDefined();
    expect(samples.byteOffset).toBe(0);
    expect(samples.buffer.byteLength).toBe(WAVEFORM_BYTES);
    expect(samples.buffer).not.toBe(raw?.buffer);
  });

  it("only ever hands wasm an instance id the module actually owns", async () => {
    const { codec, encodeIds, decodeIds } = await facadedCodec();
    // Every refusal first, then one legal call of each kind: the ids recorded
    // are the complete set the wrapper can produce.
    expect(() => codec.encode(new Uint8Array(0))).toThrow(CodecUsageError);
    expect(() => codec.encode(new Uint8Array(65))).toThrow(CodecUsageError);
    expect(() => codec.decode(new Float32Array(1023))).toThrow(CodecUsageError);
    codec.encode(wirePayload());
    codec.decode(frameOfSilence());
    console.log(
      `[gauntlet] ids handed to wasm: encode ${encodeIds.join(",")} decode ${decodeIds.join(",")}`,
    );
    // tx was initialised first, so it is id 0 and rx is id 1: two distinct
    // instances, both valid, and the refusals contributed neither.
    expect(encodeIds).toEqual([0]);
    expect(decodeIds).toEqual([1]);
  });

  it("copies the decode result too: later audio cannot rewrite a delivered block", async () => {
    const { codec, lastDecodeView } = await facadedCodec();
    const samples = codec.encode(wirePayload());
    let block: Uint8Array | undefined;
    feedFrames(codec, samples, (first) => {
      block ??= first;
    });
    if (block === undefined) throw new Error("the facade receiver never decoded the block");
    const raw = lastDecodeView();
    const before = digest(block);
    // 30 more frames through the same static output buffer.
    for (let i = 0; i < 10; i += 1) codec.decode(new Float32Array(CODEC_SAMPLES_PER_FRAME * 3));
    console.log(
      `[gauntlet] decode copy: block=${block.length}B raw=${raw?.byteLength}B ` +
        `same buffer=${block.buffer === raw?.buffer} unchanged=${digest(block) === before}`,
    );
    expect(block.length).toBe(CODEC_PAYLOAD_LENGTH);
    expect(digest(block)).toBe(before);
    expect(block.buffer).not.toBe(raw?.buffer);
  });
});

describe("wrapper: a heap growth cannot reach the caller through encode()", () => {
  it("keeps the returned copy intact while the raw view it came from detaches", async () => {
    const { codec, growHeap, lastEncodeView } = await facadedCodec();
    const samples = codec.encode(wirePayload());
    const before = digest(samples);
    const raw = lastEncodeView();
    expect(raw?.length).toBe(WAVEFORM_BYTES);

    growHeap();
    console.log(
      `[gauntlet] after growth: raw.length=${raw?.length} raw.buffer=${raw?.buffer.byteLength} copy.length=${samples.length} copy unchanged=${digest(samples) === before}`,
    );
    expect(raw?.length).toBe(0);
    expect(raw?.buffer.byteLength).toBe(0);
    expect(samples.length).toBe(WAVEFORM_SAMPLES);
    expect(digest(samples)).toBe(before);
    // The module is unharmed by the growth it caused.
    expect(codec.encode(wirePayload()).length).toBe(WAVEFORM_SAMPLES);
    expect(codec.state).toBe("ready");
  });
});

describe("wrapper: detached and unaligned inputs", () => {
  it("treats a detached chunk as empty rather than as a module death", async () => {
    const codec = await shippedCodec();
    const buffer = new ArrayBuffer(CODEC_SAMPLES_PER_FRAME * 4);
    const chunk = new Float32Array(buffer);
    structuredClone(buffer, { transfer: [buffer] });
    expect(chunk.length).toBe(0);
    expect(codec.decode(chunk)).toBeNull();
    expect(codec.state).toBe("ready");
  });

  it("leaves the detached-view TypeErrors to the two byte helpers, unreachable from the codec", () => {
    const buffer = new ArrayBuffer(64);
    const detachedBytes = new Uint8Array(buffer);
    structuredClone(buffer, { transfer: [buffer] });
    // Both guards pass (length 0, offset 0), so the raw constructor is what
    // refuses — a bare TypeError, not a CodecUsageError.
    const toSamples = attempt(() => bytesToFloat32(detachedBytes).length);
    console.log(`[gauntlet] bytesToFloat32(detached) -> ${toSamples}`);
    expect(toSamples).toContain("threw:TypeError");

    const sampleBuffer = new ArrayBuffer(64);
    const detachedSamples = new Float32Array(sampleBuffer);
    structuredClone(sampleBuffer, { transfer: [sampleBuffer] });
    expect(attempt(() => float32ToBytes(detachedSamples))).toContain("threw:TypeError");
  });

  it("rejects an unaligned byte view as misuse and accepts a 4-aligned one", () => {
    const backing = new Uint8Array(68);
    expect(bytesToFloat32(backing.subarray(4, 20)).length).toBe(4);
    expect(() => bytesToFloat32(backing.subarray(1, 17))).toThrow(CodecUsageError);
    expect(() => bytesToFloat32(new Uint8Array(18))).toThrow(CodecUsageError);
    // A Float32Array's own byteOffset is always 4-aligned, so the encoding
    // direction can never receive an unaligned view from a caller.
    const slice = new Float32Array([1, 2, 3, 4, 5, 6]).subarray(1, 5);
    expect(float32ToBytes(slice).byteOffset % 4).toBe(0);
  });

  it("decodes from a chunk that starts at a non-zero byte offset", async () => {
    const codec = await shippedCodec();
    flushReceiver(codec);
    const waveform = codec.encode(wirePayload());
    const padded = new Float32Array(waveform.length + 8);
    padded.set(waveform, 2);
    const frames: number[] = [];
    feedFrames(codec, padded.subarray(2, 2 + WAVEFORM_SAMPLES), (_decoded, frame) =>
      frames.push(frame),
    );
    console.log(`[gauntlet] samples offset by two: decodes in frames ${frames.join(",")}`);
    expect(frames.length).toBeGreaterThan(0);
  });
});

describe("wrapper: close()", () => {
  it("frees both instances once and is a no-op on every later call", async () => {
    const { codec, calls } = await facadedCodec();
    expect(calls.free).toBe(0);
    codec.close();
    expect(calls.free).toBe(2);
    expect(codec.state).toBe("closed");
    expect(() => codec.close()).not.toThrow();
    expect(() => codec.close()).not.toThrow();
    console.log(`[gauntlet] free() calls after three close() calls: ${calls.free}`);
    expect(calls.free).toBe(2);
  });

  it("refuses encode and decode afterwards as a usage error, leaving the state closed", async () => {
    const { codec, calls } = await facadedCodec();
    codec.close();
    const before = { ...calls };
    expect(() => codec.encode(wirePayload())).toThrow(CodecUsageError);
    expect(() => codec.decode(frameOfSilence())).toThrow(CodecUsageError);
    // Even the misuse guards stay usage errors once closed: no wasm, no latch.
    expect(() => codec.encode(new Uint8Array(0))).toThrow(CodecUsageError);
    expect(() => codec.decode(new Float32Array(1023))).toThrow(CodecUsageError);
    expect(codec.state).toBe("closed");
    expect(calls).toEqual(before);
  });
});

describe("wrapper: the dead latch", () => {
  it("FIXED — a wrong payload TYPE is a usage error, not a module death", async () => {
    const codec = await shippedCodec();
    // Safety: this cast is the probe. The wrapper's guards cover length and
    // alignment; this is the type hole Phase 4 measured, which used to reach
    // embind and latch a perfectly healthy module dead.
    const wrongType = new Float32Array(8) as unknown as Uint8Array;
    let caught: unknown = "nothing thrown";
    try {
      codec.encode(wrongType);
    } catch (error) {
      caught = error;
    }
    console.log(
      `[gauntlet] encode(wrong type) -> ${show(caught)} / cause ${show(caughtCause(caught))}`,
    );
    // A caller's mistake, reported as the caller's mistake...
    expect(caught).toBeInstanceOf(CodecUsageError);
    expect(caught).not.toBeInstanceOf(CodecModuleError);
    // ...and, critically, the module is still usable. This is master plan
    // Section 10.1 class 10: a misuse guard must never latch the module.
    expect(codec.state).toBe("ready");

    // The next legitimate call succeeds, on the very same instance.
    const next = codec.encode(wirePayload());
    expect(next.length).toBe(WAVEFORM_SAMPLES);
    expect(codec.decode(frameOfSilence())).toBeNull();
    expect(codec.state).toBe("ready");
  });

  it("still frees both instances when a genuinely dead codec is closed", async () => {
    // A *genuine* module failure, produced the way one really looks: an invalid
    // instance id reaching wasm, which hard-aborts. The wrong-type probe above
    // can no longer do this, because that guard now refuses it first — which is
    // the point of the fix, and why this test had to be re-founded on a real
    // trap rather than on the removed hole.
    const raw = await loadGgwaveModule();
    raw.disableLog();
    const protocol = raw.ProtocolId.GGWAVE_PROTOCOL_AUDIBLE_FASTEST;
    const freed: number[] = [];
    const probe = new SoundChatCodec(
      { ...raw, free: (id: number) => freed.push(id) },
      protocol,
      raw.init(lockedParameters(raw, raw.GGWAVE_OPERATING_MODE_TX)),
      raw.init(lockedParameters(raw, raw.GGWAVE_OPERATING_MODE_RX)),
    );
    // The bad id is the probe; Safety: SoundChatCodec's constructor is public, so
    // an invalid id is constructible without going through `openSoundChatCodec`.
    // It is given the *counting* module so `close()`'s frees are observable.
    const doomed = new SoundChatCodec(
      { ...raw, free: (id: number) => freed.push(id) },
      protocol,
      -1,
      0,
    );
    expect(() => doomed.encode(wirePayload())).toThrow(CodecModuleError);
    expect(doomed.state).toBe("dead");
    doomed.close();
    console.log(
      `[gauntlet] free() calls after closing a dead codec: ${freed.length}, state=${doomed.state}`,
    );
    // Freeing a trapped instance is best-effort by definition, and the wrapper
    // still asks for both of its slots back, and is then closed for good.
    expect(freed.length).toBe(2);
    expect(doomed.state).toBe("closed");
    // The healthy codec alongside it was never affected.
    expect(probe.state).toBe("ready");
    expect(probe.encode(wirePayload()).length).toBe(WAVEFORM_SAMPLES);
    probe.close();
  });

  it("surfaces a numeric wasm abort reason as the cause when the Tx id is invalid", async () => {
    // The constructor is public, so a bad id is constructible without ever
    // going through `openSoundChatCodec`. This is the shape a `tx = -1` leak
    // would take at runtime.
    const raw = await loadGgwaveModule();
    raw.disableLog();
    const rx = raw.init(lockedParameters(raw, raw.GGWAVE_OPERATING_MODE_RX));
    const broken = new SoundChatCodec(raw, raw.ProtocolId.GGWAVE_PROTOCOL_AUDIBLE_FASTEST, -1, rx);
    let caught: unknown = "nothing thrown";
    try {
      broken.encode(wirePayload());
    } catch (error) {
      caught = error;
    }
    console.log(
      `[gauntlet] encode on tx=-1 -> ${show(caught)}; cause=${show(caughtCause(caught))}`,
    );
    expect(caught).toBeInstanceOf(CodecModuleError);
    // The cause is the raw abort number, not an `Error`: any consumer that
    // reaches for `error.cause.message` would get `undefined`.
    expect(caughtCause(caught)).not.toBeInstanceOf(Error);
    expect(Number.isInteger(caughtCause(caught))).toBe(true);
    expect(broken.state).toBe("dead");
    expect(() => broken.close()).not.toThrow();
  });

  it("silently never decodes when the Rx id is invalid, with no error at all", async () => {
    const raw = await loadGgwaveModule();
    raw.disableLog();
    const tx = raw.init(lockedParameters(raw, raw.GGWAVE_OPERATING_MODE_TX));
    const broken = new SoundChatCodec(raw, raw.ProtocolId.GGWAVE_PROTOCOL_AUDIBLE_FASTEST, tx, -1);
    const payload = wirePayload();
    const waveform = Uint8Array.from(
      raw.encode(tx, payload, raw.ProtocolId.GGWAVE_PROTOCOL_AUDIBLE_FASTEST, 25),
    );
    let events = 0;
    for (let frame = 0; frame < WAVEFORM_FRAMES; frame += 1) {
      const bytes = waveform.subarray(
        frame * CODEC_SAMPLES_PER_FRAME * 4,
        (frame + 1) * CODEC_SAMPLES_PER_FRAME * 4,
      );
      const samples = new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4);
      if (broken.decode(samples) !== null) events += 1;
    }
    console.log(`[gauntlet] decode on rx=-1: ${events} events, state=${broken.state}`);
    expect(events).toBe(0);
    expect(broken.state).toBe("ready");
    broken.close();
  });
});

describe("wrapper: a long session", () => {
  it("keeps returning whole blocks and intact copies over 40 round trips", async () => {
    const codec = await shippedCodec();
    const payload = wirePayload();
    let decodes = 0;
    for (let round = 0; round < 40; round += 1) {
      const samples = codec.encode(payload);
      expect(samples.length).toBe(WAVEFORM_SAMPLES);
      expect(samples.buffer.byteLength).toBe(WAVEFORM_BYTES);
      flushReceiver(codec);
      feedFrames(codec, samples, (decoded) => {
        decodes += 1;
        // The decode result is a copy too: it outlives the next call.
        expect(digest(decoded)).toBe(digest(payload));
      });
    }
    console.log(`[gauntlet] 40 round trips -> ${decodes} decode events, state=${codec.state}`);
    expect(decodes).toBeGreaterThanOrEqual(40);
    expect(codec.state).toBe("ready");
  });
});
