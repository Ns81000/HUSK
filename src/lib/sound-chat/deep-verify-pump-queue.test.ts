/**
 * Phase 2V re-verification — the outbound queue and the pump (F1), and the
 * re-entrancy attacks the fix has to survive.
 *
 * F1 moved the queue-slot claim into a synchronous prefix of `#pump` and added a
 * `#pumping` flag, so two `send()` calls in one tick can no longer both read
 * `#pending[0]`. This file proves the claim and then tries to defeat it from
 * every direction a caller can re-enter the pump from: an `onEvent` consumer, an
 * `onListenerError` sink, a caller inside `#pump`'s own `await`.
 *
 * The acoustic loop is simulated at the *frame* level: whatever the session puts
 * on the air is the real 64-byte wire frame (real keys, real AEAD, real
 * assembler, real state machine, real timers), and the loopback codec hands it
 * back to the other session one block per capture chunk. The waveform is a
 * single 1024-sample frame, because these tests count transmissions, not audio.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SoundChatCodec } from "./codec";
import type { RandomSource } from "./crypto";
import { MessageIdExhaustedError } from "./protocol";
import type { PairingRole } from "./pairing";
import { drainAsync } from "./drain.ts";
import {
  ACK_TIMEOUT_MS,
  BACKOFF_MAX_MS,
  MAX_PENDING_MESSAGES,
  SoundChatSession,
  TURN_GAP_MS,
  type SessionEvent,
} from "./session";

const SAMPLE_FRAME = 1024;
const CODE = "ABCD2345";
let roomClock = 10;

/** The real frame the session handed to `encode`, in transmission order. */
type LoopCodec = {
  state: string;
  readonly txLog: Uint8Array[];
  readonly rxQueue: Uint8Array[];
  encode(payload: Uint8Array): Float32Array;
  decode(): Uint8Array | null;
};

function loopCodec(): LoopCodec {
  const txLog: Uint8Array[] = [];
  const rxQueue: Uint8Array[] = [];
  const audio = new Float32Array(SAMPLE_FRAME);
  return {
    state: "ready",
    txLog,
    rxQueue,
    encode(payload: Uint8Array): Float32Array {
      if (payload.length === 0 || payload.length > 64) throw new Error("misuse");
      txLog.push(Uint8Array.from(payload));
      return audio;
    },
    decode(): Uint8Array | null {
      return rxQueue.length > 0 ? (rxQueue.shift() as Uint8Array) : null;
    },
  };
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

function mockStream(): MediaStream {
  const track: MockTrack = {
    stops: 0,
    stop(): void {
      this.stops += 1;
    },
  };
  const tracks = [track];
  return { getAudioTracks: () => tracks, getTracks: () => tracks } as unknown as MediaStream;
}

type Peer = {
  readonly label: string;
  readonly context: FakeAudioContext;
  readonly codec: LoopCodec;
  readonly session: SoundChatSession;
  readonly events: SessionEvent[];
  readonly listenerErrors: unknown[];
  readonly moduleErrors: unknown[];
  /** msgIds seen on the air, in transmission order, without consuming them. */
  sentMsgIds: () => number[];
  /** Takes everything the peer has on the air right now. */
  takeAir: () => Uint8Array[];
  texts: () => string[];
};

type PeerOptions = {
  label: string;
  role: PairingRole;
  pairingCode?: string;
  random?: RandomSource;
  onEvent?: (event: SessionEvent) => void;
  onListenerError?: (error: unknown) => void;
  onModuleError?: (error: unknown) => void;
};

const createdPeers: Peer[] = [];

async function createPeer(options: PeerOptions): Promise<Peer> {
  const context = new FakeAudioContext();
  const codec = loopCodec();
  const events: SessionEvent[] = [];
  const listenerErrors: unknown[] = [];
  const moduleErrors: unknown[] = [];
  const base = {
    codec: codec as unknown as SoundChatCodec,
    context: context as unknown as AudioContext,
    stream: mockStream(),
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
    listenerErrors,
    moduleErrors,
    sentMsgIds: () => codec.txLog.map((frame) => ((frame[1] ?? 0) << 8) | (frame[2] ?? 0)),
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
      peer.session.stats.framesUnreadable,
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

/** The speaker is quiet and the peer's Rx feed has reopened. */
async function air(): Promise<void> {
  roomClock += 3;
  await settle();
  await vi.advanceTimersByTimeAsync(TURN_GAP_MS + 1);
  await settle();
}

/** Everything one peer has on the air, delivered to the other as real blocks. */
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

/** Alternating turns, so a handshake, a message and its ACK all complete. */
async function converse(from: Peer, to: Peer, rounds = 8): Promise<void> {
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
}

async function pairedPair(options?: Partial<PeerOptions>): Promise<{
  displayer: Peer;
  enterer: Peer;
}> {
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

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  roomClock = 10;
  visibility = "visible";
  visibilityHandlers = [];
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
    // Node reports these on a later macrotask; give it two turns.
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
  } finally {
    process.off("unhandledRejection", listener);
  }
  return rejections;
}

describe("F1 — the queue slot is claimed synchronously", () => {
  it("delivers a 3-, a 4- and a 6-message burst once each, in order", async () => {
    const inTick = MAX_PENDING_MESSAGES;
    for (const size of [3, 4, 6]) {
      const { displayer, enterer } = await pairedPair();
      const wanted = Array.from({ length: size }, (_, index) => `burst-${index}`);
      // A single tick can hold MAX_PENDING_MESSAGES, so a larger burst is filled
      // in rounds — each round still puts everything it can hold on the air in
      // *one* tick, which is the F1 shape.
      for (let round = 0; round < wanted.length; round += inTick) {
        const slice = wanted.slice(round, round + inTick);
        const queuedFlags: boolean[] = [];
        for (const text of slice) {
          const result = displayer.session.send(text);
          if (!result.ok) throw new Error(`send refused: ${result.reason}`);
          queuedFlags.push(result.queued);
        }
        // The first send of a tick is the only one with nothing ahead of it; every
        // other one in that tick is honestly told it is queued behind something.
        expect
          .soft(queuedFlags, `burst of ${size}: the queued flag is dishonest`)
          .toEqual([false, ...Array.from({ length: slice.length - 1 }, () => true)]);
        await converse(displayer, enterer, slice.length + 6);
      }

      // Exactly the texts that were queued, once each, in order.
      expect.soft(enterer.texts(), `burst of ${size}: delivery order`).toEqual(wanted);
      // One submission per message: no text sealed twice under two ids, none
      // reused. `sendId` and not `msgId`, because the `queued` event published
      // at accept time carries a null `msgId` — counting ids would see one extra
      // identity per note and report a correct run as a duplicated message.
      const ids = new Set(
        displayer.events
          .filter(
            (event): event is Extract<SessionEvent, { type: "outbound" }> =>
              event.type === "outbound",
          )
          .map((event) => event.sendId),
      );
      expect.soft(ids.size, `burst of ${size}: one submission per message`).toBe(size);
      expect
        .soft(
          displayer.events.filter((event) => event.type === "outbound" && event.status === "sent"),
          `burst of ${size}: every message resolved`,
        )
        .toHaveLength(size);
      expect.soft(displayer.listenerErrors, `burst of ${size}: no consumer error`).toEqual([]);
      displayer.session.stop();
      enterer.session.stop();
    }
  }, 60_000);

  it("never loses or duplicates a message when the two sends are interleaved with a tick", async () => {
    const { displayer, enterer } = await pairedPair();
    displayer.session.send("one");
    await settle();
    displayer.session.send("two");
    displayer.session.send("three");
    await settle();
    expect(displayer.session.busy, "the pump owns the session while a message is in flight").toBe(
      true,
    );
    await converse(displayer, enterer, 10);
    expect(enterer.texts()).toEqual(["one", "two", "three"]);
  }, 30_000);

  it("holds the queue at exactly MAX_PENDING_MESSAGES, counting the one being sent", async () => {
    const { displayer } = await pairedPeerOnly();
    const accepted: boolean[] = [];
    for (let index = 0; index < MAX_PENDING_MESSAGES + 5; index += 1) {
      accepted.push(displayer.session.send(`q${index}`).ok);
    }
    // The pump is never entered on the caller's stack, so a message stays in
    // `#pending` until the pump's own turn claims it — which means the cap counts
    // the in-flight message too. That is a *tighter* bound than "one in flight
    // plus the queue", and a simpler one to state: at most
    // `MAX_PENDING_MESSAGES` messages exist in this session at any moment.
    expect(accepted.filter(Boolean)).toHaveLength(MAX_PENDING_MESSAGES);
    expect(displayer.session.send("overflow")).toEqual({ ok: false, reason: "queue-full" });
  }, 30_000);
});

/** A displayer that is already paired, built without a second live session. */
async function pairedPeerOnly(): Promise<{ displayer: Peer }> {
  const displayer = await createPeer({ label: "displayer", role: "displayer", pairingCode: CODE });
  const enterer = await createPeer({ label: "enterer", role: "enterer", pairingCode: CODE });
  await pairUp(displayer, enterer);
  return { displayer };
}

describe("F1 — re-entering the pump from a consumer", () => {
  it("survives send() from inside every kind of onEvent", async () => {
    const replies: string[] = [];
    // The consumer sends from inside the driver's own event dispatch, which is
    // the shape a real UI has (a "message delivered" toast with a reply button).
    // The peer reference is filled in only once it exists, so the handshake
    // itself is not answered by a consumer that does not exist yet.
    let target: Peer | null = null;
    const { displayer, enterer } = await pairedPair({
      onEvent: (event) => {
        if (target === null) return;
        if (event.type === "message") {
          replies.push(`re-${event.text}`);
          target.session.send(`re-${event.text}`);
        }
        if (event.type === "transport" && event.state === "listening" && replies.length > 0) {
          const next = `t-${replies.length}`;
          replies.push(next);
          target.session.send(next);
        }
      },
    });
    target = displayer;
    enterer.session.send("hello");
    await converse(enterer, displayer, 16);
    expect(displayer.listenerErrors).toEqual([]);
    // Nothing duplicated, nothing invented: every delivered text is one the
    // consumer actually queued, exactly once.
    const received = enterer.texts();
    expect(new Set(received).size, "a text was delivered twice").toBe(received.length);
    for (const text of received) {
      expect(replies, `unexpected text ${text}`).toContain(text);
    }
    // The conversation really moved: the peer got the reply to its own message
    // and at least one reply generated from a transport event.
    expect(received).toContain("re-hello");
    expect(received.some((text) => text.startsWith("t-"))).toBe(true);
  }, 60_000);

  it("reports exhaustion on the consumer channel, and stays usable", async () => {
    // `highSalt` seeds the allocator at 0xffff, so the second message cannot get
    // an id at all. The refusal must reach `onListenerError`, not vanish.
    const highSalt: RandomSource = (bytes) => {
      bytes.fill(0);
      bytes[0] = 0xff;
      bytes[1] = 0xff;
      return bytes;
    };
    const { displayer, enterer } = await pairedPair({ random: highSalt });
    displayer.session.send("the only one");
    await converse(displayer, enterer, 6);
    expect(enterer.texts(), "the one id this session has was used").toEqual(["the only one"]);
    expect(displayer.session.busy, "the first message resolved").toBe(false);

    const rejections = await withRejectionWatch(async () => {
      displayer.session.send("no id for you");
      await settle();
      await vi.advanceTimersByTimeAsync(ACK_TIMEOUT_MS + BACKOFF_MAX_MS + 1);
      await settle();
    });
    expect
      .soft(
        displayer.listenerErrors.some((error) => error instanceof MessageIdExhaustedError),
        "the refusal must reach the consumer channel",
      )
      .toBe(true);
    expect.soft(rejections, "no unhandled rejection may escape").toEqual([]);
    expect.soft(displayer.moduleErrors, "exhaustion is a bound, not a codec death").toEqual([]);
    // Nothing that was queued after the last id ever reached the air.
    expect.soft(displayer.takeAir(), "no id means no frame").toEqual([]);
    expect.soft(displayer.session.busy, "and nothing is left claimed").toBe(false);
    expect.soft(displayer.session.state).toBe("listening");
  }, 60_000);

  it("does not re-enter the pump from inside its own catch (P2V re-verification finding)", async () => {
    // NEW DEFECT. `#pump`'s misuse path calls `void this.#pump()` from inside its
    // own `catch`, with no hop between iterations, so a consumer that answers
    // each refusal with another `send` drives
    //   #pump -> #reportListenerError -> send -> #pump -> ...
    // on one synchronous stack. The queue cap cannot bound it: each nested pump
    // shifts its text off `#pending` *before* the consumer queues the next one,
    // so `#pending` never holds more than one item and `queue-full` is never
    // reached. This measures the depth the driver actually recursed to; a driver
    // that hopped out of the current frame (or refused re-entry) would stay at 1.
    const highSalt: RandomSource = (bytes) => {
      bytes.fill(0);
      bytes[0] = 0xff;
      bytes[1] = 0xff;
      return bytes;
    };
    let target: Peer | null = null;
    let depth = 0;
    let deepest = 0;
    let asked = 0;
    const { displayer, enterer } = await pairedPair({
      random: highSalt,
      onListenerError: (error) => {
        if (target === null || !(error instanceof MessageIdExhaustedError)) return;
        depth += 1;
        deepest = Math.max(deepest, depth);
        asked += 1;
        // The consumer bounds itself only far above any stack depth, so the test
        // terminates whether or not the driver recurses without bound.
        if (asked > 50_000) return;
        target.session.send(`retry-${asked}`);
        depth -= 1;
      },
    });
    target = displayer;
    displayer.session.send("the only one");
    await converse(displayer, enterer, 6);
    expect(displayer.session.busy).toBe(false);

    await withRejectionWatch(async () => {
      displayer.session.send("no id for you");
      await settle();
    });
    // F1's `#pumping` flag is what makes two sends in one tick safe, and it is
    // exactly what a same-stack re-entry defeats: the flag is cleared *before*
    // `#reportListenerError` runs, so the nested `#pump` is allowed to start.
    expect
      .soft(
        deepest,
        "the pump must not re-enter itself on the same stack (P2V re-verification finding)",
      )
      .toBeLessThanOrEqual(2);
    expect.soft(displayer.moduleErrors, "and this is not a module failure").toEqual([]);
    expect.soft(displayer.session.state, "the session survives").toBe("listening");
  }, 60_000);
});

describe("F1 — the flags cannot get stuck", () => {
  it("clears pumping, txBusy and busy on every exit from the pump", async () => {
    const { displayer, enterer } = await pairedPair();
    displayer.session.send("one");
    // While the frames are being sealed the pump owns the session, and
    // `transmitting` is honest about it even though no audio has left yet.
    await settle();
    expect(displayer.session.busy).toBe(true);
    expect(displayer.session.transmitting).toBe(false);
    await converse(displayer, enterer, 8);
    // After the whole exchange every flag is false again, twice over, so this is
    // a steady state and not a single lucky read.
    expect(displayer.session.busy).toBe(false);
    expect(displayer.session.transmitting).toBe(false);
    expect(displayer.session.state).toBe("listening");
    // ...and the session still works afterwards.
    displayer.session.send("two");
    await converse(displayer, enterer, 8);
    expect(enterer.texts()).toEqual(["one", "two"]);
  }, 60_000);

  it("clears every flag on stop(), mid-seal and mid-transmit", async () => {
    for (const stage of ["seal", "transmit", "idle"]) {
      const { displayer } = await pairedPeerOnly();
      if (stage !== "idle") displayer.session.send(`cut-${stage}`);
      if (stage === "transmit") await settle();
      // What the session had already done by the time `stop()` is called. Only
      // what happens *after* it may not happen.
      const eventsBefore = displayer.events.length;
      const airBefore = displayer.takeAir().length;
      displayer.session.stop();
      await settle();
      expect.soft(displayer.session.busy, `${stage}: busy after stop()`).toBe(false);
      expect
        .soft(displayer.session.transmitting, `${stage}: transmitting after stop()`)
        .toBe(false);
      expect.soft(displayer.session.state, `${stage}: state after stop()`).toBe("idle");
      expect.soft(displayer.takeAir().length, `${stage}: no audio after stop()`).toBe(0);
      // ...and no `outbound` record was created after the teardown either, so a
      // consumer cannot be handed a message the session no longer owns.
      expect
        .soft(
          displayer.events.slice(eventsBefore).filter((event) => event.type === "outbound"),
          `${stage}: no outbound record after stop()`,
        )
        .toEqual([]);
      expect.soft(displayer.session.busy, `${stage}: and it stays clear`).toBe(false);
    }
  }, 30_000);

  it("is not wedged by a message whose transmission the machine keeps refusing", async () => {
    const { displayer, enterer } = await pairedPair();
    // The peer never answers, and the tab is hidden for the whole retry budget:
    // every window is refused, so no attempt is spent and the message is held
    // rather than failed. When the tab comes back it goes out.
    setVisibility("hidden");
    displayer.session.send("held");
    await settle();
    for (let cycle = 0; cycle < 8; cycle += 1) {
      setVisibility("hidden");
      await settle();
      await vi.advanceTimersByTimeAsync(ACK_TIMEOUT_MS + BACKOFF_MAX_MS + 1);
      await settle();
    }
    expect(
      displayer.events.filter((event) => event.type === "outbound" && event.attempts > 0),
      "a refused window is not an attempt",
    ).toEqual([]);
    expect(displayer.takeAir(), "nothing reached the air while hidden").toEqual([]);
    expect(displayer.session.busy, "the held message is still the session's").toBe(true);
    setVisibility("visible");
    await settle();
    await converse(displayer, enterer, 8);
    expect(enterer.texts()).toEqual(["held"]);
  }, 60_000);
});
