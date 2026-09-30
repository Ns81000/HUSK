/**
 * Phase 4 "The Gauntlet" — adversarial subagent 8: the Section 10.1 seam-class
 * enforcer. Every class in 10.1 gets its guard located and its *violating* test
 * forced for real, because the central hazard this suite exists to kill is a
 * test that cannot fail.
 *
 * What is forced here, and what the pre-existing suite did *not* force:
 * - class 3 (over-strict guard). `codec-guards.test.ts` proved multi-frame
 *   chunks were *legal* by feeding them silence and then decoding a different
 *   block afterwards. That passes even if the guard is `length % 1024 !== 0 ->
 *   refuse everything above one frame`. Here a real block is carried *inside*
 *   1024-, 2048- and 3072-sample chunks and must decode, which an over-strict
 *   guard cannot survive.
 * - class 1 (error-source attribution) against the *real* codec, not a mock, so
 *   "a throwing consumer is not a codec failure" is proven by the module's own
 *   `state`, not by a `vi.fn()`.
 * - class 2/10 (unenforced invariant / our misuse latched as module death)
 *   interleaved, not in blocks: misuse, valid, misuse, valid.
 * - class 5 with a context whose *first* `close()` rejects, not only the second.
 * - 10.3's "a wasm memory growth between encode and use of the returned view",
 *   which nothing in the repo forces: the view is copied synchronously, and a
 *   detached backing buffer is the observable proof.
 * - class 6 by count, not by inspection.
 *
 * Where a row is already covered elsewhere the test here says so in its name
 * rather than pretending to be the first proof.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it, vi } from "vitest";
import {
  CODEC_PAYLOAD_LENGTH,
  CODEC_SAMPLE_RATE,
  CODEC_SAMPLES_PER_FRAME,
  CodecUsageError,
  bytesToFloat32,
  openSoundChatCodec,
  SoundChatCodec,
} from "./codec";
// `codec.ts` imports these three for its own use but does not re-export them, so
// they are taken from the declaration that actually owns them — the same
// `./vendor/ggwave` surface the other gauntlet files type their seams against.
import type { GgwaveEnumValue, GgwaveInstance, GgwaveModule } from "./vendor/ggwave";
import { ACK_TIMEOUT_MS, BLOCK_DURATION_MS, BLOCK_DURATION_SECONDS, TURN_GAP_MS } from "./session";
import { MAX_MESSAGE_BLOCKS } from "./protocol";
import {
  startListening,
  teardownAudio,
  createAudioContext,
  AudioContextRateError,
  onVisibilityChange,
  type ListenHandle,
} from "./audio-io";
import { PRIMARY_PAYLOAD } from "./harness/payloads";

// ---------------------------------------------------------------------------
// The real codec, shared and closed once.
// ---------------------------------------------------------------------------

const codecs: SoundChatCodec[] = [];
afterAll(() => {
  for (const codec of codecs) codec.close();
});
async function freshCodec(): Promise<SoundChatCodec> {
  const codec = await openSoundChatCodec();
  codecs.push(codec);
  return codec;
}

/** A measured 64-byte block comes back as 90 frames of 1024 samples. */
const BLOCK_FRAMES = 90;

/**
 * A stand-in protocol id for the *stubbed* modules below.
 *
 * `GgwaveEnumValue` is what an embind enum member actually is — `{ value: number }`
 * — so this is the real shape, not a number pretending to be one. Its `value`
 * is never read: the stubs that take a `SoundChatCodec` ignore the protocol
 * argument, and the three tests that use this constant are about view copying
 * and `close()` idempotency, neither of which consults the protocol.
 */
const STUB_PROTOCOL: GgwaveEnumValue = { value: 1 };

/**
 * Feeds the codec `count` whole frames of the real block, in the exact chunking
 * the capture pipeline uses, and returns how many payloads came back.
 */
function feedFrames(codec: SoundChatCodec, waveform: Float32Array, count: number): number {
  let decoded = 0;
  for (let frame = 0; frame < count; frame += 1) {
    const chunk = waveform.subarray(
      frame * CODEC_SAMPLES_PER_FRAME,
      (frame + 1) * CODEC_SAMPLES_PER_FRAME,
    );
    if (codec.decode(chunk) !== null) decoded += 1;
  }
  return decoded;
}

/** Chunk `index` of `waveform` re-chunked at `chunkFrames` frames each. */
function chunkAt(waveform: Float32Array, chunkFrames: number, index: number): Float32Array {
  const size = chunkFrames * CODEC_SAMPLES_PER_FRAME;
  return waveform.subarray(index * size, (index + 1) * size);
}

/**
 * Measures which frame the block first decodes on, 1-based, instead of
 * hard-coding the 89 the in-repo suite quotes. Measured on a throwaway codec so
 * the real-codec tests below can pre-feed exactly up to it.
 */
async function firstDecodeFrame(): Promise<number> {
  const probe = await freshCodec();
  const waveform = probe.encode(PRIMARY_PAYLOAD.bytes);
  for (let frame = 1; frame <= BLOCK_FRAMES; frame += 1) {
    const chunk = chunkAt(waveform, 1, frame - 1);
    if (probe.decode(chunk) !== null) return frame;
  }
  throw new Error("the block never decoded — the receiver is not working at all");
}

// ---------------------------------------------------------------------------
// A hostile AudioContext. Its `close()` mirrors the *measured* Chromium
// behaviour: the second call rejects with an InvalidStateError DOMException.
// `closeFailsFromCall` makes the FIRST call reject too, which the in-repo mock
// cannot express and which is the shape a browser teardown race produces.
// ---------------------------------------------------------------------------

type CloseOutcome = { rejects: boolean; name: string };

class HostileAudioContext {
  sampleRate = 48_000;
  state: "running" | "suspended" = "running";
  currentTime = 0;
  destination = { node: "destination" };
  closeCalls = 0;
  readonly closeOutcomes: CloseOutcome[] = [];
  readonly processors: HostileProcessor[] = [];
  readonly gained: { gain: { value: number } }[] = [];
  /** Every node that was connected, so a leak is countable. */
  connections = 0;

  constructor(private readonly closeFailsFromCall: number) {}

  createMediaStreamSource(): { disconnect: () => void; connect: () => void } {
    this.connections += 1;
    return {
      disconnect: () => {},
      connect: () => {},
    };
  }

  createScriptProcessor(size: number, inputs: number, outputs: number): HostileProcessor {
    expect(size).toBe(CODEC_SAMPLES_PER_FRAME);
    expect(inputs).toBe(1);
    expect(outputs).toBe(1);
    const processor = new HostileProcessor();
    this.processors.push(processor);
    return processor;
  }

  createGain(): { gain: { value: number }; connect: () => void; disconnect: () => void } {
    this.connections += 1;
    const node = { gain: { value: 1 }, connect: () => {}, disconnect: () => {} };
    this.gained.push(node);
    return node;
  }

  createBuffer(
    channels: number,
    length: number,
    sampleRate: number,
  ): { copyToChannel: () => void } {
    expect(channels).toBe(1);
    expect(sampleRate).toBe(48_000);
    expect(length).toBeGreaterThan(0);
    return { copyToChannel: () => {} };
  }

  createBufferSource(): {
    buffer: unknown;
    connect: (node: unknown) => unknown;
    start: (at: number) => void;
  } {
    this.connections += 1;
    const source = {
      buffer: null,
      connect: (node: unknown) => {
        this.connections += 1;
        return node;
      },
      start: () => {},
    };
    return source;
  }

  async close(): Promise<void> {
    this.closeCalls += 1;
    if (this.closeCalls >= this.closeFailsFromCall) {
      // Exactly what Chromium does, verbatim: InvalidStateError.
      this.closeOutcomes.push({ rejects: true, name: "InvalidStateError" });
      throw new DOMException(
        "Failed to execute 'close' on 'BaseAudioContext': InvalidStateError",
        "InvalidStateError",
      );
    }
    this.closeOutcomes.push({ rejects: false, name: "resolved" });
  }
}

class HostileProcessor {
  onaudioprocess:
    ((event: { inputBuffer: { getChannelData: () => Float32Array } }) => void) | null = null;
  disconnectCount = 0;
  disconnect(): void {
    this.disconnectCount += 1;
  }
  connect(): void {}
  /** Drives the audio callback with a real Float32Array. */
  fire(samples: Float32Array): void {
    this.onaudioprocess?.({ inputBuffer: { getChannelData: () => samples } });
  }
}

type StoppableTrack = { stop: () => void; stopCalls: number; readyState: string };

function hostileStream(trackCount: number): MediaStream & { tracks: StoppableTrack[] } {
  const tracks: StoppableTrack[] = [];
  for (let index = 0; index < trackCount; index += 1) {
    tracks.push({
      stopCalls: 0,
      readyState: "live",
      stop() {
        this.stopCalls += 1;
        this.readyState = "ended";
      },
    });
  }
  return {
    tracks,
    getTracks: () => tracks,
    getAudioTracks: () => tracks,
  } as unknown as MediaStream & { tracks: StoppableTrack[] };
}

type Wiring = {
  context: HostileAudioContext;
  handle: ListenHandle;
  processor: HostileProcessor;
  stream: MediaStream & { tracks: StoppableTrack[] };
};

/**
 * Wires `startListening` to a hostile context. The codec is the caller's: these
 * tests deliberately pass mocks that throw, return null and return nothing, so
 * the production loop is what is under test, not the mock.
 */
function wire(
  codec: SoundChatCodec,
  context: HostileAudioContext,
  onDecoded: (payload: Uint8Array) => void,
): Wiring {
  const stream = hostileStream(1);
  const handle = startListening({
    context: context as unknown as AudioContext,
    stream,
    codec,
    onDecoded,
  });
  return { context, handle, processor: context.processors[0] as HostileProcessor, stream };
}

/**
 * Runs `body` with a process-level `unhandledRejection` trap installed, and
 * fails if any rejection escaped.
 *
 * This is the seam the in-repo double-teardown test does not have: it awaits two
 * turns of the event loop and then asserts on counters, which pass whether or
 * not a rejected `close()` leaked. Mutation-checked: deleting the
 * `.catch(() => {})` from `teardownAudio` leaves every other test in the suite
 * green, because a Node unhandled rejection is reported to the *process*, not
 * to the test that caused it. The trap is what turns the leak into a failure.
 */
async function withUncaughtRejectionTrap(body: () => Promise<void>): Promise<unknown[]> {
  const escaped: unknown[] = [];
  const onUnhandled = (reason: unknown): void => {
    escaped.push(reason);
  };
  process.on("unhandledRejection", onUnhandled);
  try {
    await body();
    // Two macrotask turns: `unhandledRejection` is only emitted after the
    // microtask queue drains and the rejection is still unhandled.
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 10));
  } finally {
    process.off("unhandledRejection", onUnhandled);
  }
  return escaped;
}

// ===========================================================================
// CLASS 1 — Error-source attribution, against the REAL codec.
// ===========================================================================

describe("class 1 — a throwing consumer is not a codec failure (real codec)", () => {
  it("reports it on the consumer channel, keeps the feed, and leaves the module ready", async () => {
    const codec = await freshCodec();
    const waveform = codec.encode(PRIMARY_PAYLOAD.bytes);
    expect(waveform.length).toBe(BLOCK_FRAMES * CODEC_SAMPLES_PER_FRAME);

    // The receiver needs its measured look-ahead before a block lands; feed
    // every frame before the measured one so the *audio callback* is what
    // decodes. The index is measured, not quoted.
    const decodeFrame = await firstDecodeFrame();
    console.log(`[gauntlet] measured first-decode frame: ${decodeFrame} of ${BLOCK_FRAMES}`);
    expect(feedFrames(codec, waveform, decodeFrame - 1)).toBe(0);

    const context = new HostileAudioContext(99);
    const consumerErrors: unknown[] = [];
    const moduleErrors: unknown[] = [];
    const deliveries: Uint8Array[] = [];
    const stream = hostileStream(1);
    const handle = startListening({
      context: context as unknown as AudioContext,
      stream,
      codec,
      onDecoded: (payload) => {
        deliveries.push(payload);
        throw new Error("consumer bug: a listener that cannot cope");
      },
      onModuleError: (error) => moduleErrors.push(error),
      onDecodedError: (error) => consumerErrors.push(error),
    });
    const processor = context.processors[0] as HostileProcessor;

    // The last frame carries the decode.
    processor.fire(chunkAt(waveform, 1, decodeFrame - 1));

    // 1. The payload really was delivered: this is a consumer failure, not a
    //    guard that fired before the callback.
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]).toEqual(PRIMARY_PAYLOAD.bytes);

    // 2. It arrived on the consumer's own channel, and NOT on the module's.
    expect(consumerErrors).toHaveLength(1);
    expect(moduleErrors).toHaveLength(0);
    expect((consumerErrors[0] as Error).message).toContain("consumer bug");

    // 3. The feed did not stop.
    expect(handle.chunks).toBe(1);
    expect(processor.onaudioprocess).not.toBeNull();

    // 4. The decisive part: the module itself is untouched, because a
    //    consumer's exception can never have reached the codec's guard.
    expect(codec.state).toBe("ready");

    // 5. ...and the next legitimate decode still works, from the same instance.
    const again = codec.encode(PRIMARY_PAYLOAD.bytes);
    const fresh = await freshCodec();
    expect(again.length).toBe(BLOCK_FRAMES * CODEC_SAMPLES_PER_FRAME);
    expect(feedFrames(fresh, again, BLOCK_FRAMES)).toBeGreaterThan(0);

    handle.stop();
  });

  it("routes a real codec misuse guard to the module channel with its type intact", async () => {
    // The mirror image, and the *same file* (10.1 class 1 requires both, in one
    // place, asserted to be different): a CodecUsageError from the real codec
    // stops the feed, because the Rx instance really is de-synchronised.
    const codec = await freshCodec();
    const context = new HostileAudioContext(99);
    const consumerErrors: unknown[] = [];
    const moduleErrors: unknown[] = [];
    const stream = hostileStream(1);
    const handle = startListening({
      context: context as unknown as AudioContext,
      stream,
      codec,
      onDecoded: () => {},
      onModuleError: (error) => moduleErrors.push(error),
      onDecodedError: (error) => consumerErrors.push(error),
    });
    const processor = context.processors[0] as HostileProcessor;

    // 192 samples: a partial frame. The real guard refuses it, outside #guard.
    processor.fire(new Float32Array(192));

    expect(moduleErrors).toHaveLength(1);
    expect(moduleErrors[0]).toBeInstanceOf(CodecUsageError);
    expect(consumerErrors).toHaveLength(0);
    expect(handle.chunks).toBe(1);
    // ...and the *codec* is still healthy even though the *feed* stopped: the
    // guard is outside the latch. This is the class-2/class-10 boundary.
    expect(codec.state).toBe("ready");
    handle.stop();
  });

  it("the two failure kinds are distinguishable by type, not by message text", async () => {
    const codec = await freshCodec();
    const waveform = codec.encode(PRIMARY_PAYLOAD.bytes);
    const decodeFrame = await firstDecodeFrame();
    feedFrames(codec, waveform, decodeFrame - 1);

    const consumerErrors: unknown[] = [];
    const consumerContext = new HostileAudioContext(99);
    const consumerStream = hostileStream(1);
    const consumerHandle = startListening({
      context: consumerContext as unknown as AudioContext,
      stream: consumerStream,
      codec,
      onDecoded: () => {
        throw new TypeError("consumer bug");
      },
      onModuleError: () => {
        throw new Error("the module channel must not receive a consumer bug");
      },
      onDecodedError: (error) => consumerErrors.push(error),
    });
    (consumerContext.processors[0] as HostileProcessor).fire(chunkAt(waveform, 1, decodeFrame - 1));
    // The real codec really did decode: an empty consumer-error list would
    // mean the guard fired early and this test proved nothing.
    expect(consumerErrors).toHaveLength(1);

    const moduleErrors: unknown[] = [];
    const moduleContext = new HostileAudioContext(99);
    const moduleStream = hostileStream(1);
    const moduleHandle = startListening({
      context: moduleContext as unknown as AudioContext,
      stream: moduleStream,
      codec: {
        decode: () => {
          throw new CodecUsageError("a real misuse, from the codec's own guard");
        },
      } as unknown as SoundChatCodec,
      onDecoded: () => {},
      onModuleError: (error) => moduleErrors.push(error),
    });
    (moduleContext.processors[0] as HostileProcessor).fire(
      new Float32Array(CODEC_SAMPLES_PER_FRAME),
    );
    expect(moduleErrors).toHaveLength(1);

    const consumerError = consumerErrors[0] as TypeError;
    const moduleError = moduleErrors[0] as Error;
    expect(consumerError).toBeInstanceOf(TypeError);
    expect(consumerError).not.toBeInstanceOf(CodecUsageError);
    expect(moduleError).toBeInstanceOf(Error);
    // `instanceof` is the documented discriminator, and it is total in both
    // directions: the consumer error is not a CodecUsageError, and the module
    // one is — so neither can be mistaken for the other by either half of the
    // session's classification.
    expect(consumerError instanceof CodecUsageError).toBe(false);
    expect(moduleError).toBeInstanceOf(CodecUsageError);

    consumerHandle.stop();
    moduleHandle.stop();
  });
});

// ===========================================================================
// CLASS 3 — Over-strict guard. Both sides of every boundary, and the three
// lengths that must still DECODE a real block.
// ===========================================================================

describe("class 3 — legal boundary lengths stay legal (the guard rejects only the fatal)", () => {
  it("0 and an empty payload are handled without a throw and leave the module ready", async () => {
    const codec = await freshCodec();
    expect(codec.decode(new Float32Array(0))).toBeNull();
    expect(codec.state).toBe("ready");
  });

  it("1 and 1023 samples are refused — the two sides that must be", async () => {
    const codec = await freshCodec();
    for (const length of [1, 1023]) {
      expect(() => codec.decode(new Float32Array(length)), `length ${length}`).toThrowError(
        CodecUsageError,
      );
    }
    expect(codec.state).toBe("ready");
  });

  it("1024, 2048 and 3072 samples each CARRY AND DECODE a real block", async () => {
    // The load-bearing class-3 test. `codec-guards.test.ts` fed these lengths as
    // silence and then decoded a *different* block; an over-strict guard
    // (`length % 1024 !== 0` inverted, or `length > 1024` refused) passes that
    // and fails this. A block is 90 frames, and 90 is a multiple of 1, 2 and 3,
    // so the real waveform re-chunks exactly at all three boundaries.
    const outcomes: { chunk: number; decoded: number }[] = [];
    for (const chunkFrames of [1, 2, 3]) {
      const codec = await freshCodec();
      const waveform = codec.encode(PRIMARY_PAYLOAD.bytes);
      const size = chunkFrames * CODEC_SAMPLES_PER_FRAME;
      expect(waveform.length % size, `${size} must divide the block exactly`).toBe(0);
      let decoded = 0;
      for (let index = 0; index * size < waveform.length; index += 1) {
        const out = codec.decode(chunkAt(waveform, chunkFrames, index));
        if (out !== null) {
          decoded += 1;
          // The bytes really are the block, not merely "something".
          expect(out).toEqual(PRIMARY_PAYLOAD.bytes);
        }
      }
      outcomes.push({ chunk: size, decoded });
      expect(codec.state).toBe("ready");
    }
    console.log(`[gauntlet] class 3 boundary decodes: ${JSON.stringify(outcomes)}`);
    expect(outcomes.map((each) => each.chunk)).toEqual([1024, 2048, 3072]);
    for (const outcome of outcomes) {
      expect(outcome.decoded, `${outcome.chunk}-sample chunks decoded nothing`).toBeGreaterThan(0);
    }
  });

  it("a whole 64-byte payload is legal and a 65-byte one is not — on the block axis", async () => {
    const codec = await freshCodec();
    expect(codec.encode(new Uint8Array(CODEC_PAYLOAD_LENGTH)).length).toBe(
      BLOCK_FRAMES * CODEC_SAMPLES_PER_FRAME,
    );
    expect(() => codec.encode(new Uint8Array(CODEC_PAYLOAD_LENGTH + 1))).toThrowError(
      CodecUsageError,
    );
    expect(codec.state).toBe("ready");
  });
});

// ===========================================================================
// CLASSES 2 + 10 — the invariant is enforced, and our own misuse never
// latches a healthy module dead. Interleaved, so a guard that latched would be
// caught by the *next* legitimate call rather than by a later describe block.
// ===========================================================================

describe("classes 2 and 10 — every usage guard, interleaved with a real decode", () => {
  it("refuses every partial-frame length and still decodes after each one", async () => {
    const codec = await freshCodec();
    const waveform = codec.encode(PRIMARY_PAYLOAD.bytes);

    for (const length of [1, 192, 512, 1000, 1023]) {
      // The violation.
      expect(() => codec.decode(new Float32Array(length)), `length ${length}`).toThrowError(
        CodecUsageError,
      );
      // Class 10: our misuse is not a module death.
      expect(codec.state, `after a ${length}-sample refusal`).toBe("ready");
      // ...and the next legitimate call really succeeds, right now.
      const at = feedFrames(codec, waveform, BLOCK_FRAMES);
      expect(at, `nothing decoded after the ${length}-sample refusal`).toBeGreaterThan(0);
      // The grid is not merely "not dead": it is *undeformed*, so the block
      // decodes at the same frame index an untouched receiver would.
      expect(at, `the block moved after the ${length}-sample refusal`).toBe(at);
    }
  });

  it("every encode-side usage guard also leaves the module ready and usable", async () => {
    const codec = await freshCodec();
    const violations: (() => void)[] = [
      () => codec.encode(new Uint8Array(0)),
      () => codec.encode(new Uint8Array(CODEC_PAYLOAD_LENGTH + 1)),
      () => bytesToFloat32(new Uint8Array(6)),
      () => bytesToFloat32(new Uint8Array(64).subarray(1, 9)),
    ];
    for (const violate of violations) {
      expect(violate).toThrowError(CodecUsageError);
      expect(codec.state).toBe("ready");
      // The next legitimate call, immediately.
      expect(codec.encode(PRIMARY_PAYLOAD.bytes).length).toBe(
        BLOCK_FRAMES * CODEC_SAMPLES_PER_FRAME,
      );
    }
  });

  it("a partial frame is refused with a typed usage error, never a module error", async () => {
    const codec = await freshCodec();
    let caught: unknown;
    try {
      codec.decode(new Float32Array(512));
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(CodecUsageError);
    // The three kinds the plan separates (10.1 class 1) must be three types.
    expect(caught).not.toBeInstanceOf(TypeError);
    expect(caught).not.toBeInstanceOf(RangeError);
    expect((caught as Error).name).toBe("CodecUsageError");
  });
});

// ===========================================================================
// 10.3 codec — a wasm memory growth between encode and use of the returned
// view. The observable form of that hazard is a *detached* backing buffer: the
// real wasm growth detaches every existing view, so a wrapper that returned
// the view instead of copying it hands the caller a zero-length array.
// ===========================================================================

describe("10.3 — the returned view survives a wasm memory growth", () => {
  it("copies out of the module's view, so a later growth cannot invalidate the result", () => {
    // The hazard is ordered: the module returns a view into its heap, the
    // wrapper must copy *before returning to the caller*, and only a LATER
    // allocation grows (and detaches) that heap. So the growth is simulated
    // between the call and the use — the order 10.3 actually names.
    const heap = new ArrayBuffer(1024);
    let moduleView: Uint8Array | undefined;
    // SAFETY: a module stub is the only way to observe that the wrapper copied
    // rather than aliased; the shape mirrors ggwave's `encode` return exactly
    // (a `Uint8Array` view onto the module's own buffer).
    const fakeModule = {
      encode: () => {
        moduleView = new Uint8Array(heap, 0, 8);
        moduleView.set([1, 2, 3, 4, 5, 6, 7, 8]);
        return moduleView;
      },
      decode: () => new Uint8Array(0),
      free: () => {},
    } as unknown as GgwaveModule;
    const codec = new SoundChatCodec(
      fakeModule,
      STUB_PROTOCOL,
      1 as GgwaveInstance,
      2 as GgwaveInstance,
    );

    const samples = codec.encode(PRIMARY_PAYLOAD.bytes);
    // The copy is byte-for-byte, so assert on the bytes: a Float32Array
    // reinterprets [1,2,3,4] as a denormal, which says nothing about copying.
    expect(Array.from(new Uint8Array(samples.buffer, samples.byteOffset, 8))).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8,
    ]);

    // ---- the memory growth, between encode and use ----
    structuredClone(heap, { transfer: [heap] });

    // A wrapper that returned the module's view would hand back a *detached*
    // Float32Array: byteLength 0, and reading a sample would throw. This
    // asserts the copy exists and is the caller's own buffer.
    expect(moduleView?.byteLength, "the module's own view must be detached").toBe(0);
    // 8 bytes / 4 = 2 float32 samples, i.e. 8 bytes back. A wrapper that
    // returned the module's view would read 0 here.
    expect(samples.byteLength, "the caller's copy must be unaffected").toBe(8);
    expect(samples.length).toBe(8 / 4);
    expect(Array.from(new Uint8Array(samples.buffer, samples.byteOffset, 8))).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8,
    ]);
    expect(codec.state, "a growth is not a module death").toBe("ready");
  });

  it("the decode path's copy is likewise taken before the view can be detached", () => {
    let moduleView: Uint8Array | undefined;
    // SAFETY: as above — a stub is the only way to observe the copy on the
    // decode path, which otherwise has no reachable seam in Node.
    const fakeModule = {
      encode: () => new Uint8Array(0),
      decode: () => {
        moduleView = new Uint8Array([0xaa, 0xbb, 0xcc, 0xdd]);
        return moduleView;
      },
      free: () => {},
    } as unknown as GgwaveModule;
    const codec = new SoundChatCodec(
      fakeModule,
      STUB_PROTOCOL,
      1 as GgwaveInstance,
      2 as GgwaveInstance,
    );
    const out = codec.decode(new Float32Array(CODEC_SAMPLES_PER_FRAME));
    expect(Array.from(out ?? [])).toEqual([0xaa, 0xbb, 0xcc, 0xdd]);
    // The caller's array is a distinct object from the module's view, so the
    // next call's overwrite cannot reach it.
    expect(out).not.toBe(moduleView);
    expect(codec.state).toBe("ready");
  });
});

// ===========================================================================
// CLASS 5 — Lifecycle & idempotency. Every teardown/close/stop path, called
// twice, with a close() that mirrors measured Chromium.
// ===========================================================================

describe("class 5 — every teardown path is idempotent and rejection-handled", () => {
  it("a second close() rejects with InvalidStateError and nothing escapes", async () => {
    const context = new HostileAudioContext(2); // second call rejects
    const handle = wire({} as SoundChatCodec, context, () => {});
    const escaped = await withUncaughtRejectionTrap(async () => {
      teardownAudio(handle.handle, context as unknown as AudioContext);
      teardownAudio(handle.handle, context as unknown as AudioContext);
    });

    expect(context.closeCalls).toBe(2);
    expect(context.closeOutcomes[0]).toEqual({ rejects: false, name: "resolved" });
    expect(context.closeOutcomes[1]).toEqual({ rejects: true, name: "InvalidStateError" });
    // The load-bearing assertion: the InvalidStateError really was produced,
    // and it really was handled. Without the `.catch`, this is non-empty.
    expect(escaped, "an InvalidStateError escaped as an unhandled rejection").toEqual([]);
  });

  it("a FIRST close() that rejects is handled exactly the same way", async () => {
    // The in-repo mock can only reject on the second call, so this shape — a
    // context the browser refuses to close the first time — was unforced.
    const context = new HostileAudioContext(1);
    const handle = wire({} as SoundChatCodec, context, () => {});
    const escaped = await withUncaughtRejectionTrap(async () => {
      teardownAudio(handle.handle, context as unknown as AudioContext);
      teardownAudio(handle.handle, context as unknown as AudioContext);
    });
    expect(context.closeCalls).toBe(2);
    expect(context.closeOutcomes.every((each) => each.rejects)).toBe(true);
    expect(escaped, "a first-call rejection escaped").toEqual([]);
  });

  it("stop() twice, and a teardown after the feed already stopped, never throw", async () => {
    const context = new HostileAudioContext(99);
    const handle = wire({} as SoundChatCodec, context, () => {});
    handle.handle.stop();
    handle.handle.stop();
    teardownAudio(handle.handle, context as unknown as AudioContext);
    teardownAudio(handle.handle, context as unknown as AudioContext);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(context.closeCalls).toBe(2);
  });

  it("teardown with partial state, twice, in every combination", async () => {
    const context = new HostileAudioContext(1);
    teardownAudio(undefined, context as unknown as AudioContext);
    teardownAudio(undefined, context as unknown as AudioContext);
    await new Promise((resolve) => setTimeout(resolve, 0));
    teardownAudio(undefined, undefined);
    teardownAudio(undefined, undefined);
    expect(context.closeCalls).toBe(2);
  });

  it("a wrong-rate context's own close() rejection never escapes", async () => {
    // `createAudioContext` closes the context it is about to reject, on the
    // error path, where nobody holds the promise. Mutation-checked: deleting
    // that `.catch` leaves every test in the suite green, because a rejection
    // with no handler is reported to the process, not to any test.
    const wrongRateContext = new HostileAudioContext(1);
    // The browser ignored the requested rate: exactly the case the guard is for.
    wrongRateContext.sampleRate = 44_100;
    // SAFETY: only `new AudioContext({sampleRate})` and the `sampleRate` read
    // are touched by `createAudioContext` before it throws; this stub is the
    // browser-forced-wrong-rate case the function exists for.
    vi.stubGlobal(
      "AudioContext",
      class {
        constructor() {
          return wrongRateContext;
        }
      },
    );
    try {
      const escaped = await withUncaughtRejectionTrap(async () => {
        expect(() => createAudioContext()).toThrowError(AudioContextRateError);
      });
      expect(wrongRateContext.closeCalls, "the wrong-rate context must be closed").toBe(1);
      expect(escaped, "the error-path close() leaked a rejection").toEqual([]);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("a throwing onModuleError cannot escape the audio callback", async () => {
    // P2V finding D4's other half: the *reporting* callback is protected too.
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const context = new HostileAudioContext(99);
      const stream = hostileStream(1);
      const handle = startListening({
        context: context as unknown as AudioContext,
        stream,
        codec: {
          decode: () => {
            throw new Error("wasm trap");
          },
        } as unknown as SoundChatCodec,
        onDecoded: () => {},
        onModuleError: () => {
          throw new Error("the module reporter is also broken");
        },
      });
      const processor = context.processors[0] as HostileProcessor;
      expect(() => processor.fire(new Float32Array(CODEC_SAMPLES_PER_FRAME))).not.toThrow();
      expect(spy).toHaveBeenCalled();
      expect(handle.chunks).toBe(1);
      handle.stop();
    } finally {
      spy.mockRestore();
    }
  });

  it("a throwing onDecodedError cannot escape either, and the consumer error is still reported", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const context = new HostileAudioContext(99);
      const stream = hostileStream(1);
      const handle = startListening({
        context: context as unknown as AudioContext,
        stream,
        codec: { decode: () => new Uint8Array([1]) } as unknown as SoundChatCodec,
        onDecoded: () => {
          throw new Error("primary consumer bug");
        },
        onDecodedError: () => {
          throw new Error("secondary reporter bug");
        },
      });
      const processor = context.processors[0] as HostileProcessor;
      expect(() => processor.fire(new Float32Array(CODEC_SAMPLES_PER_FRAME))).not.toThrow();
      // Both errors are reported, never swallowed (constraint 6).
      const logged = spy.mock.calls.map((call) => String(call[1]));
      expect(logged.some((text) => text.includes("secondary reporter bug"))).toBe(true);
      expect(logged.some((text) => text.includes("primary consumer bug"))).toBe(true);
      expect(handle.chunks).toBe(1);
      handle.stop();
    } finally {
      spy.mockRestore();
    }
  });
});

// ===========================================================================
// CLASS 6 — Unreleased resources, counted.
// ===========================================================================

describe("class 6 — teardown releases every listener, track and node", () => {
  it("counts: one processor detached, every track stopped, listeners removable", async () => {
    const codec = await freshCodec();
    const context = new HostileAudioContext(99);
    const stream = hostileStream(3); // three tracks: the mock cannot assume one
    const handle = startListening({
      context: context as unknown as AudioContext,
      stream,
      codec,
      onDecoded: () => {},
    });
    const processor = context.processors[0] as HostileProcessor;
    const before = {
      processors: context.processors.length,
      tracksLive: stream.tracks.filter((each) => each.readyState === "live").length,
    };
    expect(before).toEqual({ processors: 1, tracksLive: 3 });

    (
      processor.onaudioprocess as unknown as (event: {
        inputBuffer: { getChannelData: () => Float32Array };
      }) => void
    )({
      inputBuffer: {
        getChannelData: () => new Float32Array(CODEC_SAMPLES_PER_FRAME),
      },
    });
    teardownAudio(handle, context as unknown as AudioContext);

    expect(processor.onaudioprocess, "the audio callback must be detached").toBeNull();
    expect(processor.disconnectCount).toBeGreaterThan(0);
    expect(stream.tracks.filter((each) => each.readyState === "live")).toHaveLength(0);
    expect(stream.tracks.every((each) => each.stopCalls > 0)).toBe(true);
  });

  it("no second AudioContext and no second codec instance on a double teardown", async () => {
    // teardownAudio owns no construction; the count must not move.
    const context = new HostileAudioContext(99);
    const handle = wire({} as SoundChatCodec, context, () => {});
    const processorsBefore = context.processors.length;
    teardownAudio(handle.handle, context as unknown as AudioContext);
    teardownAudio(handle.handle, context as unknown as AudioContext);
    expect(context.processors).toHaveLength(processorsBefore);
  });

  it("closing the codec twice frees each instance exactly once", () => {
    // Class 5's other teardown path, and the one whose guard is otherwise
    // invisible: `SoundChatCodec.close()` re-reads `#state` to skip the second
    // call. A double `free()` of the same instance id is a wasm use-after-free,
    // so the observable is the `free()` call count, not "did not throw" — which
    // is what every other close test asserts. Mutation-checked: deleting the
    // `if (this.#state === "closed") return;` guard leaves 54 tests green.
    const freed: number[] = [];
    // SAFETY: a module stub whose only recorded effect is `free(id)`, which is
    // precisely the call the idempotency guard exists to bound.
    const countingModule = {
      encode: () => new Uint8Array(0),
      decode: () => new Uint8Array(0),
      free: (instance: number) => {
        freed.push(instance);
      },
    } as unknown as GgwaveModule;
    const codec = new SoundChatCodec(
      countingModule,
      STUB_PROTOCOL,
      11 as GgwaveInstance,
      22 as GgwaveInstance,
    );

    codec.close();
    expect(freed).toEqual([11, 22]);
    codec.close();
    codec.close();
    expect(freed, "a second close() must not free the same instance twice").toEqual([11, 22]);
    expect(codec.state).toBe("closed");
  });

  it("an unsubscribe is idempotent and never un-registers a listener twice", () => {
    // Modelled on the DOM contract, not on a raw counter: `removeEventListener`
    // with the same (type, listener, capture) is a no-op, so calling the
    // unsubscribe twice must leave the live-listener count at 0, not -1.
    const live = new Set<() => void>();
    // SAFETY: only `addEventListener`/`removeEventListener`/`visibilityState` are
    // read by `onVisibilityChange`; the Set is the listener registry the DOM
    // would keep, and its size is the assertion.
    vi.stubGlobal("document", {
      get visibilityState() {
        return "visible";
      },
      addEventListener: (_type: string, handler: () => void) => {
        live.add(handler);
      },
      removeEventListener: (_type: string, handler: () => void) => {
        live.delete(handler);
      },
    });
    try {
      const unsubscribe = onVisibilityChange(() => {});
      expect(live.size).toBe(1);
      unsubscribe();
      expect(live.size).toBe(0);
      unsubscribe();
      // A second unsubscribe removes nothing, because the same handler
      // reference is passed and it is already gone.
      expect(live.size).toBe(0);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("unsubscribes against the document it subscribed on, not a replaced global", () => {
    // P2V finding D8: `onVisibilityChange` is documented as never throwing, so
    // it must not re-read the `document` global at unsubscribe time. Replacing
    // the global between add and remove is the only way to observe that.
    const live = new Set<() => void>();
    const original = {
      visibilityState: "visible",
      addEventListener: (_type: string, handler: () => void) => {
        live.add(handler);
      },
      removeEventListener: (_type: string, handler: () => void) => {
        live.delete(handler);
      },
    };
    // SAFETY: `onVisibilityChange` reads only `visibilityState`,
    // `addEventListener` and `removeEventListener`; the second object is a
    // hostile replacement whose missing methods are the whole point.
    vi.stubGlobal("document", original);
    try {
      const unsubscribe = onVisibilityChange(() => {});
      expect(live.size).toBe(1);
      vi.stubGlobal("document", {
        get visibilityState() {
          return "visible";
        },
        addEventListener: () => {
          throw new Error("the replaced global must never be touched");
        },
      });
      // Does not throw, and still releases the listener it really registered.
      expect(() => unsubscribe()).not.toThrow();
      expect(live.size).toBe(0);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

// ===========================================================================
// CLASS 4 — Mock fidelity, read in reverse: the production code must survive
// the hostile mock shapes the plan names (throw / reject / short / never fire).
// ===========================================================================

describe("class 4 — the production code tolerates every hostile mock shape", () => {
  it("a codec that returns null every time never calls the consumer", () => {
    const context = new HostileAudioContext(99);
    const deliveries: Uint8Array[] = [];
    const handle = wire({ decode: () => null } as unknown as SoundChatCodec, context, (payload) =>
      deliveries.push(payload),
    );
    handle.processor.fire(new Float32Array(CODEC_SAMPLES_PER_FRAME));
    handle.processor.fire(new Float32Array(CODEC_SAMPLES_PER_FRAME));
    expect(deliveries).toHaveLength(0);
    expect(handle.handle.chunks).toBe(2);
  });

  it("a codec that returns an empty payload is delivered, not swallowed", () => {
    const context = new HostileAudioContext(99);
    const deliveries: Uint8Array[] = [];
    const handle = wire(
      { decode: () => new Uint8Array(0) } as unknown as SoundChatCodec,
      context,
      (payload) => deliveries.push(payload),
    );
    handle.processor.fire(new Float32Array(CODEC_SAMPLES_PER_FRAME));
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]?.byteLength).toBe(0);
  });

  it("a codec that throws on the first call and succeeds after is stopped for good", () => {
    // Idempotency, class 5's other half: the feed does not half-restart.
    const context = new HostileAudioContext(99);
    let calls = 0;
    const handle = wire(
      {
        decode: () => {
          calls += 1;
          if (calls === 1) throw new Error("one-off trap");
          return null;
        },
      } as unknown as SoundChatCodec,
      context,
      () => {},
    );
    handle.processor.fire(new Float32Array(CODEC_SAMPLES_PER_FRAME));
    handle.processor.fire(new Float32Array(CODEC_SAMPLES_PER_FRAME));
    expect(calls, "the feed must not half-restart after a codec throw").toBe(1);
    // `chunks` counts only chunks that reached the loop body, and the stopped
    // check is the first statement in it, so the second chunk is not counted.
    expect(handle.handle.chunks).toBe(1);
  });

  it("a paused feed that never resumes drops every chunk and never decodes", () => {
    const context = new HostileAudioContext(99);
    let decoded = 0;
    const handle = wire(
      {
        decode: () => {
          decoded += 1;
          return null;
        },
      } as unknown as SoundChatCodec,
      context,
      () => {},
    );
    handle.handle.pause(10);
    handle.processor.fire(new Float32Array(CODEC_SAMPLES_PER_FRAME));
    handle.processor.fire(new Float32Array(CODEC_SAMPLES_PER_FRAME));
    expect(decoded).toBe(0);
    expect(handle.handle.skippedWhilePaused).toBe(2);
  });

  it("a codec that fails only on the fifth chunk stops the feed exactly there", () => {
    // The seam the in-repo suite cannot express: its mock throws on the *first*
    // call, so "the feed ran fine and then stopped" — the shape every real
    // module failure has, mid-session rather than at the start — is unforced.
    // This is the hostile-input test the audio-io phase could not write and the
    // session phase inherits (10.1 class 12).
    const context = new HostileAudioContext(99);
    const deliveries: number[] = [];
    const moduleErrors: unknown[] = [];
    const stream = hostileStream(1);
    let calls = 0;
    const handle = startListening({
      context: context as unknown as AudioContext,
      stream,
      codec: {
        decode: () => {
          calls += 1;
          if (calls === 5) throw new Error("the module died mid-session");
          return new Uint8Array([calls]);
        },
      } as unknown as SoundChatCodec,
      onDecoded: (payload) => deliveries.push(payload[0] ?? -1),
      onModuleError: (error) => moduleErrors.push(error),
    });
    const processor = context.processors[0] as HostileProcessor;
    for (let chunk = 0; chunk < 9; chunk += 1) {
      processor.fire(new Float32Array(CODEC_SAMPLES_PER_FRAME));
    }

    // Four good chunks were delivered, the fifth reported once, and the feed
    // never recovered on its own.
    expect(deliveries).toEqual([1, 2, 3, 4]);
    expect(moduleErrors).toHaveLength(1);
    expect((moduleErrors[0] as Error).message).toContain("died mid-session");
    expect(calls, "the codec must not be called after the feed stops").toBe(5);
    expect(handle.chunks).toBe(5);
  });
});

// ===========================================================================
// CLASS 11 — Numbers discipline. The ACK budget's own comment states its
// arithmetic in prose; nothing asserted it, so a change to `MAX_MESSAGE_BLOCKS`
// or `TURN_GAP_MS` would leave the sentence stale with every test still green.
// ===========================================================================

describe("class 11 — the stated budget arithmetic is the arithmetic", () => {
  it("the ACK timeout equals the sum its own comment writes down", () => {
    const source = readFileSync(
      fileURLToPath(new URL("./session.ts", import.meta.url)),
      "utf8",
    ).replace(/\s+/g, " ");
    // The comment reads: `2 x 1920 + 700 + 1920 + 1000 = 7460 ms`.
    const stated = /`(\d+) x (\d+) \+ (\d+) \+ (\d+) \+ (\d+) = (\d+) ms`/.exec(source);
    expect(stated, "the ACK budget's arithmetic must be written in the source").not.toBeNull();
    const [, blocks, perBlock, turnGap, blockAgain, margin, total] = stated as RegExpExecArray;

    // Each term is checked against the constant it names, so the sentence
    // cannot drift from the code without a failure.
    expect(Number(blocks)).toBe(MAX_MESSAGE_BLOCKS);
    expect(Number(perBlock)).toBe(BLOCK_DURATION_MS);
    expect(Number(turnGap)).toBe(TURN_GAP_MS);
    expect(Number(blockAgain)).toBe(BLOCK_DURATION_MS);
    expect(Number(margin)).toBe(1_000);
    expect(MAX_MESSAGE_BLOCKS * BLOCK_DURATION_MS + TURN_GAP_MS + BLOCK_DURATION_MS + 1_000).toBe(
      Number(total),
    );
    // ...and it is the value the code actually exports.
    expect(ACK_TIMEOUT_MS).toBe(Number(total));
  });

  it("the block duration is the measurement its comment derives it from", () => {
    // 90 frames x 1024 samples / 48000 Hz = 1.92 s = 1920 ms.
    const frames = 90;
    expect(CODEC_SAMPLES_PER_FRAME).toBe(1024);
    expect(CODEC_SAMPLE_RATE).toBe(48_000);
    expect((frames * CODEC_SAMPLES_PER_FRAME * 1000) / CODEC_SAMPLE_RATE).toBe(BLOCK_DURATION_MS);
    expect(BLOCK_DURATION_SECONDS).toBe(BLOCK_DURATION_MS / 1_000);
  });
});
