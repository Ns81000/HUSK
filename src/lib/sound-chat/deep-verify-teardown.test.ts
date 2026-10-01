/**
 * Phase 2V re-verification — teardown, the module-failure path and the error
 * channels (F3, F5, F6, F8, F13).
 *
 * These four fixes all live on the same seams: `stop()` resetting the async
 * chain, `#handleBlock` bailing out early, `#moduleFailed` becoming idempotent,
 * `start()` catching its own failure, and `restart()` refusing states it cannot
 * leave. The claims they make are strong — "nothing is delivered after stop()",
 * "one report, no timer, no pairing failure afterwards" — so this file drives
 * each of them at the moment the teardown happens rather than after it.
 *
 * The acoustic loop is the frame-level loopback codec the other verification
 * files use, with one addition: `crypto.subtle.decrypt` can be gated, which is
 * the only way to hold a block *inside* `#handleBlock`'s `await parse` and call
 * `stop()` while it is there.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SoundChatCodec } from "./codec";
import type { RandomSource } from "./crypto";
import { derivePairingKeys } from "./crypto";
import { FrameCodec, MAX_SEND_ATTEMPTS } from "./protocol";
import { BLOCK_DURATION_MS, SoundChatSession, type SessionEvent } from "./session";
import { drainAsync } from "./drain.ts";

const CODE = "ABCD2345";
const SAMPLE_FRAME = 1024;
let roomClock = 10;

const keys = await derivePairingKeys(CODE);

type LoopCodec = {
  state: string;
  readonly txLog: Uint8Array[];
  readonly rxQueue: Uint8Array[];
  /** Arms a one-shot trap: the next `encode` throws and the codec goes dead. */
  dieOnNextEncode: () => void;
  encode(payload: Uint8Array): Float32Array;
  decode(): Uint8Array | null;
};

function loopCodec(): LoopCodec {
  const txLog: Uint8Array[] = [];
  const rxQueue: Uint8Array[] = [];
  const audio = new Float32Array(SAMPLE_FRAME);
  let armed = false;
  const codec: LoopCodec = {
    state: "ready",
    txLog,
    rxQueue,
    dieOnNextEncode: (): void => {
      armed = true;
    },
    encode(payload: Uint8Array): Float32Array {
      if (armed) {
        armed = false;
        codec.state = "dead";
        throw new Error("wasm trap");
      }
      if (payload.length === 0 || payload.length > 64) throw new Error("misuse");
      txLog.push(Uint8Array.from(payload));
      return audio;
    },
    decode(): Uint8Array | null {
      return rxQueue.length > 0 ? (rxQueue.shift() as Uint8Array) : null;
    },
  };
  return codec;
}

type FakeProcessor = {
  onaudioprocess:
    ((event: { inputBuffer: { getChannelData: (index: number) => Float32Array } }) => void) | null;
  connect: (node: unknown) => void;
  disconnect: () => void;
};

class FakeAudioContext {
  readonly sampleRate = 48_000;
  state = "running";
  readonly destination = { kind: "destination" };
  readonly processors: FakeProcessor[] = [];
  nodesCreated = 0;
  plays = 0;
  closeCalls = 0;

  get currentTime(): number {
    return roomClock;
  }

  async close(): Promise<void> {
    this.closeCalls += 1;
    if (this.state === "closed") throw new DOMException("already closed", "InvalidStateError");
    this.state = "closed";
  }

  createMediaStreamSource(): { connect: () => void; disconnect: () => void } {
    this.nodesCreated += 1;
    return { connect: (): void => {}, disconnect: (): void => {} };
  }

  createScriptProcessor(size: number): FakeProcessor {
    if (size !== SAMPLE_FRAME) throw new Error(`unexpected processor shape ${size}`);
    this.nodesCreated += 1;
    const processor: FakeProcessor = {
      onaudioprocess: null,
      connect: (): void => {},
      disconnect: (): void => {},
    };
    this.processors.push(processor);
    return processor;
  }

  createGain(): { gain: { value: number }; connect: () => void; disconnect: () => void } {
    this.nodesCreated += 1;
    return { gain: { value: 0 }, connect: (): void => {}, disconnect: (): void => {} };
  }

  createBuffer(): { copied: Float32Array[]; copyToChannel: (samples: Float32Array) => void } {
    const buffer: { copied: Float32Array[]; copyToChannel: (samples: Float32Array) => void } = {
      copied: [],
      copyToChannel: (): void => {},
    };
    buffer.copyToChannel = (samples: Float32Array): void => {
      buffer.copied.push(Float32Array.from(samples));
    };
    return buffer;
  }

  createBufferSource = (): unknown => {
    const source = {
      buffer: null as { copied: Float32Array[] } | null,
      connect: () => source,
      start: (): void => {
        this.plays += 1;
      },
    };
    return source;
  };
}

type MockTrack = { stops: number; stop: () => void };

/** A stream whose track list a test can empty and refill at will. */
function mutableStream(): {
  stream: MediaStream;
  tracks: MockTrack[];
  setTracks: (n: number) => void;
} {
  const tracks: MockTrack[] = [];
  const setTracks = (count: number): void => {
    tracks.length = 0;
    for (let index = 0; index < count; index += 1) {
      tracks.push({
        stops: 0,
        stop(): void {
          this.stops += 1;
        },
      });
    }
  };
  setTracks(1);
  return {
    stream: {
      getAudioTracks: () => [...tracks],
      getTracks: () => [...tracks],
    } as unknown as MediaStream,
    tracks,
    setTracks,
  };
}

type Peer = {
  readonly label: string;
  readonly context: FakeAudioContext;
  readonly codec: LoopCodec;
  readonly session: SoundChatSession;
  readonly events: SessionEvent[];
  readonly moduleErrors: unknown[];
  readonly listenerErrors: unknown[];
  readonly tracks: MockTrack[];
  /** Audio played but not yet taken, so a test can wait for it as a condition. */
  pendingAir: () => number;
  takeAir: () => Uint8Array[];
  texts: () => string[];
};

type PeerOptions = {
  label: string;
  role: "displayer" | "enterer";
  pairingCode?: string;
  random?: RandomSource;
  codec?: LoopCodec;
  stream?: MediaStream;
  onEvent?: (event: SessionEvent) => void;
  onListenerError?: (error: unknown) => void;
  onModuleError?: (error: unknown) => void;
};

const createdPeers: Peer[] = [];

async function createPeer(options: PeerOptions): Promise<Peer> {
  const context = new FakeAudioContext();
  const codec = options.codec ?? loopCodec();
  const events: SessionEvent[] = [];
  const moduleErrors: unknown[] = [];
  const listenerErrors: unknown[] = [];
  const mic = mutableStream();
  const base = {
    codec: codec as unknown as SoundChatCodec,
    context: context as unknown as AudioContext,
    stream: options.stream ?? mic.stream,
    role: options.role,
    onEvent: (event: SessionEvent): void => {
      events.push(event);
      options.onEvent?.(event);
    },
    onListenerError: (error: unknown): void => {
      listenerErrors.push(error);
      options.onListenerError?.(error);
    },
    onModuleError: (error: unknown): void => {
      moduleErrors.push(error);
      options.onModuleError?.(error);
    },
    ...(options.random === undefined ? {} : { random: options.random }),
  };
  const session = await SoundChatSession.create(
    options.pairingCode === undefined ? base : { ...base, pairingCode: options.pairingCode },
  );
  const peer: Peer = {
    label: options.label,
    context,
    codec,
    session,
    events,
    moduleErrors,
    listenerErrors,
    tracks: mic.tracks,
    pendingAir: () => codec.txLog.length,
    takeAir: () => codec.txLog.splice(0, codec.txLog.length),
    texts: () =>
      events
        .filter(
          (event): event is Extract<SessionEvent, { type: "message" }> => event.type === "message",
        )
        .map((event) => event.text),
  };
  createdPeers.push(peer);
  return peer;
}

const MAX_FLUSH_TURNS = 16_000;
const SETTLE_FLOOR_TURNS = 512;

function activity(): string {
  let signature = "";
  for (const peer of createdPeers) {
    signature += [
      peer.session.state,
      peer.session.pairing.kind,
      peer.session.stats.blocksDecoded,
      peer.session.stats.messagesDelivered,
      peer.session.stats.acksSent,
      peer.events.length,
      peer.codec.txLog.length,
      peer.codec.rxQueue.length,
      peer.context.plays,
    ].join(",");
    signature += "|";
  }
  return signature;
}

async function settle(turns = 256): Promise<void> {
  await drainAsync({ activity, floorTurns: turns });
}

async function until(what: string, ready: () => boolean): Promise<void> {
  for (let turn = 0; turn < MAX_FLUSH_TURNS; turn += 1) {
    if (ready()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error(`timed out waiting for ${what}`);
}

function feedChunk(peer: Peer): void {
  roomClock += SAMPLE_FRAME / 48_000;
  peer.context.processors[0]?.onaudioprocess?.({
    inputBuffer: { getChannelData: () => new Float32Array(SAMPLE_FRAME) },
  });
}

async function air(): Promise<void> {
  roomClock += 3;
  await settle();
  await vi.advanceTimersByTimeAsync(3_000);
  await settle();
}

async function deliver(from: Peer, to: Peer): Promise<number> {
  await settle();
  const frames = from.takeAir();
  if (frames.length === 0) return 0;
  to.codec.rxQueue.push(...frames);
  roomClock += 3;
  for (let index = 0; index < frames.length; index += 1) feedChunk(to);
  await settle();
  await vi.advanceTimersByTimeAsync(701);
  await settle();
  return frames.length;
}

async function converse(from: Peer, to: Peer, rounds = 4): Promise<void> {
  for (let round = 0; round < rounds; round += 1) {
    await deliver(from, to);
    await air();
    await deliver(to, from);
    await air();
  }
}

async function pairUp(displayer: Peer, enterer: Peer): Promise<void> {
  displayer.session.start();
  enterer.session.start();
  await converse(enterer, displayer);
  if (displayer.session.pairing.kind !== "paired" || enterer.session.pairing.kind !== "paired") {
    throw new Error(
      `handshake did not complete: ${displayer.session.pairing.kind}/${enterer.session.pairing.kind}`,
    );
  }
  displayer.takeAir();
  enterer.takeAir();
  await settle();
}

async function pairedPair(
  options?: Partial<PeerOptions>,
): Promise<{ displayer: Peer; enterer: Peer }> {
  const displayer = await createPeer({ label: "displayer", role: "displayer", ...options });
  const enterer = await createPeer({
    label: "enterer",
    role: "enterer",
    pairingCode: displayer.session.pairingCode,
  });
  await pairUp(displayer, enterer);
  return { displayer, enterer };
}

let visibility: "visible" | "hidden" = "visible";
let visibilityHandlers: (() => void)[] = [];

function setVisibility(next: "visible" | "hidden"): void {
  visibility = next;
  for (const handler of [...visibilityHandlers]) handler();
}

let decryptGates: { opened: number; release: () => void } | null = null;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  roomClock = 10;
  visibility = "visible";
  visibilityHandlers = [];
  decryptGates = null;
  vi.stubGlobal("document", {
    get visibilityState(): string {
      return visibility;
    },
    addEventListener: (_type: string, handler: () => void): void => {
      visibilityHandlers.push(handler);
    },
    removeEventListener: (): void => {
      visibilityHandlers = [];
    },
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  for (const peer of createdPeers.splice(0)) peer.session.stop();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

/** Collects every unhandled rejection raised while `body` runs. */
async function withRejectionWatch(body: () => Promise<void>): Promise<unknown[]> {
  const rejections: unknown[] = [];
  const listener = (reason: unknown): void => {
    rejections.push(reason);
  };
  process.on("unhandledRejection", listener);
  try {
    await body();
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
  } finally {
    process.off("unhandledRejection", listener);
  }
  return rejections;
}

/**
 * Holds every AES-GCM open until the returned `release` is called, so a block can
 * be caught *inside* `#handleBlock`'s `await this.#wire.parse(block)`. This is
 * the only way to exercise the teardown window the F5 fix claims to close.
 */
function gateDecrypt(): { entered: () => number; release: () => void } {
  let entered = 0;
  let release = (): void => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const real = globalThis.crypto.subtle.decrypt.bind(globalThis.crypto.subtle);
  vi.spyOn(globalThis.crypto.subtle, "decrypt").mockImplementation(async (...args) => {
    entered += 1;
    await gate;
    return real(...args);
  });
  return { entered: () => entered, release };
}

/** A peer-1 codec whose message frame the displayer can be fed directly. */
async function messageFrameFor(text: string, msgId: number): Promise<Uint8Array> {
  const peer = new FrameCodec({
    keys,
    selfId: 1,
    sendSalt: new Uint8Array(16).fill(0x2b),
  });
  const [frame] = await peer.buildMessageFrames(new TextEncoder().encode(text), msgId);
  return frame as Uint8Array;
}

describe("F3 — the error channels cannot poison each other", () => {
  it("keeps handling blocks when both onEvent and onListenerError throw", async () => {
    const { displayer, enterer } = await pairedPair({
      onEvent: (event) => {
        if (event.type === "message" || event.type === "heard-unreadable") {
          throw new Error("consumer bug");
        }
      },
      onListenerError: () => {
        throw new Error("the error reporter is broken too");
      },
    });
    // A real message and a real unreadable block, so both consumer branches fire.
    enterer.session.send("readable");
    await converse(enterer, displayer, 4);
    // The chain is intact: the session is still listening, still paired, and has
    // delivered and counted what the codec handed it.
    expect(displayer.session.state).toBe("listening");
    expect(displayer.session.pairing.kind).toBe("paired");
    expect(displayer.moduleErrors, "a consumer bug is never a module failure").toEqual([]);
    // ...and the fallback reporter really did run: `#reportListenerError` catches
    // the secondary throw and logs it, then logs the original.
    expect(displayer.listenerErrors.length).toBeGreaterThan(0);
  }, 30_000);

  it("never lets a throwing sink make start() or stop() throw", async () => {
    const alone = await createPeer({
      label: "alone",
      role: "displayer",
      pairingCode: CODE,
      onEvent: () => {
        throw new Error("consumer bug");
      },
      onListenerError: () => {
        throw new Error("the error reporter is broken too");
      },
      onModuleError: () => {
        throw new Error("the module reporter is broken too");
      },
    });
    const rejections = await withRejectionWatch(async () => {
      expect(() => alone.session.start(), "start() is a plain call").not.toThrow();
      expect(() => alone.session.stop(), "and so is teardown").not.toThrow();
      expect(() => alone.session.stop()).not.toThrow();
    });
    expect(rejections, "no unhandled rejection escapes the public API").toEqual([]);
  });

  it("keeps a throwing onModuleError from escaping into the audio callback", async () => {
    // P2V RE-VERIFICATION FINDING (new defect). `#reportListenerError` protects
    // the *consumer* channel in turn, but `onModuleError` — the third callback
    // with no contract of its own — is called straight from `#moduleFailed`. The
    // throw then travels out of `#moduleFailed`, out of `#play`'s catch, and out
    // of the `void this.#transmitBlocks(...)` the pump is awaiting, so the pump's
    // promise rejects with the consumer's error and nothing handles it.
    const codec = loopCodec();
    const reported: unknown[] = [];
    const alone = await createPeer({
      label: "dies",
      role: "displayer",
      pairingCode: CODE,
      codec,
      onModuleError: (error) => {
        reported.push(error);
        throw new Error("the module reporter is broken too");
      },
    });
    // Pair the session by hand so the codec only dies on the *message* encode.
    const enterer = await createPeer({
      label: "peer",
      role: "enterer",
      pairingCode: CODE,
    });
    await pairUp(alone, enterer);
    alone.takeAir();
    enterer.takeAir();

    codec.dieOnNextEncode();
    const rejections = await withRejectionWatch(async () => {
      expect(() => alone.session.send("boom")).not.toThrow();
      await settle();
    });
    expect.soft(reported.length, "the module failure was reported").toBe(1);
    expect
      .soft(
        rejections.filter(
          (reason) => reason instanceof Error && /module reporter/.test(String(reason)),
        ),
        "a throwing onModuleError must not reject the pump (P2V re-verification finding)",
      )
      .toEqual([]);
  }, 30_000);
});

describe("F5 — stop() and the async chain", () => {
  it("delivers nothing for a block the chain has not started yet", async () => {
    const { displayer, enterer } = await pairedPair();
    enterer.session.send("in flight");
    await settle();
    const frame = enterer.takeAir()[0];
    if (frame === undefined) throw new Error("expected a transmission");
    enterer.takeAir();
    // The chain has the block but has not looked at it: the `.then` callback is
    // a microtask away, so `stop()` wins.
    displayer.codec.rxQueue.push(frame);
    roomClock += 3;
    feedChunk(displayer);
    displayer.session.stop();
    enterer.session.stop();
    await settle();
    expect(displayer.texts()).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  }, 30_000);

  it("delivers nothing for a block already inside `await parse` (P2V re-verification finding)", async () => {
    // The claim at `session.ts:436` — "Any block already inside the chain is
    // abandoned, so nothing that is still awaiting `crypto.subtle` can deliver
    // to a torn-down consumer afterwards" — is only true for a block that has
    // not yet *entered* `#handleBlock`. `#handleBlock`'s `#stopped` guard is at
    // the top; a block that is already suspended on `parse` runs to completion
    // when the promise resolves, because resetting `#chain` in `stop()` abandons
    // nothing. This drives exactly that window.
    const { displayer, enterer } = await pairedPair();
    const gate = gateDecrypt();
    // A genuine message frame, produced by the peer itself, so there is no
    // doubt that it authenticates: the displayer has already adopted the
    // enterer's salt, so this is the one frame it must accept.
    expect(enterer.session.send("too late").ok).toBe(true);
    // A condition, not a drain. This file already waits on `until(...)` for
    // everything that matters; waiting a fixed number of event-loop turns for
    // the transmission to appear is the one place a bounded drain can be starved
    // under full-suite contention, and it was: 1 failure in 5 full-suite runs
    // while being 4/4 green in isolation (Phase 2V).
    await until("the enterer to put its message on the air", () => enterer.pendingAir() > 0);
    const [frame] = enterer.takeAir();
    if (frame === undefined) throw new Error("no frame on the air");
    await settle();

    displayer.codec.rxQueue.push(frame);
    roomClock += 3;
    feedChunk(displayer);
    // Now the block is inside `#handleBlock`, suspended on the AEAD open.
    await until("the block to reach the AEAD open", () => gate.entered() > 0);
    const decodedBefore = displayer.session.stats.blocksDecoded;
    const deliveredBefore = displayer.texts().length;
    displayer.session.stop();
    enterer.session.stop();
    gate.release();
    await settle();

    expect.soft(decodedBefore, "the block really was inside the chain").toBeGreaterThan(0);
    expect
      .soft(
        displayer.texts().length,
        "a message must not be delivered to a consumer that has torn down (P2V re-verification finding)",
      )
      .toBe(deliveredBefore);
    expect.soft(displayer.texts(), "and no text at all").toEqual([]);
    expect.soft(displayer.session.stats.messagesDelivered, "and nothing was rendered").toBe(0);
    // No timer may be armed after `stop()` either.
    expect.soft(vi.getTimerCount(), "stop() must leave no timer behind").toBe(0);
  }, 30_000);

  it("arms no timer and no listener on any teardown path", async () => {
    const { displayer, enterer } = await pairedPair();
    // Busy on every path at once: an ACK deadline, a quiet timer and a partial
    // ACK are all reachable, and the peer holds its own.
    displayer.session.send("mine");
    await settle();
    enterer.session.send("yours");
    await settle();
    roomClock += 2.5;
    await deliver(enterer, displayer);
    expect(displayer.texts()).toEqual(["yours"]);
    enterer.session.stop();
    const armed = vi.getTimerCount();
    expect(armed, "this test needs timers armed to mean anything").toBeGreaterThan(0);
    displayer.session.stop();
    expect(vi.getTimerCount()).toBe(0);
    expect(visibilityHandlers).toHaveLength(0);
    expect(displayer.context.processors[0]?.onaudioprocess).toBeNull();
    expect(displayer.tracks.every((track) => track.stops > 0)).toBe(true);
    // Stopping twice, and stopping after a module error, release nothing twice.
    displayer.session.stop();
    const nodes = displayer.context.nodesCreated;
    displayer.session.stop();
    expect(displayer.context.nodesCreated).toBe(nodes);
    expect(displayer.context.processors).toHaveLength(1);
  }, 30_000);
});

describe("F6 — a module failure is reported once and owns nothing afterwards", () => {
  it("reports once, keeps no timer, and never reports a pairing failure afterwards", async () => {
    const codec = loopCodec();
    const displayer = await createPeer({
      label: "dies",
      role: "displayer",
      pairingCode: CODE,
      codec,
    });
    const enterer = await createPeer({
      label: "peer",
      role: "enterer",
      pairingCode: CODE,
    });
    await pairUp(displayer, enterer);
    displayer.takeAir();
    enterer.takeAir();
    // The pairing listener is armed with its 90 s window right now; the point of
    // the fix is that a terminal module error must not leave it running.
    expect(displayer.session.pairing.kind).toBe("paired");
    codec.dieOnNextEncode();
    expect(displayer.session.send("boom").ok).toBe(true);
    await settle();
    expect(displayer.session.state).toBe("module_error");
    expect(displayer.moduleErrors, "exactly one report").toHaveLength(1);
    // Zero timers: `pair` included.
    expect(vi.getTimerCount(), "a dead session owns no timers").toBe(0);
    expect(visibilityHandlers, "and no visibility subscription").toHaveLength(0);
    // The mic is released, so no further chunk can re-report.
    expect(displayer.tracks.every((track) => track.stops > 0)).toBe(true);
    const pairingEventsBefore = displayer.events.filter((event) => event.type === "pairing").length;
    const decodedBefore = displayer.session.stats.blocksDecoded;
    // Feed it more audio and let every timer window elapse.
    for (let round = 0; round < 3; round += 1) {
      roomClock += 3;
      feedChunk(displayer);
      await settle();
      await vi.advanceTimersByTimeAsync(120_000);
      await settle();
    }
    expect(displayer.moduleErrors, "still exactly one report").toHaveLength(1);
    expect(
      displayer.events.filter((event) => event.type === "pairing").length,
      "no `pairing: failed` may follow a module error",
    ).toBe(pairingEventsBefore);
    expect(displayer.session.pairing.kind, "and the pairing state is not a failure").not.toBe(
      "failed",
    );
    expect(displayer.session.stats.blocksDecoded, "the feed is really detached").toBe(
      decodedBefore,
    );
    expect(displayer.session.send("after")).toEqual({ ok: false, reason: "module-error" });
  }, 30_000);
});

describe("F8 — a start() that throws", () => {
  it("reaches `error`, reports once, and a retry after the fix works", async () => {
    const mic = mutableStream();
    const moduleErrors: unknown[] = [];
    const alone = await createPeer({
      label: "no-track",
      role: "displayer",
      pairingCode: CODE,
      stream: mic.stream,
      onModuleError: (error) => {
        moduleErrors.push(error);
      },
    });
    // A stream with no audio track: `startListening` refuses it.
    mic.setTracks(0);
    const rejections = await withRejectionWatch(async () => {
      expect(() => alone.session.start()).not.toThrow();
      await settle();
    });
    expect(alone.session.state, "the honest state is `error`, not `listening`").toBe("error");
    expect(moduleErrors, "reported once").toHaveLength(1);
    expect(rejections, "and nothing rejects").toEqual([]);
    expect(alone.context.processors, "no feed was ever attached").toHaveLength(0);
    // `error` leaves only through RESTART.
    expect(alone.session.send("nope")).toEqual({ ok: false, reason: "not-paired" });
    expect(alone.session.restart()).toEqual({ ok: true });
    expect(alone.session.state).toBe("idle");
    // Fix the cause and try again: a real session, listening.
    mic.setTracks(1);
    alone.session.start();
    await settle();
    expect(alone.session.state).toBe("listening");
    expect(alone.context.processors, "and the feed is really attached").toHaveLength(1);
    expect(alone.session.pairing.kind).toBe("waiting-for-peer");
    // The transport history is honest: `error` was reached and left.
    const states = new Set(
      alone.events
        .filter(
          (event): event is Extract<SessionEvent, { type: "transport" }> =>
            event.type === "transport",
        )
        .map((event) => event.state),
    );
    expect(states).toContain("error");
    expect(alone.session.state).toBe("listening");
  }, 30_000);
});

describe("F13 — restart() reports honestly", () => {
  it("refuses every state it cannot leave, and never claims success for a no-op", async () => {
    const { displayer } = await pairedPair();
    // Healthy and listening.
    expect(displayer.session.restart()).toEqual({ ok: false, reason: "not-restartable" });
    expect(displayer.session.state).toBe("listening");
    // Stopped: `start()` is a no-op after `stop()`, so a successful restart would
    // promise something the API cannot deliver.
    displayer.session.stop();
    expect(displayer.session.restart()).toEqual({ ok: false, reason: "not-restartable" });
    // Idle, never started.
    const fresh = await createPeer({ label: "fresh", role: "displayer", pairingCode: CODE });
    expect(fresh.session.restart()).toEqual({ ok: false, reason: "not-restartable" });
    // ...and the refusals change nothing.
    expect(displayer.session.state).toBe("idle");
    expect(fresh.session.state).toBe("idle");
  }, 30_000);

  it("refuses when the codec is dead, and that refusal outranks the state check", async () => {
    const codec = loopCodec();
    const displayer = await createPeer({
      label: "dies",
      role: "displayer",
      pairingCode: CODE,
      codec,
    });
    const enterer = await createPeer({
      label: "peer",
      role: "enterer",
      pairingCode: CODE,
    });
    await pairUp(displayer, enterer);
    displayer.takeAir();
    enterer.takeAir();
    codec.dieOnNextEncode();
    displayer.session.send("boom");
    await settle();
    expect(displayer.session.state).toBe("module_error");
    expect(codec.state, "the codec really is dead").toBe("dead");
    expect(displayer.session.restart()).toEqual({ ok: false, reason: "codec-dead" });
    expect(displayer.session.state, "and the state is untouched").toBe("module_error");
  }, 30_000);
});

describe("the state machine, with `error` now reachable", () => {
  it("reaches only declared states, and `error` only through RECOVERABLE_ERROR", async () => {
    const declared = [
      "idle",
      "listening",
      "transmitting",
      "awaiting_turn",
      "awaiting_ack",
      "backoff",
      "hidden_hold",
      "error",
      "module_error",
    ];
    const { displayer, enterer } = await pairedPeerWithFailingStart();
    displayer.session.start();
    await settle();
    enterer.session.start();
    await converse(enterer, displayer, 4);
    displayer.session.send("mine");
    await converse(displayer, enterer, 8);
    const seen = new Set<string>();
    for (const event of displayer.events) {
      if (event.type === "transport") seen.add(event.state);
    }
    // Nothing outside the declared set is ever published...
    for (const state of seen) {
      expect.soft(declared, `undeclared transport state ${state}`).toContain(state);
    }
    // ...`error` and `idle` are both on the record, so the F8 route is real, and
    // the session ends healthy. (The exact set of message-path states depends on
    // how the two turns interleave, so it is not pinned here: the machine's own
    // table is what `transport-machine.test.ts` enumerates.)
    expect.soft([...seen], "`error` and `idle` are both on the record").toContain("error");
    expect.soft([...seen], "`error` and `idle` are both on the record").toContain("idle");
    expect.soft(displayer.session.state, "and it ends healthy").toBe("listening");
    expect.soft(displayer.session.pairing.kind).toBe("paired");
  }, 30_000);
});

/** A displayer whose first `start()` fails, so `error` is on the record. */
async function pairedPeerWithFailingStart(): Promise<{ displayer: Peer; enterer: Peer }> {
  const mic = mutableStream();
  const displayer = await createPeer({
    label: "flaky-start",
    role: "displayer",
    pairingCode: CODE,
    stream: mic.stream,
  });
  mic.setTracks(0);
  displayer.session.start();
  mic.setTracks(1);
  displayer.session.restart();
  const enterer = await createPeer({
    label: "peer",
    role: "enterer",
    pairingCode: displayer.session.pairingCode,
  });
  return { displayer, enterer };
}

/** MAX_SEND_ATTEMPTS is still three, and the retry budget is unchanged. */
describe("F4 — the attempt budget", () => {
  it("fails a message only after MAX_SEND_ATTEMPTS genuine transmissions", async () => {
    const { displayer, enterer } = await pairedPair();
    displayer.session.send("never answered");
    await settle();
    // Nobody ever hears it: the air is simply never delivered.
    //
    // Both clocks, every round. An ACK timeout and a backoff are wall-clock
    // `setTimeout`s, but the turn each attempt then holds open is the Rx pause on
    // the AudioContext clock, so advancing only the fake timers leaves the session
    // convinced its speaker is still busy and the next attempt is deferred rather
    // than spent — `attempts` stays 0 and this reads as "no more than the budget".
    const attemptCycleMs = 5_540 + 1_200 + BLOCK_DURATION_MS + 500 + 1;
    for (let round = 0; round < MAX_SEND_ATTEMPTS + 2; round += 1) {
      displayer.takeAir();
      roomClock += attemptCycleMs / 1000;
      await vi.advanceTimersByTimeAsync(attemptCycleMs);
      await settle();
    }
    const attempts = Math.max(
      ...displayer.events
        .filter(
          (event): event is Extract<SessionEvent, { type: "outbound" }> =>
            event.type === "outbound",
        )
        .map((event) => event.attempts),
    );
    expect(attempts, "no more than the budget").toBe(MAX_SEND_ATTEMPTS);
    expect(
      displayer.events.some((event) => event.type === "outbound" && event.status === "failed"),
      "and the message is failed, not left hanging",
    ).toBe(true);
    expect(displayer.session.busy, "and the session is free again").toBe(false);
    expect(displayer.session.state).toBe("listening");
    // The peer really did receive nothing it could resolve.
    expect(enterer.texts()).toEqual([]);
  }, 60_000);
});
