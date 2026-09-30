/**
 * Phase 3V residual D4 — `#moduleFailed` does not set `#stopped`.
 *
 * WHY the session and not the controller: the defect lives entirely in
 * `sound-chat-session.ts`'s `#pump` post-`await` guard, which reads `#stopped`.
 * `deep-p3b-machine.test.ts` measured the *consequence* at the controller (a
 * frozen `busy`), and `deep-p3b-acoustic.test.ts` B-4 measured it through the
 * real stack, but neither can see whether `#transmitBlocks` reached `#play` with
 * a null `#listen`, because that decision is made inside the session. So this
 * file drives `SoundChatSession` directly, with the real `FrameCodec`, real
 * crypto and a loop codec standing in for ggwave — the same seam
 * `deep-verify-pump-queue.test.ts` uses, and the only one that can hold
 * `#pump` inside `buildMessageFrames` and watch what it does on the way out.
 *
 * `MEASURED` tests pass against the working tree. `PIN` tests pin the fixed
 * behaviour and are expected to fail until the fix lands.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SoundChatCodec } from "../codec";
import { MAX_PENDING_MESSAGES, SoundChatSession, TURN_GAP_MS } from "../session";
import type { SessionEvent } from "../session";

const SAMPLE_FRAME = 1024;
const CODE = "ABCD2345";
let roomClock = 10;

/**
 * The 64-byte wire frames the session handed to `encode`, in transmission order.
 * `failNextDecode` is the whole-module death: `audio-io.ts` reports anything
 * `codec.decode` throws on `onModuleError`, which is `#moduleFailed`.
 */
type LoopCodec = {
  state: string;
  readonly txLog: Uint8Array[];
  readonly rxQueue: Uint8Array[];
  failNextDecode: boolean;
  encode(payload: Uint8Array): Float32Array;
  decode(): Uint8Array | null;
};

function loopCodec(): LoopCodec {
  const txLog: Uint8Array[] = [];
  const rxQueue: Uint8Array[] = [];
  const audio = new Float32Array(SAMPLE_FRAME);
  const codec: LoopCodec = {
    state: "ready",
    txLog,
    rxQueue,
    failNextDecode: false,
    encode(payload: Uint8Array): Float32Array {
      if (payload.length === 0 || payload.length > 64) throw new Error("misuse");
      txLog.push(Uint8Array.from(payload));
      return audio;
    },
    decode(): Uint8Array | null {
      if (codec.failNextDecode) {
        codec.failNextDecode = false;
        throw new Error("the wasm module is gone");
      }
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
  /** Every `createBufferSource().start()` — i.e. every block really on the air. */
  plays = 0;

  get currentTime(): number {
    return roomClock;
  }

  createMediaStreamSource(): { connect: () => void; disconnect: () => void } {
    return { connect: (): void => {}, disconnect: (): void => {} };
  }
  createScriptProcessor(size: number): FakeProcessor {
    if (size !== SAMPLE_FRAME) throw new Error(`unexpected processor shape ${size}`);
    const processor: FakeProcessor = {
      onaudioprocess: null,
      connect: (): void => {},
      disconnect: (): void => {},
    };
    this.processors.push(processor);
    return processor;
  }
  createGain(): { gain: { value: number }; connect: () => void; disconnect: () => void } {
    return { gain: { value: 0 }, connect: (): void => {}, disconnect: (): void => {} };
  }
  createBuffer(
    _channels: number,
    length: number,
  ): {
    copied: Float32Array[];
    copyToChannel: (samples: Float32Array) => void;
  } {
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
      start: (): void => {
        this.plays += 1;
      },
      connect: () => source,
    };
    return source;
  };
  async resume(): Promise<unknown> {
    return this;
  }
  async close(): Promise<void> {
    this.state = "closed";
  }
}

function mockStream(): MediaStream {
  const tracks = [{ stop: (): void => {} }];
  return { getAudioTracks: () => tracks, getTracks: () => tracks } as unknown as MediaStream;
}

type Peer = {
  readonly context: FakeAudioContext;
  readonly codec: LoopCodec;
  readonly session: SoundChatSession;
  readonly events: SessionEvent[];
  readonly moduleErrors: unknown[];
  readonly listenerErrors: unknown[];
  outboundEvents: () => Extract<SessionEvent, { type: "outbound" }>[];
  transportStates: () => string[];
  takeAir: () => Uint8Array[];
};

async function createPeer(role: "displayer" | "enterer", code?: string): Promise<Peer> {
  const context = new FakeAudioContext();
  const codec = loopCodec();
  const events: SessionEvent[] = [];
  const moduleErrors: unknown[] = [];
  const listenerErrors: unknown[] = [];
  const base = {
    codec: codec as unknown as SoundChatCodec,
    context: context as unknown as AudioContext,
    stream: mockStream(),
    role,
    onEvent: (event: SessionEvent): void => {
      events.push(event);
    },
    onListenerError: (error: unknown): void => {
      listenerErrors.push(error);
    },
    onModuleError: (error: unknown): void => {
      moduleErrors.push(error);
    },
  };
  const session = await SoundChatSession.create(
    code === undefined ? base : { ...base, pairingCode: code },
  );
  return {
    context,
    codec,
    session,
    events,
    moduleErrors,
    listenerErrors,
    outboundEvents: () =>
      events.filter(
        (event): event is Extract<SessionEvent, { type: "outbound" }> => event.type === "outbound",
      ),
    transportStates: () =>
      events
        .filter(
          (event): event is Extract<SessionEvent, { type: "transport" }> =>
            event.type === "transport",
        )
        .map((event) => event.state),
    takeAir: () => codec.txLog.splice(0, codec.txLog.length),
  };
}

const MAX_FLUSH_TURNS = 16_000;
const SETTLE_FLOOR_TURNS = 512;

function activity(peers: readonly Peer[]): string {
  return peers
    .map((peer) =>
      [
        peer.session.state,
        peer.session.pairing.kind,
        peer.session.busy,
        peer.events.length,
        peer.codec.txLog.length,
        peer.context.plays,
      ].join(","),
    )
    .join("|");
}

const live: Peer[] = [];

async function settle(): Promise<void> {
  let quiet = 0;
  let turn = 0;
  while (turn < SETTLE_FLOOR_TURNS || quiet < 32) {
    if (turn >= MAX_FLUSH_TURNS) throw new Error("the async chain never settled");
    const before = activity(live);
    await new Promise((resolve) => setImmediate(resolve));
    quiet = activity(live) === before ? quiet + 1 : 0;
    turn += 1;
  }
}

/**
 * Waits on *real* time, not on faked ones.
 *
 * `vi.useFakeTimers` has claimed `setTimeout`, and the first message on a
 * session waits for `PairingKeys.directionKey` — a 600 000-iteration PBKDF2 in
 * the libuv threadpool, which takes real wall-clock time. Spinning a fixed
 * number of `setImmediate` turns reaches that callback only by luck, so this
 * spins until a real deadline while still yielding to the event loop.
 */
async function until(what: string, ready: () => boolean): Promise<void> {
  const deadline = Date.now() + 4_000;
  while (Date.now() < deadline) {
    if (ready()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error(`timed out waiting for ${what}`);
}

function feedChunk(peer: Peer): void {
  roomClock += SAMPLE_FRAME / 48_000;
  // The *newest* processor: `startListening` builds one per `start()`, and a
  // released feed leaves its processor with `onaudioprocess === null` behind.
  const processors = peer.context.processors;
  processors[processors.length - 1]?.onaudioprocess?.({
    inputBuffer: { getChannelData: () => new Float32Array(SAMPLE_FRAME) },
  });
}

async function air(): Promise<void> {
  roomClock += 3;
  await settle();
  await vi.advanceTimersByTimeAsync(TURN_GAP_MS + 1);
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
  await vi.advanceTimersByTimeAsync(TURN_GAP_MS + 1);
  await settle();
  return frames.length;
}

async function converse(from: Peer, to: Peer, rounds = 8): Promise<void> {
  for (let round = 0; round < rounds; round += 1) {
    await deliver(from, to);
    await air();
    await deliver(to, from);
    await air();
  }
}

/**
 * Holds `crypto.subtle.encrypt`, which is the one `await` inside
 * `FrameCodec.buildMessageFrames` — the point at which `#pump` owns the queue
 * and has published nothing. `vi.unstubAllGlobals()` puts the real one back.
 */
type SealGate = { entered: () => boolean; release: () => void };

function gateSeal(): SealGate {
  const real = globalThis.crypto;
  let entered = false;
  let open: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    open = resolve;
  });
  const subtle = new Proxy(real.subtle, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      if (property === "encrypt") {
        return async (...args: unknown[]) => {
          entered = true;
          await gate;
          return Reflect.apply(value as (...a: unknown[]) => unknown, target, args);
        };
      }
      return typeof value === "function"
        ? (value as (...a: unknown[]) => unknown).bind(target)
        : value;
    },
  });
  vi.stubGlobal(
    "crypto",
    new Proxy(real, {
      get(target, property) {
        if (property === "subtle") return subtle;
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }),
  );
  return { entered: () => entered, release: open };
}

beforeEach(() => {
  roomClock = 10;
  live.length = 0;
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
  vi.stubGlobal("document", {
    visibilityState: "visible",
    addEventListener: (): void => {},
    removeEventListener: (): void => {},
  });
});

afterEach(() => {
  for (const peer of live.splice(0)) peer.session.stop();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

async function pairedPair(): Promise<{ readonly displayer: Peer; readonly enterer: Peer }> {
  const displayer = await createPeer("displayer", CODE);
  const enterer = await createPeer("enterer", CODE);
  live.push(displayer, enterer);
  displayer.session.start();
  enterer.session.start();
  await converse(enterer, displayer, 4);
  await converse(displayer, enterer, 1);
  if (displayer.session.pairing.kind !== "paired" || enterer.session.pairing.kind !== "paired") {
    throw new Error(
      `handshake did not complete: ${displayer.session.pairing.kind}/${enterer.session.pairing.kind}`,
    );
  }
  displayer.takeAir();
  enterer.takeAir();
  await settle();
  // Warm `PairingKeys.directionKey` for both directions. The first *message* on
  // a session derives a per-direction key with a real 600 000-iteration PBKDF2
  // in the libuv threadpool, which no number of fake-timer turns can outwait.
  // Pairing alone only ever derives the MAC key, so without this every scenario
  // that sends a note pays the derivation inside its own `until`.
  for (const [from, to] of [
    [enterer, displayer],
    [displayer, enterer],
  ] as const) {
    from.session.send("warm the key");
    await until("the warm-up note to be claimed", () => from.outboundEvents().length > 0);
    // Both sides must be back to `listening`: a session left in `awaiting_ack`
    // still owns `#outbound`, and `#pump` refuses to claim anything behind it.
    for (let round = 0; round < 8; round += 1) {
      if (from.session.state === "listening" && to.session.state === "listening") break;
      await deliver(from, to);
      await air();
      await deliver(to, from);
      await air();
    }
    expect(from.session.state, "the warm-up left a session mid-note").toBe("listening");
    expect(to.session.state, "the warm-up left the peer mid-note").toBe("listening");
    from.takeAir();
    to.takeAir();
    await air();
  }
  await settle();
  expect(displayer.session.state).toBe("listening");
  expect(enterer.session.state).toBe("listening");
  return { displayer, enterer };
}

/* ================================================================== *
 * D4.1 — MEASUREMENT.
 * ================================================================== */

describe("D4.1 MEASUREMENT: what a module death actually leaves behind", () => {
  it("MEASURED: `#moduleFailed` empties the queue and clears every timer it owns", async () => {
    const { displayer } = await pairedPair();
    const quiet = vi.getTimerCount();
    displayer.session.send("something to arm an ack timer with");
    await until("the ack window to open", () => displayer.session.state === "awaiting_ack");
    const withAck = vi.getTimerCount();
    expect(withAck, "an ack timer is armed").toBeGreaterThan(quiet);
    await air();
    displayer.codec.failNextDecode = true;
    feedChunk(displayer);
    await settle();
    expect(displayer.session.state).toBe("module_error");
    expect(
      vi.getTimerCount(),
      "a timer of the dead session outlived its terminal failure",
    ).toBeLessThanOrEqual(quiet);
  });

  it("MEASURED: the Rx feed IS released, so nothing new can reach `#handleBlock`", async () => {
    // `#moduleFailed` calls `#listen?.stop()`, and `startListening`'s own
    // `stop()` sets `processor.onaudioprocess = null`. So after a module death
    // the microphone really is dead. This is the Phase 2V release doing its job,
    // and it is why the `#handleBlock` half of this residual is much narrower
    // than the pump half.
    const { displayer, enterer } = await pairedPair();
    displayer.codec.failNextDecode = true;
    feedChunk(displayer);
    await settle();
    expect(displayer.session.state).toBe("module_error");
    const decodedAtDeath = displayer.session.stats.blocksDecoded;
    const playsAtDeath = displayer.context.plays;

    enterer.session.send("for a session whose codec is gone");
    for (let round = 0; round < 6; round += 1) {
      await deliver(enterer, displayer);
      await air();
    }
    expect(displayer.session.stats.blocksDecoded, "a dead microphone decoded").toBe(decodedAtDeath);
    expect(displayer.context.plays, "a dead session played something").toBe(playsAtDeath);
  });

  it("MEASURED: a block already inside #chain is still processed after the death", async () => {
    // `#chain` is only reset by `stop()`, so a frame already dispatched into it
    // before the death is processed after it. `#handleBlock`'s first line and its
    // post-`await` re-check both read `#stopped`, and `#moduleFailed` never set it.
    const { displayer, enterer } = await pairedPair();
    const probe = enterer.session.send("a note in flight while the module dies");
    expect(probe, "the enterer refused the probe note").toMatchObject({ ok: true });
    await until("the note to be claimed", () => enterer.outboundEvents().length > 0);
    await settle();
    // One real block goes onto the queue, then the trigger, in the same
    // synchronous run: the first block is inside `#chain` (awaiting
    // `crypto.subtle.decrypt`) when the second one kills the module.
    displayer.codec.rxQueue.push(...enterer.takeAir());
    feedChunk(displayer);
    displayer.codec.failNextDecode = true;
    feedChunk(displayer);
    await settle();
    expect(displayer.session.state).toBe("module_error");
    expect(
      displayer.session.stats.blocksDecoded,
      "the block already inside #chain was dropped",
    ).toBeGreaterThan(0);
  });

  it("MEASURED: `#moduleFailed` is idempotent, so nothing above happens twice", async () => {
    const { displayer } = await pairedPair();
    displayer.codec.failNextDecode = true;
    feedChunk(displayer);
    await settle();
    displayer.codec.failNextDecode = true;
    feedChunk(displayer);
    await settle();
    expect(displayer.moduleErrors, "a terminal failure reported twice").toHaveLength(1);
    expect(
      displayer.transportStates().filter((state) => state === "module_error"),
      "the machine entered module_error twice",
    ).toHaveLength(1);
  });

  it("MEASURED: `send()` after a module death still refuses, with the module's reason", async () => {
    const { displayer } = await pairedPair();
    displayer.codec.failNextDecode = true;
    feedChunk(displayer);
    await settle();
    // `#stopped` is false after a module death (the working tree at HEAD), so
    // `send()`'s first guard does not fire and the `codec.state` guard is what
    // refuses. `refusal["module-error"]` is "The sound codec stopped working." —
    // the true cause. `refusal["stopped"]` is "Sound Chat has stopped." — vaguer,
    // and it would send the person to a different fix.
    displayer.codec.state = "closed";
    expect(displayer.session.send("after")).toEqual({ ok: false, reason: "module-error" });
    displayer.codec.state = "ready";
  });

  it("MEASURED: a real `stop()` is indistinguishable from a module death to `send()`", async () => {
    const { displayer } = await pairedPair();
    displayer.session.stop();
    expect(displayer.session.send("after")).toEqual({ ok: false, reason: "stopped" });
    const before = displayer.session.state;
    displayer.session.start();
    expect(displayer.session.state, "`stop()` was never a one-way latch").toBe(before);
  });
});

/* ================================================================== *
 * D4.2 — FIXED BEHAVIOUR. A module death is terminal for every async
 * chain the session owns.
 * ================================================================== */

describe("D4.2 FIXED BEHAVIOUR: a module death is terminal for the pump", () => {
  it("PIN: no `outbound` event is published after a terminal failure", async () => {
    const { displayer } = await pairedPair();
    const gate = gateSeal();
    displayer.session.send("in flight when the codec dies");
    await until("the seal to start", () => gate.entered());
    displayer.codec.failNextDecode = true;
    feedChunk(displayer);
    await settle();
    // Everything published *before* the death is legitimate; everything after is
    // not, and the D1 fix means the pre-death list is no longer empty (the note
    // has a `queued` row from the moment `send()` accepted it).
    const atDeath = displayer.outboundEvents().length;
    gate.release();
    await settle();
    // After the death the only status the session may publish is `failed` — the
    // D1 fix's `#moduleFailed` loop retires every still-queued submission, and
    // that is exactly right. What it must never publish is `queued` (the note is
    // not going out, so a "waiting" row would be a lie) or `sending`.
    expect(
      displayer
        .outboundEvents()
        .slice(atDeath)
        .map((event) => event.status),
      "a dead session published something other than `failed`",
    ).not.toContain("queued");
    expect(displayer.session.busy, "`busy` is stuck true for the page session").toBe(false);
  });

  it("a dead session delivers nothing, and counts only what arrived before it died", async () => {
    // REWRITTEN IN PHASE 3V, not inverted.
    //
    // This test was written as a pin for the claim that "a block already inside
    // `#chain` when the codec dies is still parsed, counted and reported". The
    // *reporting* half was real and is now closed: `#moduleFailed` resets
    // `#chain` exactly as `stop()` does, and `#handleBlock`'s post-`await`
    // `#stopped` guard suppresses every delivery. The *counting* half was not a
    // defect at all, and asserting it zero made this test red against correct
    // code: a block that was genuinely decoded before the codec died is a block
    // that was decoded, and `blocksDecoded` saying so is the honest number. The
    // test also counted the four internal decode attempts of the loop that was
    // failing, which are not blocks.
    //
    // So the invariant worth pinning is the one that can actually be violated: a
    // dead session must not report a note to its consumer, and must not report
    // anything at all, however long the threadpool takes.
    const { displayer, enterer } = await pairedPair();
    const probe = enterer.session.send("a note in flight while the module dies");
    expect(probe, "the enterer refused the probe note").toMatchObject({ ok: true });
    await until("the note to be claimed", () => enterer.outboundEvents().length > 0);
    await settle();
    displayer.codec.rxQueue.push(...enterer.takeAir());
    feedChunk(displayer);
    displayer.codec.failNextDecode = true;
    feedChunk(displayer);
    await settle();
    expect(displayer.session.state).toBe("module_error");
    // The invariant that can actually be violated: nothing is delivered *after*
    // the failure is observed. A block that was genuinely decoded before the
    // codec died is delivered before it, and that is correct — the alternative
    // assertion (that the total is zero) is red against honest accounting and was
    // the mistake in the first version of this test.
    const delivered = displayer.events.filter(
      (event) => event.type === "message" || event.type === "heard-unreadable",
    );
    const atDeath = displayer.events.length;
    await vi.advanceTimersByTimeAsync(30_000);
    await settle();
    expect(
      displayer.events
        .slice(atDeath)
        .filter((event) => event.type === "message" || event.type === "heard-unreadable"),
      "a dead session reported a note to its consumer after its failure",
    ).toEqual([]);
    expect(
      delivered.filter((event) => event.type === "heard-unreadable"),
      "and reported an unreadable block after its failure",
    ).toEqual([]);
    expect(displayer.events.length, "and kept publishing after its failure").toBe(atDeath);
  });

  it("PIN: nothing arrives late, however long the threadpool takes", async () => {
    const { displayer } = await pairedPair();
    const gate = gateSeal();
    displayer.session.send("in flight");
    await until("the seal to start", () => gate.entered());
    displayer.codec.failNextDecode = true;
    feedChunk(displayer);
    await settle();
    gate.release();
    await settle();
    const eventsAfterDeath = displayer.events.length;
    await settle();
    await vi.advanceTimersByTimeAsync(30_000);
    await settle();
    expect(displayer.events.length, "a dead session kept publishing events after its failure").toBe(
      eventsAfterDeath,
    );
  });
});

/* ================================================================== *
 * D4.3 — the anti-over-correction pins. These hold whichever internal
 * shape the fix takes, and they are what "do not break `restart()`"
 * means concretely.
 * ================================================================== */

describe("D4.3 FIXED BEHAVIOUR: the fix must not break `restart()`", () => {
  it("PIN: `restart()` still recovers the session into a hearing one", async () => {
    const { displayer, enterer } = await pairedPair();
    displayer.codec.failNextDecode = true;
    feedChunk(displayer);
    await settle();
    expect(displayer.session.state).toBe("module_error");
    expect(displayer.session.restart()).toEqual({ ok: true });
    expect(displayer.session.state).toBe("idle");
    // `restart()` is documented as `module_error -> idle` with no teardown, so
    // `start()` must still work afterwards. If a fix had made `#stopped` mean
    // "terminal" without also clearing it in `restart()`, `start()`'s first line
    // would silently no-op and the session would be deaf for ever: no feed is
    // re-armed, so no block is decoded and pairing never completes.
    displayer.session.start();
    expect(displayer.session.state).toBe("listening");
    await converse(enterer, displayer, 4);
    await converse(displayer, enterer, 1);
    expect(
      displayer.session.pairing.kind,
      "`restart()` left a session that cannot hear anything",
    ).toBe("paired");
  });

  it("PIN: a second module failure in the same page is still reported", async () => {
    const { displayer } = await pairedPair();
    displayer.codec.failNextDecode = true;
    feedChunk(displayer);
    await settle();
    expect(displayer.moduleErrors).toHaveLength(1);
    expect(displayer.session.restart()).toEqual({ ok: true });
    displayer.session.start();
    displayer.codec.failNextDecode = true;
    feedChunk(displayer);
    await settle();
    expect(
      displayer.moduleErrors,
      "the second terminal failure was swallowed by the report latch",
    ).toHaveLength(2);
    expect(displayer.session.state).toBe("module_error");
  });

  it("PIN: `send()` after a module death still refuses with `module-error`", async () => {
    const { displayer } = await pairedPair();
    displayer.codec.failNextDecode = true;
    feedChunk(displayer);
    await settle();
    displayer.codec.state = "closed";
    expect(displayer.session.send("after")).toEqual({ ok: false, reason: "module-error" });
  });

  it("PIN: the queue bound is unchanged by any of this", () => {
    expect(MAX_PENDING_MESSAGES).toBe(4);
  });
});
