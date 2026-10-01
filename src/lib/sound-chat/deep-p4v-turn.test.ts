/**
 * Phase 4V deep dive — the turn handoff the CRITICAL fix introduced.
 *
 * `090e149` replaced the guard that was *supposed* to keep our own queued note
 * off the air after an ACK (`#currentState() !== "listening"`, unreachable,
 * because `#attemptAck` ends in `TRANSMIT_DONE_UNACKED`) with three new pieces:
 *
 * - `ListenHandle.pausedUntilSeconds` — the AudioContext instant our own Rx
 *   pause expires, read as a fact instead of recomputed;
 * - `#speakerBusy()` / `#airIsOurs()` — a transmission that finds our own
 *   speaker still talking is *deferred*, not sent;
 * - `#rearmQuietWhenOurSpeakerIsFree()` — the timer that hands the turn back
 *   when the pause expires, armed only when `#outbound`, `#pending` or
 *   `#pumping` holds something.
 *
 * Everything here attacks those three. The room clock and the wall clock are
 * driven separately, exactly as the commit says production does, because the
 * fix is the one place the two are compared.
 *
 * The fake `encode` returns a whole 1.92 s block (90 x 1024 samples) rather than
 * the single frame the queue tests use, because this file measures *air*: with a
 * 21 ms waveform the Rx pause a play arms is 0.52 s, not the 2.42 s the product
 * arms, and every overlap and every hold in these tests would be measured
 * against the wrong window.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SoundChatCodec } from "./codec";
import type { RandomSource } from "./crypto";
import { drainAsync } from "./drain";
import type { PairingRole } from "./pairing";
import {
  BLOCK_DURATION_MS,
  BLOCK_DURATION_SECONDS,
  MAX_RE_ACKS_PER_MESSAGE,
  PAIR_CONFIRM_TIMEOUT_MS,
  SoundChatSession,
  TURN_GAP_MS,
  type SessionEvent,
} from "./session";

const SAMPLE_FRAME = 1024;
/** One real block of air: 90 frames x 1024 / 48000. */
const BLOCK_SAMPLES = 90 * SAMPLE_FRAME;
let roomClock = 10;

/** What kind of frame went on the air, read off the version byte (Section 4). */
type AirKind = "pair" | "ack" | "message";

function kindOf(frame: Uint8Array): AirKind {
  const version = frame[0] ?? 0;
  if (version === 4) return "pair";
  if (version === 2) return "ack";
  return "message";
}

/** One scheduled transmission: when the context was asked to start it, and when. */
type Play = {
  /** `AudioBufferSourceNode.start(when)`'s argument; 0 means "now". */
  when: number;
  /** The room clock at the moment `start()` was called. */
  at: number;
  kind: AirKind;
  /** The wire id the block carried, so a retry is distinguishable from a new note. */
  msgId: number;
  /** The AudioContext instant this block stops sounding. */
  endsAt: number;
};

type LoopCodec = {
  state: string;
  /** What is still on the air; `takeAir` splices it. */
  readonly txLog: Uint8Array[];
  /** Every frame ever encoded, so a play can be classified after a `takeAir`. */
  readonly encoded: Uint8Array[];
  /** The frame handed to the most recent `encode`, or null before the first. */
  lastEncoded: Uint8Array | null;
  readonly rxQueue: Uint8Array[];
  encode: (payload: Uint8Array) => Float32Array;
  decode: () => Uint8Array | null;
};

function loopCodec(onEncode?: () => void): LoopCodec {
  const txLog: Uint8Array[] = [];
  const encoded: Uint8Array[] = [];
  const rxQueue: Uint8Array[] = [];
  const audio = new Float32Array(BLOCK_SAMPLES);
  return {
    state: "ready",
    txLog,
    encoded,
    lastEncoded: null,
    rxQueue,
    encode(payload: Uint8Array): Float32Array {
      if (payload.length === 0 || payload.length > 64) throw new Error("misuse");
      const frame = Uint8Array.from(payload);
      txLog.push(frame);
      encoded.push(frame);
      this.lastEncoded = frame;
      // A hostile codec may re-enter the capture pipeline from inside `encode`.
      // The product's own Rx pause is armed *after* this call, so anything
      // decoded here is legitimately heard; a decode that lands *after* the pause
      // is armed is the seam the session relies on audio-io to keep shut.
      onEncode?.();
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
  /** Every `start()` this context was asked for, in order. */
  readonly plays: Play[] = [];
  /**
   * The codec, set once `createPeer` has built it.
   *
   * A play is classified from the frame that was encoded *immediately before*
   * this `start()`, which is not the same as indexing the encode log: an encode
   * can fail after it has run and produce no play at all.
   */
  codec: LoopCodec | null = null;

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
    // An arrow property, so `this` is the context and the capture below is just a
    // read of the live field — no alias, and no chance of the two drifting apart.
    const source = {
      buffer: null as { copied: Float32Array[] } | null,
      connect: (): unknown => source,
      start: (when: number): void => {
        // `start(0)` is "as soon as possible": a `when` already in the past is
        // clamped to now, which is what turns an ungated second play into an
        // overlap instead of a queue.
        const startAt = Math.max(when, roomClock);
        const frame = this.codec?.lastEncoded ?? null;
        this.plays.push({
          when,
          at: roomClock,
          kind: frame === null ? "message" : kindOf(frame),
          msgId: frame === null ? -1 : ((frame[1] ?? 0) << 8) | (frame[2] ?? 0),
          endsAt: startAt + BLOCK_DURATION_SECONDS,
        });
      },
    };
    return source;
  };
}

/** The plays carrying one kind of frame, in order. */
function playsOfKind(peer: Peer, kind: AirKind): Play[] {
  return peer.context.plays.filter((play) => play.kind === kind);
}

/** How many distinct messages of ours have been put on the air. */
function distinctNotes(peer: Peer): number {
  return new Set(playsOfKind(peer, "message").map((play) => play.msgId)).size;
}

/** Index pairs of plays that sound at the same time. */
function overlaps(peer: Peer): number[][] {
  const pairs: number[][] = [];
  for (let later = 0; later < peer.context.plays.length; later += 1) {
    for (let earlier = 0; earlier < later; earlier += 1) {
      const a = peer.context.plays[earlier];
      const b = peer.context.plays[later];
      if (a === undefined || b === undefined) continue;
      if (Math.max(b.when, b.at) < a.endsAt) pairs.push([earlier, later]);
    }
  }
  return pairs;
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
  readonly airs: () => AirKind[];
  takeAir: () => Uint8Array[];
  texts: () => string[];
  outbound: () => Extract<SessionEvent, { type: "outbound" }>[];
};

type PeerOptions = {
  label: string;
  role: PairingRole;
  pairingCode?: string;
  random?: RandomSource;
  onEvent?: (event: SessionEvent) => void;
  onEncode?: () => void;
};

const createdPeers: Peer[] = [];

async function createPeer(options: PeerOptions): Promise<Peer> {
  const context = new FakeAudioContext();
  const codec = loopCodec(options.onEncode);
  const events: SessionEvent[] = [];
  const base = {
    codec: codec as unknown as SoundChatCodec,
    context: context as unknown as AudioContext,
    stream: mockStream(),
    role: options.role,
    onEvent: (event: SessionEvent): void => {
      events.push(event);
      options.onEvent?.(event);
    },
  };
  const session = await SoundChatSession.create(
    options.pairingCode === undefined ? base : { ...base, pairingCode: options.pairingCode },
  );
  context.codec = codec;
  const peer: Peer = {
    label: options.label,
    context,
    codec,
    session,
    events,
    airs: () => peer.context.plays.map((play) => play.kind),
    takeAir: () => codec.txLog.splice(0, codec.txLog.length),
    texts: () =>
      events
        .filter(
          (event): event is Extract<SessionEvent, { type: "message" }> => event.type === "message",
        )
        .map((event) => event.text),
    outbound: () =>
      events.filter(
        (event): event is Extract<SessionEvent, { type: "outbound" }> => event.type === "outbound",
      ),
  };
  createdPeers.push(peer);
  return peer;
}

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
      peer.context.plays.length,
    ].join(",");
    signature += "|";
  }
  return signature;
}

async function settle(turns = 256): Promise<void> {
  await drainAsync({ activity, floorTurns: turns });
}

async function until(what: string, ready: () => boolean): Promise<void> {
  for (let turn = 0; turn < 16_000; turn += 1) {
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
/** One block plus the measured 0.5 s Rx tail: how long our own audio holds the air. */
const PAIR_AIR_MS = BLOCK_DURATION_MS + 500 + 1;

/**
 * Both clocks, for a whole air window.
 *
 * An unacknowledged block of ours holds the turn for its own air window, so a
 * helper that advances a single turn gap leaves the session convinced its speaker
 * is still busy and whatever it is waiting for never happens.
 */
async function air(): Promise<void> {
  roomClock += PAIR_AIR_MS / 1_000;
  await settle();
  await vi.advanceTimersByTimeAsync(PAIR_AIR_MS);
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

async function pairUp(displayer: Peer, enterer: Peer): Promise<void> {
  displayer.session.start();
  enterer.session.start();
  // Two turns each way is the handshake: the enterer's PAIR, the displayer's
  // answer, and one repeat each. Kept as small as it can be, because every turn
  // is a real AEAD round trip and this file runs the handshake twelve times.
  await converse(enterer, displayer, 2);
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

describe("PRIMARY — after a successful #attemptAck, the re-arm hands the turn back", () => {
  it("plays the ACK alone, and the queued note only once our own pause expires", async () => {
    const { displayer, enterer } = await pairedPair();

    // The enterer sends a note the displayer will owe an ACK for; while that ACK
    // is in flight the enterer queues a second note, so the turn after the ACK
    // is genuinely wanted.
    expect(enterer.session.send("first").ok).toBe(true);
    await deliver(enterer, displayer);
    await until("the displayer's ACK", () => playsOfKind(displayer, "ack").length === 1);
    const ackPlay = playsOfKind(displayer, "ack")[0];
    expect(ackPlay).toBeDefined();
    // Nothing of ours may share the air with our own ACK.
    expect(overlaps(displayer), "our own audio stacked").toEqual([]);
    expect(playsOfKind(displayer, "message").length).toBe(0);

    // And the hold: the queued note goes out, and not one instant before the
    // pause the ACK armed has expired.
    expect(enterer.session.send("second").ok).toBe(true);
    await converse(enterer, displayer, 3);
    const afterAck = playsOfKind(enterer, "message").filter((play) => play.at > (ackPlay?.at ?? 0));
    expect(afterAck.length, "the queued note never got its turn back").toBeGreaterThan(0);
    const held = afterAck[0];
    expect(held?.at ?? -1).toBeGreaterThanOrEqual(ackPlay?.endsAt ?? 0);
  });

  it("hears nothing of its own transmission — the invariant the whole fix rests on", async () => {
    const { displayer, enterer } = await pairedPair();
    expect(enterer.session.send("one").ok).toBe(true);
    await deliver(enterer, displayer);
    await until("the displayer's ACK", () => playsOfKind(displayer, "ack").length === 1);
    const ackPlay = playsOfKind(displayer, "ack")[0];
    const decodedBefore = displayer.session.stats.blocksDecoded;
    // Inside our own transmit window the feed is *skipped*, not decoded. This is
    // why "our own audio produces no decodes for #noteHeard to hear" is true,
    // and why the re-arm is the only thing that can hand the turn back.
    for (let step = 0; step < 40; step += 1) {
      roomClock += SAMPLE_FRAME / 48_000;
      displayer.context.processors[0]?.onaudioprocess?.({
        inputBuffer: { getChannelData: () => new Float32Array(SAMPLE_FRAME) },
      });
    }
    expect(roomClock).toBeLessThan(ackPlay?.endsAt ?? 0);
    expect(displayer.session.stats.blocksDecoded).toBe(decodedBefore);
  });
});

describe("F1 — #transmitPairFrame is not gated on #airIsOurs()", () => {
  it("a hide/show inside the PAIR window must not put a second block on the air", async () => {
    const displayer = await createPeer({ label: "displayer", role: "displayer" });
    const enterer = await createPeer({
      label: "enterer",
      role: "enterer",
      pairingCode: displayer.session.pairingCode,
    });
    displayer.session.start();
    enterer.session.start();
    await until("the enterer's PAIR frame", () => enterer.codec.txLog.length > 0);
    await settle();
    expect(enterer.airs()).toEqual(["pair"]);

    // The tab goes away and comes back while the first PAIR block is still
    // sounding — a 2.42 s window, and the enterer is still unpaired, so
    // `#onVisibility` re-sends its PAIR with no gate on the air.
    roomClock += 1;
    setVisibility("hidden");
    await settle();
    setVisibility("visible");
    await settle();
    // The re-send is *deferred*, not dropped: both clocks move past our own air
    // window and the held turn then releases it.
    expect(
      enterer.codec.txLog.length,
      "nothing goes on the air while our own block is still sounding",
    ).toBe(1);
    roomClock += PAIR_AIR_MS / 1_000;
    await vi.advanceTimersByTimeAsync(PAIR_AIR_MS);
    await settle();
    await until("the re-sent PAIR frame", () => enterer.codec.txLog.length > 1);
    await settle();

    expect(enterer.airs()).toEqual(["pair", "pair"]);
    expect(
      overlaps(enterer),
      `the two PAIR blocks sounded at once: ${JSON.stringify(enterer.context.plays)}`,
    ).toEqual([]);
  });

  it("a note sent inside the answer's turn must not lose the answer", async () => {
    // The displayer's composer goes live the instant `pairing: paired` is
    // published — 700 ms before the answer the fix added a re-arm to. A note in
    // that window takes the turn, `#onChannelQuiet` consumes `#pendingPairReply`,
    // and the machine then refuses the answer with nothing to retry it.
    let sent = false;
    const displayer = await createPeer({
      label: "displayer",
      role: "displayer",
      onEvent: (event: SessionEvent): void => {
        if (event.type !== "pairing" || event.state.kind !== "paired" || sent) return;
        sent = true;
        displayer.session.send("hi");
      },
    });
    const enterer = await createPeer({
      label: "enterer",
      role: "enterer",
      pairingCode: displayer.session.pairingCode,
    });
    displayer.session.start();
    enterer.session.start();
    await converse(enterer, displayer, 1);
    await converse(displayer, enterer, 1);
    await settle();
    await vi.advanceTimersByTimeAsync(PAIR_CONFIRM_TIMEOUT_MS + 1);
    await settle();
    expect(sent, "the window is the displayer's, not the enterer's").toBe(true);
    expect(enterer.session.pairing.kind).toBe("paired");
  });
});

describe("F2 — the two unenforced invariants that keep a deferred ACK from stranding", () => {
  it("the Rx pause excludes decodes, and a sender cannot owe two answers", async () => {
    // INVARIANT 1. `#speakerBusy()` is `listen.paused`, and `paused` is exactly
    // the condition under which `startListening` drops every chunk. So a session
    // can never *hear* anything while it believes it is talking, which is the only
    // reason an ACK is not owed at a moment when the speaker is busy. Nothing in
    // the session asserts this; it lives in one `if` in audio-io.
    //
    // INVARIANT 2. `#pendingAck` is a single slot and `#sendAck` overwrites it, so
    // two owed answers in one `#heardRecently` window would lose the first.
    // Unreachable, because the sender cannot put another block on the air until
    // the first is acknowledged.
    //
    // Together they are why the re-arm's guard can leave out `#pendingAck`. Break
    // either and a deferred ACK is stranded for ever: nothing else re-arms, and
    // `#attemptAck` is the only transmission in the session with no second
    // recovery path (a message also has the ACK deadline; a PAIR frame has its
    // own timeout).
    const { displayer, enterer } = await pairedPair();
    expect(enterer.session.send("one").ok).toBe(true);
    await until("one on the air", () => enterer.codec.txLog.length > 0);
    await deliver(enterer, displayer);
    // INVARIANT 2, measured: the answer is the only thing left on the air.
    expect(enterer.codec.txLog.length).toBe(0);
    expect(displayer.session.stats.acksSent).toBe(1);
    // INVARIANT 1, measured: our own transmit window decodes nothing at all.
    const ackPlay = playsOfKind(displayer, "ack")[0];
    const before = displayer.session.stats.blocksDecoded;
    for (let step = 0; step < 60; step += 1) {
      // Fill the Rx queue so a skipped chunk would be a *decoded* one.
      displayer.codec.rxQueue.push(enterer.codec.encoded[0] as Uint8Array);
      feedChunk(displayer);
    }
    expect(roomClock).toBeLessThan(ackPlay?.endsAt ?? 0);
    expect(displayer.session.stats.blocksDecoded).toBe(before);
  });
});

describe("F3 — a sender in backoff that owes an ACK does not stack them", () => {
  it("the retry is deferred behind the ACK rather than sent on top of it", async () => {
    // The displayer owes an ACK and the enterer's message times out, so the
    // enterer is in `backoff` with a retry armed while it also owes nothing —
    // the shape is driven from the displayer's side, which is the one that has
    // both an owed ACK and an in-flight transmission.
    const { displayer, enterer } = await pairedPair();
    expect(enterer.session.send("one").ok).toBe(true);
    await deliver(enterer, displayer);
    // The ACK is on the air; queue a second note on the *displayer* so its own
    // transmission is what the next turn has to wait for.
    expect(displayer.session.send("mine").ok).toBe(true);
    for (let round = 0; round < 4 && playsOfKind(displayer, "message").length === 0; round += 1) {
      await air();
    }
    expect(playsOfKind(displayer, "message").length, "the deferred note never went out").toBe(1);
    expect(displayer.airs(), "our own block and our own ACK overlapped").toEqual([
      "pair",
      "ack",
      "message",
    ]);
    expect(enterer.session.stats.retries).toBe(0);
  });
});

describe("no strand — every deferral on the message path is recovered", () => {
  it("a queued note behind an owed ACK goes out, and the sender never retransmits", async () => {
    const { displayer, enterer } = await pairedPair();
    expect(enterer.session.send("one").ok).toBe(true);
    await deliver(enterer, displayer);
    expect(enterer.session.send("two").ok).toBe(true);
    await converse(enterer, displayer, 3);
    expect(displayer.texts()).toEqual(["one", "two"]);
    // A budget, not an exact count: the codec redelivers every block 2-4 times and
    // each redelivery is re-ACKed up to `MAX_RE_ACKS_PER_MESSAGE`, so the total is
    // "one ACK per message plus at most its re-ACK budget", not a fixed number.
    // Exact equality here made this assertion a function of how the two
    // conversations interleaved, which is what the fix under test changes.
    expect(
      displayer.session.stats.acksSent,
      "one acknowledgement per message, plus at most the re-ACK budget each",
    ).toBeLessThanOrEqual(2 * (1 + MAX_RE_ACKS_PER_MESSAGE));
    expect(displayer.session.stats.acksSent).toBeGreaterThanOrEqual(2);
    expect(enterer.session.stats.retries).toBe(0);
    expect(enterer.outbound().at(-1)?.status).toBe("sent");
  });

  it("a frozen room clock re-arms rather than transmits", async () => {
    // A suspended AudioContext: `currentTime` stops, the wall clock does not. The
    // deferral is then self-perpetuating (one re-arm per pause length) and the
    // session transmits nothing, which is the honest behaviour for a speaker it
    // believes is still talking — but the deferral must be the *only* thing that
    // happens, and no unbounded loop of transmissions may start.
    const { displayer, enterer } = await pairedPair();
    expect(enterer.session.send("one").ok).toBe(true);
    await deliver(enterer, displayer);
    await until("the ACK", () => displayer.session.stats.acksSent === 1);
    const frozenAt = displayer.codec.txLog.length;
    for (let round = 0; round < 5; round += 1) {
      await vi.advanceTimersByTimeAsync(2_500);
      await settle();
    }
    expect(displayer.codec.txLog.length).toBe(frozenAt);
  });
});

describe("F4 — a successful message transmission does not hold the turn", () => {
  it("a queued second note is only released by the peer's acknowledgement", async () => {
    // `#attemptAck` and `#transmitPairFrame` both re-arm the quiet timer after
    // their own transmission; `#transmitBlocks` does not. It has two other
    // recoveries (the ACK deadline and the peer's own answer), so the cost is
    // not a strand — it is that a second queued note waits for the first note's
    // whole retry budget when the peer's answer never comes.
    const { displayer, enterer } = await pairedPair();
    expect(enterer.session.send("one").ok).toBe(true);
    expect(enterer.session.send("two").ok).toBe(true);
    await until("one block on the air", () => enterer.codec.txLog.length > 0);
    const firstPlay = playsOfKind(enterer, "message")[0];
    // The peer never answers. The second note can only be released by the first
    // note's ACK deadline, backoff and retry budget running out.
    for (let round = 0; round < 11; round += 1) {
      await vi.advanceTimersByTimeAsync(2_000);
      roomClock += 3;
      await settle();
      if (distinctNotes(enterer) > 1) break;
    }
    expect(distinctNotes(enterer), "the second note never left the queue").toBe(2);
    const notes = playsOfKind(enterer, "message");
    const second = notes.find((play) => play.msgId !== firstPlay?.msgId);
    // Measured: 30 s of room clock, which is three 5540 ms ACK timeouts and two
    // backoffs — the retry budget, not a strand.
    expect((second?.at ?? 0) - (firstPlay?.at ?? 0)).toBeGreaterThan(15);
    expect(displayer.codec.txLog.length).toBe(0);
  });
});

describe("F5 — a #notify consumer that tears the session down", () => {
  it("leaves no unhandled rejection behind the pump", async () => {
    // `#pump` publishes `sending` and *then* reads `#outbound` to hand the blocks
    // to `#transmitBlocks`. A consumer that calls `stop()` from that event clears
    // `#outbound`, so the argument is `null` by the time it is read — and the
    // throw lands in an async function every call site reaches with `void`.
    let victim: Peer | null = null;
    const { displayer } = await pairedPair({
      onEvent: (event: SessionEvent): void => {
        if (event.type !== "outbound" || event.status !== "sending") return;
        victim?.session.stop();
      },
    });
    victim = displayer;
    const rejections: unknown[] = [];
    const listener = (reason: unknown): void => {
      rejections.push(reason);
    };
    process.on("unhandledRejection", listener);
    try {
      expect(displayer.session.send("boom").ok).toBe(true);
      await settle();
      // Node reports an unhandled rejection on a later macrotask.
      for (let turn = 0; turn < 3; turn += 1) {
        await new Promise((resolve) => setImmediate(resolve));
      }
    } finally {
      process.off("unhandledRejection", listener);
    }
    expect(
      rejections.map((reason) => String(reason)),
      "a consumer calling stop() from the pump's own event",
    ).toEqual([]);
  });
});

describe("F6 — a module death while the pump is sealing a note", () => {
  it("a restarted session can still transmit", async () => {
    // `#pumping` is the pump's single-flight flag and `#moduleFailed` does not
    // clear it — `restart()` does not either, because it only clears `#stopped`
    // and the report latch. A pump parked inside `buildMessageFrames` when the
    // codec died therefore leaves `#pumping` true for the life of the session,
    // and every later `#pump()` returns at its first guard. `busy` stays true.
    let armed = false;
    const displayer = await createPeer({
      label: "displayer",
      role: "displayer",
      onEncode: (): void => {
        if (armed) armed = false;
      },
    });
    const enterer = await createPeer({
      label: "enterer",
      role: "enterer",
      pairingCode: displayer.session.pairingCode,
    });
    await pairUp(displayer, enterer);
    // A frame the Rx path will choke on, delivered while the pump is sealing.
    displayer.codec.rxQueue.push(enterer.codec.encoded[0] as Uint8Array);
    const hostile = displayer.codec as unknown as { decode: () => Uint8Array | null };
    const realDecode = hostile.decode.bind(hostile);
    hostile.decode = (): Uint8Array | null => {
      if (!armed) return realDecode();
      throw new Error("the wasm module is gone");
    };
    // The seal is a real `crypto.subtle` round trip, so it is stalled here long
    // enough for the death to land inside the pump's only suspension.
    const subtle = globalThis.crypto.subtle as unknown as Record<string, unknown>;
    const realEncrypt = (subtle["encrypt"] as (...args: unknown[]) => Promise<unknown>).bind(
      subtle,
    );
    let stalled = false;
    subtle["encrypt"] = async (...args: unknown[]): Promise<unknown> => {
      const sealed = await realEncrypt(...args);
      if (stalled) return sealed;
      stalled = true;
      for (let turn = 0; turn < 4; turn += 1) {
        await new Promise((resolve) => setImmediate(resolve));
      }
      return sealed;
    };
    expect(subtle["encrypt"], "the seal was not patched").not.toBe(realEncrypt);
    try {
      // The pump that has to be parked is the *displayer's*: the same session
      // whose Rx feed is about to report the death.
      expect(displayer.session.send("one").ok).toBe(true);
      for (let turn = 0; turn < 40 && !stalled; turn += 1) {
        await new Promise((resolve) => setImmediate(resolve));
      }
      expect(stalled, "the seal really was stalled").toBe(true);
      expect(displayer.session.busy, "the pump claimed the note").toBe(true);
      armed = true;
      for (let turn = 0; turn < 40; turn += 1) {
        feedChunk(displayer);
        await new Promise((resolve) => setImmediate(resolve));
        if (displayer.session.state === "module_error") break;
      }
      expect(displayer.session.state, "the Rx death was reported").toBe("module_error");
    } finally {
      subtle["encrypt"] = realEncrypt;
    }
    // Restart is the documented way back, and it must actually work.
    expect(displayer.session.restart().ok).toBe(true);
    // Read here, before anything is queued: this is the state a stale `#pumping`
    // produced — `busy` true with no note in flight and nothing on the air.
    expect(
      displayer.session.busy,
      `#pumping survived the module death: state=${displayer.session.state}`,
    ).toBe(false);
    displayer.session.start();
    expect(displayer.session.send("after").ok).toBe(true);
    await settle();
    // Both clocks, past any air window a previous transmission of ours left.
    await air();
    expect(
      playsOfKind(displayer, "message").length,
      `#pumping was left true by the module death: state=${displayer.session.state} ` +
        `busy=${String(displayer.session.busy)} plays=${JSON.stringify(displayer.context.plays)}`,
    ).toBeGreaterThan(0);
  });
});

describe("F7 — a codec that throws after the Rx pause was armed", () => {
  it("is terminal, and leaves no stale pause behind for a restarted session", async () => {
    const { displayer, enterer } = await pairedPair();
    expect(enterer.session.send("one").ok).toBe(true);
    await until("one on the air", () => enterer.codec.txLog.length > 0);
    // `transmitAndPause` arms the Rx pause *before* it creates the buffer, so a
    // throw from there leaves the feed paused for a transmission that never
    // happened.
    const original = displayer.context.createBuffer.bind(displayer.context);
    displayer.context.createBuffer = (): never => {
      displayer.context.createBuffer = original;
      throw new Error("the audio graph went away mid-transmission");
    };
    await converse(enterer, displayer, 1);
    expect(displayer.session.state).toBe("module_error");
    expect(displayer.context.plays.length, "the throw happened mid-transmission").toBeGreaterThan(
      0,
    );
    // The only way back is a restart, and a restarted session must be able to
    // transmit immediately: a stale `pausedUntil` would defer it for ever.
    expect(displayer.session.restart().ok).toBe(true);
    displayer.session.start();
    expect(displayer.session.send("after").ok).toBe(true);
    await settle();
    await vi.advanceTimersByTimeAsync(TURN_GAP_MS + 1);
    await settle();
    expect(
      playsOfKind(displayer, "message").length,
      `a restarted session deferred its first block on a stale pause: ` +
        `state=${displayer.session.state} pairing=${displayer.session.pairing.kind} ` +
        `plays=${JSON.stringify(displayer.context.plays)} ` +
        `events=${displayer
          .outbound()
          .map((event) => event.status)
          .join(",")}`,
    ).toBeGreaterThan(0);
  });
});
