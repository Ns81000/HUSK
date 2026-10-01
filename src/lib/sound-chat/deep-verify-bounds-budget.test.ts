/**
 * Phase 2V re-verification — bounded state, the re-ACK budget and the wire
 * boundary (F4, F7, F9, F12, F14, F15).
 *
 * The fixes in this group are all about *limits*: how many attempts a hidden
 * window may spend (F4), what happens when the message-id space runs out (F7),
 * how often one delivered message may be acknowledged again (F9), what a session
 * started on an already-hidden page does (F12), and the two exported boundaries
 * `frameAad` (F14) and `InboundAssembler` (F15).
 *
 * A limit is only real if it holds under repetition, so every test here drives
 * its limit far past the point where the number would be obvious, and then
 * attacks the accounting from the side the implementation actually uses.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SoundChatCodec } from "./codec";
import { derivePairingKeys, type RandomSource } from "./crypto";
import {
  frameAad,
  FrameCodec,
  HEADER_BYTES,
  InboundAssembler,
  MAX_MESSAGE_BLOCKS,
  MAX_PARTIAL_MESSAGES,
  MULTI_HEADER_BYTES,
  PAIR_BODY_BYTES,
  ProtocolUsageError,
  TAG_BYTES,
  WIRE_BLOCK_BYTES,
} from "./protocol";
import { MAX_RE_ACKS_PER_MESSAGE, SoundChatSession, type SessionEvent } from "./session";
import { drainAsync } from "./drain.ts";

const CODE = "ABCD2345";
const SAMPLE_FRAME = 1024;
let roomClock = 10;

const keys = await derivePairingKeys(CODE);

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
  readonly moduleErrors: unknown[];
  readonly listenerErrors: unknown[];
  takeAir: () => Uint8Array[];
  plays: () => number;
  texts: () => string[];
  outbound: () => Extract<SessionEvent, { type: "outbound" }>[];
};

type PeerOptions = {
  label: string;
  role: "displayer" | "enterer";
  pairingCode?: string;
  random?: RandomSource;
};

const createdPeers: Peer[] = [];

async function createPeer(options: PeerOptions): Promise<Peer> {
  const context = new FakeAudioContext();
  const codec = loopCodec();
  const events: SessionEvent[] = [];
  const moduleErrors: unknown[] = [];
  const listenerErrors: unknown[] = [];
  const base = {
    codec: codec as unknown as SoundChatCodec,
    context: context as unknown as AudioContext,
    stream: mockStream(),
    role: options.role,
    onEvent: (event: SessionEvent): void => {
      events.push(event);
    },
    onModuleError: (error: unknown): void => {
      moduleErrors.push(error);
    },
    onListenerError: (error: unknown): void => {
      listenerErrors.push(error);
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
    takeAir: () => codec.txLog.splice(0, codec.txLog.length),
    plays: () => context.plays,
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
      peer.session.stats.duplicatesSuppressed,
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

function feedChunks(peer: Peer, count: number): void {
  for (let index = 0; index < count; index += 1) {
    roomClock += SAMPLE_FRAME / 48_000;
    peer.context.processors[0]?.onaudioprocess?.({
      inputBuffer: { getChannelData: () => new Float32Array(SAMPLE_FRAME) },
    });
  }
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
  feedChunks(to, frames.length);
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
  displayer.codec.rxQueue.length = 0;
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

describe("F9 — the re-ACK budget is a real bound", () => {
  it("500 redeliveries of one block produce a bounded number of transmissions", async () => {
    const { displayer, enterer } = await pairedPair();
    enterer.session.send("played on a loop");
    await settle();
    const [frame] = enterer.takeAir();
    if (frame === undefined) throw new Error("no frame on the air");
    // The handshake's own PAIR answer is already on the record; only what comes
    // after it is the budget's business.
    const handshakePlays = displayer.plays();
    // A recording of a single message, played 500 times, one redelivery per turn
    // gap — the exact shape the budget exists for.
    const rounds = 500;
    for (let round = 0; round < rounds; round += 1) {
      displayer.codec.rxQueue.push(frame);
      roomClock += 3;
      feedChunks(displayer, 1);
      await settle();
      await vi.advanceTimersByTimeAsync(701);
      await settle();
      displayer.takeAir();
    }
    await air();
    // One rendered message and a bounded number of acknowledgements: the first
    // ACK plus at most MAX_RE_ACKS_PER_MESSAGE re-ACKs. Without the budget this
    // is one transmission per redelivery, so a recording makes this device talk
    // for as long as the attacker keeps playing it.
    expect(displayer.texts()).toEqual(["played on a loop"]);
    // The handshake's own PAIR frame is the first block the displayer decoded.
    expect(displayer.session.stats.blocksDecoded).toBe(rounds + 1);
    expect(
      displayer.plays() - handshakePlays,
      "one msgId, one bounded acknowledgement budget",
    ).toBeLessThanOrEqual(MAX_RE_ACKS_PER_MESSAGE + 1);
    expect(displayer.session.stats.acksSent).toBeGreaterThan(0);
    // Every redelivery was still counted, and the session is healthy.
    expect(displayer.session.stats.duplicatesSuppressed).toBe(rounds - 1);
    expect(displayer.session.state).toBe("listening");
    expect(displayer.moduleErrors).toEqual([]);
  }, 60_000);

  it("still answers a genuinely lost acknowledgement, and does not break the normal flow", async () => {
    // One redelivery after delivery is the codec's own behaviour (it redelivers
    // 2-4 times), and it is what stops a sender retrying. The budget must not
    // swallow it.
    for (const redeliveries of [1, 2, 3, 4]) {
      const { displayer, enterer } = await pairedPair();
      enterer.session.send(`m-${redeliveries}`);
      await settle();
      const [frame] = enterer.takeAir();
      if (frame === undefined) throw new Error("no frame on the air");
      let acks = 0;
      for (let round = 0; round < redeliveries; round += 1) {
        displayer.codec.rxQueue.push(frame);
        roomClock += 3;
        feedChunks(displayer, 1);
        await settle();
        await vi.advanceTimersByTimeAsync(701);
        await settle();
        acks += displayer.takeAir().filter((f) => f[0] === 2).length;
      }
      expect
        .soft(displayer.texts(), `redeliveries ${redeliveries}: delivered once`)
        .toEqual([`m-${redeliveries}`]);
      expect
        .soft(acks, `redeliveries ${redeliveries}: a lost acknowledgement must still be answered`)
        .toBeGreaterThanOrEqual(Math.min(redeliveries, MAX_RE_ACKS_PER_MESSAGE));
      displayer.session.stop();
      enterer.session.stop();
    }
  }, 60_000);

  it("a full two-block message still completes with the codec's own redeliveries", async () => {
    // The budget is per msgId, not per block, and the partial-ACK timer and the
    // delivery ACK are not charged to it — so the realistic redelivery pattern
    // for the largest message a user can send must still resolve on the sender.
    const { displayer, enterer } = await pairedPair();
    enterer.session.send("z".repeat(84));
    await settle();
    const frames = enterer.takeAir();
    expect(frames, "the two-block cap is still honoured").toHaveLength(2);
    // Block 0 three times (the codec's worst measured redelivery), then block 1.
    displayer.codec.rxQueue.push(frames[0] as Uint8Array);
    displayer.codec.rxQueue.push(frames[0] as Uint8Array);
    displayer.codec.rxQueue.push(frames[0] as Uint8Array);
    roomClock += 3;
    feedChunks(displayer, 3);
    await settle();
    await vi.advanceTimersByTimeAsync(701);
    await settle();
    displayer.takeAir();
    displayer.codec.rxQueue.push(frames[1] as Uint8Array);
    roomClock += 3;
    feedChunks(displayer, 1);
    await settle();
    await vi.advanceTimersByTimeAsync(701);
    await settle();
    // Delivered, and the sender is told in full.
    expect(displayer.texts()).toEqual(["z".repeat(84)]);
    await air();
    await deliver(displayer, enterer);
    expect(
      enterer.outbound().filter((event) => event.status === "sent"),
      "and the sender resolved",
    ).toHaveLength(1);
  }, 30_000);

  it("keeps its own storage bounded over a long session of distinct messages", async () => {
    // The budget retires everything below a new high-water msgId, and only
    // `duplicate` outcomes — which the assembler can only produce for the single
    // msgId at its own high-water mark — are charged to it. So a long session
    // with redeliveries after every message must not accumulate anything, and
    // every message must still be rendered exactly once.
    const { displayer, enterer } = await pairedPair();
    const messages = 40;
    for (let index = 0; index < messages; index += 1) {
      expect(enterer.session.send(`long-${index}`).ok, `send ${index}`).toBe(true);
      await settle();
      const [frame] = enterer.takeAir();
      if (frame === undefined) throw new Error(`no frame on the air for message ${index}`);
      // Deliver it, then redeliver it twice: a fresh high-water mark each time.
      const acks: Uint8Array[] = [];
      for (let redelivery = 0; redelivery < 3; redelivery += 1) {
        displayer.codec.rxQueue.push(frame);
        roomClock += 3;
        feedChunks(displayer, 1);
        await settle();
        await vi.advanceTimersByTimeAsync(701);
        await settle();
        acks.push(...displayer.takeAir());
      }
      // The acknowledgement goes back, so the sender is free for the next one.
      expect
        .soft(acks.length, `message ${index}: an acknowledgement was produced`)
        .toBeGreaterThan(0);
      enterer.codec.rxQueue.push(...acks);
      roomClock += 3;
      feedChunks(enterer, acks.length);
      await settle();
      expect
        .soft(
          enterer.outbound().filter((event) => event.status === "sent").length,
          `message ${index}: the sender resolved`,
        )
        .toBe(index + 1);
      expect
        .soft(displayer.session.stats.blocksDecoded, `message ${index} must be decoded`)
        .toBe((index + 1) * 3 + 1);
    }
    expect(displayer.texts()).toEqual(Array.from({ length: messages }, (_, i) => `long-${i}`));
    // Nothing grew: the assembler keeps no partial, the session keeps one timer
    // at a time, and the transport is where it started.
    expect(displayer.session.state).toBe("listening");
    expect(vi.getTimerCount(), "at most the quiet timer").toBeLessThanOrEqual(1);
    expect(displayer.moduleErrors).toEqual([]);
  }, 120_000);
});

describe("F4 — attempts are spent only on a real transmission", () => {
  it("spends nothing while the page is hidden, and exactly one per visible window", async () => {
    const { displayer, enterer } = await pairedPair();
    // Hidden from the start. The pump's very first transmit attempt is refused
    // by the machine (`TRANSMIT_BEGIN` is illegal in `hidden_hold`), and so is
    // every ACK-timeout-driven retry: the fix moved `attempts += 1` *after* the
    // state check, so a window that never put audio on the air costs nothing.
    setVisibility("hidden");
    displayer.session.send("held");
    await settle();
    for (let round = 0; round < 6; round += 1) {
      setVisibility("hidden");
      await settle();
      await vi.advanceTimersByTimeAsync(5_540 + 1_200 + 1);
      await settle();
    }
    expect(
      displayer.outbound().filter((event) => event.attempts > 0),
      "a refused window is not an attempt",
    ).toEqual([]);
    expect(displayer.takeAir(), "and nothing reached the air").toEqual([]);
    expect(displayer.session.busy, "the message is still the session's").toBe(true);
    expect(
      displayer.outbound().some((event) => event.status === "failed"),
      "and it was never failed for a window it never used",
    ).toBe(false);
    // One visible window: the message goes out, exactly once, and no retry is
    // ever counted — which is the observable form of "one attempt".
    setVisibility("visible");
    await settle();
    expect(displayer.session.state).toBe("awaiting_ack");
    expect(displayer.takeAir(), "one transmission window").toHaveLength(1);
    expect(displayer.session.stats.retries, "and no retry").toBe(0);
    await converse(displayer, enterer, 14);
    expect(enterer.texts()).toEqual(["held"]);
    expect(
      displayer.outbound().some((event) => event.status === "failed"),
      "and the message was never failed",
    ).toBe(false);
  }, 60_000);

  it("counts a mid-message hide as a retry, and still delivers the message", async () => {
    // The other shape the fix has to keep honest: a two-block message whose tab
    // goes hidden after block 0. Block 0 spent attempt 1; the resumed window is
    // attempt 2, and it must be *reported* as a retry, because from the
    // receiver's point of view block 0 really is being sent again.
    const { displayer, enterer } = await pairedPair();
    displayer.session.send("z".repeat(84));
    await settle();
    expect(displayer.takeAir(), "the two-block cap").toHaveLength(2);
    // The tab goes away before the peer ever answers.
    setVisibility("hidden");
    displayer.session.send("queued behind it");
    await settle();
    expect(displayer.takeAir(), "nothing else went out while hidden").toEqual([]);
    setVisibility("visible");
    await settle();
    // The two-block transmission's own air window (2 x 1920 ms + the 500 ms
    // measured tail = 4340 ms) is still open, so the resumed window waits for it
    // rather than starting on top of it. Both clocks must move, and for the whole
    // window — `air()`'s 3 s is not enough for a two-block message.
    roomClock += 4.4;
    await settle();
    await vi.advanceTimersByTimeAsync(4_400);
    await settle();
    expect(
      displayer.session.stats.retries,
      "the resumed window is a retry, and it is reported as one",
    ).toBeGreaterThanOrEqual(1);
    expect(displayer.outbound().filter((event) => event.attempts > 1).length).toBe(
      displayer.session.stats.retries,
    );
    await converse(displayer, enterer, 14);
    expect(enterer.texts(), "and the message still arrives").toContain("z".repeat(84));
  }, 60_000);
});

describe("F7 — the message-id space", () => {
  it("reports the refusal, rejects nothing, and leaves the session usable", async () => {
    const highSalt: RandomSource = (bytes) => {
      bytes.fill(0);
      bytes[0] = 0xff;
      bytes[1] = 0xff;
      return bytes;
    };
    const { displayer, enterer } = await pairedPair({ random: highSalt });
    displayer.session.send("the only id");
    await converse(displayer, enterer, 6);
    expect(enterer.texts()).toEqual(["the only id"]);
    expect(displayer.session.busy, "resolved").toBe(false);

    const rejections = await withRejectionWatch(async () => {
      for (let attempt = 0; attempt < 4; attempt += 1) {
        expect(displayer.session.send(`refused-${attempt}`).ok).toBe(true);
        await settle();
      }
    });
    expect(
      displayer.listenerErrors.length,
      "every refusal reaches the consumer channel",
    ).toBeGreaterThan(0);
    expect(rejections, "and nothing rejects").toEqual([]);
    expect(displayer.moduleErrors, "exhaustion is not a codec death").toEqual([]);
    expect(displayer.session.state, "and the session is not in a failed state").toBe("listening");
    // Nothing was invented on the air, and the peer is untouched.
    expect(displayer.takeAir()).toEqual([]);
    expect(enterer.texts()).toEqual(["the only id"]);
  }, 60_000);
});

describe("F12 — a session started while the page is already hidden", () => {
  it("holds a displayer in hidden_hold and never transmits", async () => {
    visibility = "hidden";
    const displayer = await createPeer({ label: "hidden-d", role: "displayer", pairingCode: CODE });
    displayer.session.start();
    await settle();
    expect(displayer.session.state, "held, not listening").toBe("hidden_hold");
    // Time passes: no amount of it makes a hidden session speak.
    for (let round = 0; round < 3; round += 1) {
      await vi.advanceTimersByTimeAsync(10_000);
      await settle();
    }
    expect(displayer.takeAir(), "a displayer has nothing to transmit anyway").toEqual([]);
    // It goes back to normal when the page returns.
    setVisibility("visible");
    await settle();
    expect(displayer.session.state).toBe("listening");
  }, 30_000);

  it("must still put the enterer's PAIR frame on the air once the page returns", async () => {
    // P2V RE-VERIFICATION FINDING (new defect). The F12 fix reads
    // `document.visibilityState` once in `start()` and holds the session, which
    // is right — but the *enterer* is the side whose only transmission is that
    // PAIR frame, and `#transmitPairFrame`'s `TRANSMIT_BEGIN` is refused in
    // `hidden_hold` with nothing scheduled to try again. `#onVisibility(true)`
    // only resumes `#outbound` and the message pump, and the pump requires
    // `isPaired`. So an enterer started while hidden never initiates: the
    // handshake times out and the user is told the other device did not answer.
    visibility = "hidden";
    const enterer = await createPeer({ label: "hidden-e", role: "enterer", pairingCode: CODE });
    enterer.session.start();
    await settle();
    expect(enterer.session.state, "held while hidden").toBe("hidden_hold");
    expect(enterer.session.pairing.kind).toBe("awaiting-confirmation");
    // The user switches to the other device to type the code, and comes back
    // well inside the confirmation window.
    await vi.advanceTimersByTimeAsync(2_000);
    setVisibility("visible");
    await settle();
    expect
      .soft(
        enterer.takeAir(),
        "an enterer must still initiate the handshake once the page returns (P2V re-verification finding)",
      )
      .not.toEqual([]);
    expect.soft(enterer.session.state).toBe("listening");
  }, 30_000);

  it("leaves a session started while visible unaffected, and works with no document at all", async () => {
    // Visible: the one-time read is a no-op.
    const displayer = await createPeer({
      label: "visible-d",
      role: "displayer",
      pairingCode: CODE,
    });
    displayer.session.start();
    await settle();
    expect(displayer.session.state).toBe("listening");
    // A later read of a *changed* visibility is the change event's business, not
    // `start()`'s: the driver never re-reads on its own.
    visibility = "hidden";
    await settle();
    expect(displayer.session.state, "no second read").toBe("listening");
    displayer.session.stop();
    // Node: no `document` at all, which is what a headless test and a
    // server-side render both look like.
    vi.stubGlobal("document", undefined);
    const headless = await createPeer({ label: "node", role: "enterer", pairingCode: CODE });
    headless.session.start();
    await settle();
    expect.soft(headless.session.state, "and start() still works").toBe("listening");
    expect.soft(headless.takeAir().length, "and the PAIR frame goes out").toBeGreaterThan(0);
    // The document has to be back before teardown: the visibility unsubscribe
    // closes over the *global* `document`, so tearing a session down after the
    // global has been replaced throws out of `stop()` (recorded below).
    visibility = "visible";
    visibilityHandlers = [];
    vi.stubGlobal("document", {
      get visibilityState(): string {
        return visibility;
      },
      addEventListener: (): void => {},
      removeEventListener: (): void => {},
    });
    expect.soft(() => headless.session.stop(), "stop() must not throw").not.toThrow();
  }, 30_000);
});

describe("F14 — frameAad validates every part of its inputs", () => {
  it("refuses every illegal headerBytes and len, and accepts every legal one", () => {
    const frame = new Uint8Array(WIRE_BLOCK_BYTES);
    // Legal: header within the frame, len a non-negative integer, and the body
    // plus the tag still inside the block.
    const legal: [number, number][] = [
      [0, 0],
      [0, WIRE_BLOCK_BYTES - TAG_BYTES],
      [HEADER_BYTES, 0],
      [HEADER_BYTES, 1],
      [HEADER_BYTES, WIRE_BLOCK_BYTES - HEADER_BYTES - TAG_BYTES],
      [MULTI_HEADER_BYTES, 0],
      [MULTI_HEADER_BYTES, WIRE_BLOCK_BYTES - MULTI_HEADER_BYTES - TAG_BYTES],
      [PAIR_BODY_BYTES + HEADER_BYTES, 0],
      [WIRE_BLOCK_BYTES - TAG_BYTES, 0],
    ];
    for (const [headerBytes, len] of legal) {
      const aad = frameAad(frame, headerBytes, len);
      expect(aad.length, `frameAad(${headerBytes}, ${len}) length`).toBe(
        headerBytes + (WIRE_BLOCK_BYTES - headerBytes - len - TAG_BYTES),
      );
      expect(
        Array.from(aad.subarray(0, Math.min(headerBytes, aad.length))),
        `frameAad(${headerBytes}, ${len}) header`,
      ).toEqual(Array.from(frame.subarray(0, headerBytes)));
    }
    // Illegal: a header outside the frame, or not an integer.
    for (const headerBytes of [
      -1,
      -0.5,
      1.5,
      WIRE_BLOCK_BYTES + 1,
      Number.NaN,
      Number.POSITIVE_INFINITY,
    ]) {
      expect(() => frameAad(frame, headerBytes, 0), `headerBytes ${headerBytes}`).toThrowError(
        ProtocolUsageError,
      );
    }
    // Illegal: a len that is negative, not an integer, or pushes the body past
    // the end of the block. The negative case is the one that used to silently
    // produce a *shorter* AAD with the padding starting inside the header.
    for (const len of [
      -1,
      -TAG_BYTES,
      -WIRE_BLOCK_BYTES,
      0.5,
      1.5,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      WIRE_BLOCK_BYTES,
      WIRE_BLOCK_BYTES - HEADER_BYTES - TAG_BYTES + 1,
    ]) {
      expect(() => frameAad(frame, HEADER_BYTES, len), `len ${len}`).toThrowError(
        ProtocolUsageError,
      );
    }
    // The AAD it produces for a real frame is exactly header + zero padding, and
    // opening it needs no trust in the builder.
    expect(frameAad(frame, HEADER_BYTES, 0)).toHaveLength(WIRE_BLOCK_BYTES - TAG_BYTES);
  });
});

describe("F15 — InboundAssembler honours its own cap", () => {
  it("admits nothing at a cap of zero, and nothing at a negative cap", () => {
    for (const cap of [0, -1, -10]) {
      const assembler = new InboundAssembler({ maxPartialMessages: cap });
      const outcome = assembler.accept({
        msgId: 1,
        blockIndex: 0,
        blockCount: 2,
        plaintext: new Uint8Array(8),
      });
      expect(outcome.status, `cap ${cap}: a two-block message stays partial`).toBe("partial");
      expect(assembler.partialCount, `cap ${cap}: nothing is retained`).toBe(0);
      // ...and it is *never* a duplicate, because nothing was ever held: each
      // block is simply re-accepted and the message is never completed.
      const again = assembler.accept({
        msgId: 1,
        blockIndex: 0,
        blockCount: 2,
        plaintext: new Uint8Array(8),
      });
      expect(again.status, `cap ${cap}`).toBe("partial");
      expect(
        assembler.accept({
          msgId: 1,
          blockIndex: 1,
          blockCount: 2,
          plaintext: new Uint8Array(8),
        }).status,
        `cap ${cap}: the second block cannot complete what was not held`,
      ).toBe("partial");
      expect(assembler.partialCount).toBe(0);
      expect(assembler.highWater).toBeNull();
    }
  });

  it("still delivers a single-block message at a cap of zero", () => {
    // A one-block message is never partial, so a cap on *partial* state cannot
    // and should not refuse it: nothing is retained either way. This is the
    // honest reading of the bound, and it is pinned so a future change to
    // `#admit` cannot quietly start dropping whole messages.
    const assembler = new InboundAssembler({ maxPartialMessages: 0 });
    expect(
      assembler.accept({ msgId: 7, blockIndex: 0, blockCount: 1, plaintext: new Uint8Array(4) })
        .status,
    ).toBe("delivered");
    expect(assembler.highWater).toBe(7);
    expect(assembler.partialCount).toBe(0);
  });

  it("keeps the product's own cap, and never exceeds it under a flood", () => {
    const assembler = new InboundAssembler();
    for (let index = 0; index < 2_000; index += 1) {
      assembler.accept({
        msgId: 1_000 + index,
        blockIndex: 0,
        blockCount: 2,
        plaintext: new Uint8Array(42),
      });
      expect(assembler.partialCount, `after ${index + 1} incomplete messages`).toBeLessThanOrEqual(
        MAX_PARTIAL_MESSAGES,
      );
    }
    // The high-water mark is the only other state, and it is a single number.
    expect(assembler.highWater).toBeNull();
  });
});

describe("the assembler and the wire cannot be pushed past the two-block cap", () => {
  it("refuses a multi-block `seq` that claims anything else", async () => {
    const sender = new FrameCodec({ keys, selfId: 0, sendSalt: new Uint8Array(16).fill(1) });
    const receiver = new FrameCodec({ keys, selfId: 1, sendSalt: new Uint8Array(16).fill(2) });
    sender.adoptPeerSalt(new Uint8Array(16).fill(2));
    receiver.adoptPeerSalt(new Uint8Array(16).fill(1));
    const [first] = await sender.buildMessageFrames(new TextEncoder().encode("z".repeat(84)), 5);
    const base = first as Uint8Array;
    expect(base[0]).toBe(3);
    // Every `seq` byte value that claims a different block structure is refused
    // structurally, before the assembler is ever reached.
    for (const seq of [0x00, 0x01, 0x03, 0x11, 0x20, 0xff]) {
      const attempt = Uint8Array.from(base);
      attempt[5] = seq;
      const parsed = await receiver.parse(attempt);
      expect(parsed.ok, `seq 0x${seq.toString(16)}`).toBe(false);
    }
    // And the two legal values really do parse, so the cap is not over-tight.
    for (const seq of [0x02, 0x12]) {
      const attempt = Uint8Array.from(base);
      attempt[5] = seq;
      const parsed = await receiver.parse(attempt);
      expect(parsed.ok, `seq 0x${seq.toString(16)} is legal but not what was sealed`).toBe(
        seq === 0x02,
      );
    }
    expect(MAX_MESSAGE_BLOCKS).toBe(2);
  });
});
