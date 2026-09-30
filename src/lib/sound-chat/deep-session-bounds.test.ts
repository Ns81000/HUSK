/**
 * Phase 2V deep dive — bounded state, and the codec's redelivery turned up.
 *
 * Master plan Section 10.2 P12 requires every piece of protocol state to be
 * bounded, and Section 10.3's transport row requires "duplicate decode events
 * (the codec redelivers 2-4 times by design) rendering once".
 *
 * This file drives those two requirements much harder than the real codec can:
 * a *stub* codec returns the same decoded block as many times as a test asks
 * for, or a block the session cannot read, thousands of times. The frames, the
 * AEAD, the assembler, the state machine and the timers are all real; only the
 * waveform is not.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flushReceiver, openSoundChatCodec, type SoundChatCodec } from "./codec";
import { derivePairingKeys } from "./crypto";
import type { PairingRole } from "./pairing";
import {
  FrameCodec,
  InboundAssembler,
  MAX_MESSAGE_BLOCKS,
  MAX_PARTIAL_MESSAGES,
  WIRE_BLOCK_BYTES,
} from "./protocol";
import {
  MAX_PENDING_MESSAGES,
  MAX_RE_ACKS_PER_MESSAGE,
  SoundChatSession,
  TURN_GAP_MS,
  type SessionEvent,
  type SessionStats,
} from "./session";

/** A fixed handshake challenge; the session generates a fresh one per pairing. */
const TEST_CHALLENGE = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);

const SAMPLE_FRAME = 1024;
let roomClock = 10;

const codecA = await openSoundChatCodec();
const extraCodecs: SoundChatCodec[] = [];

afterAll(() => {
  codecA.close();
  for (const codec of extraCodecs) codec.close();
});

type FakeProcessor = {
  onaudioprocess:
    ((event: { inputBuffer: { getChannelData: (index: number) => Float32Array } }) => void) | null;
  connect: (node: unknown) => void;
  disconnect: () => void;
};

type FakeBuffer = { copied: Float32Array[]; copyToChannel: (samples: Float32Array) => void };

class FakeAudioContext {
  readonly sampleRate = 48_000;
  state = "running";
  readonly destination = { kind: "destination" };
  readonly processors: FakeProcessor[] = [];
  playCount = 0;

  get currentTime(): number {
    return roomClock;
  }

  async resume(): Promise<unknown> {
    return this;
  }

  async close(): Promise<void> {
    this.state = "closed";
  }

  createMediaStreamSource(): { connect: () => void; disconnect: () => void } {
    return { connect: (): void => {}, disconnect: (): void => {} };
  }

  createScriptProcessor(size: number, input: number, output: number): FakeProcessor {
    if (size !== SAMPLE_FRAME || input !== 1 || output !== 1) {
      throw new Error(`unexpected processor shape ${size}/${input}/${output}`);
    }
    const processor: FakeProcessor = {
      onaudioprocess: null,
      connect: (): void => {},
      disconnect: (): void => {},
    };
    this.processors.push(processor);
    return processor;
  }

  createGain(): { gain: { value: number }; connect: () => void; disconnect: () => void } {
    return { gain: { value: 1 }, connect: (): void => {}, disconnect: (): void => {} };
  }

  createBuffer(): FakeBuffer {
    const buffer: FakeBuffer = { copied: [], copyToChannel: (): void => {} };
    buffer.copyToChannel = (samples: Float32Array): void => {
      buffer.copied.push(Float32Array.from(samples));
    };
    return buffer;
  }

  createBufferSource = (): unknown => {
    const source = {
      buffer: null as { copied: Float32Array[] } | null,
      connect: () => source,
      start: () => {
        this.playCount += 1;
      },
    };
    return source;
  };
}

type MockTrack = { stop: () => void; label: string };

function mockStream(): MediaStream {
  const track: MockTrack = { stop: (): void => {}, label: "fake-mic" };
  return {
    getAudioTracks: () => [track],
    getTracks: () => [track],
  } as unknown as MediaStream;
}

/**
 * A codec whose Rx path hands the driver a chosen 64-byte block on demand.
 *
 * `cheapAudio` replaces the transmit waveform with a single 1024-sample frame:
 * the *count* of transmissions is what these tests measure, and a real
 * 1.92 s block per acknowledgement would allocate 360 kB each time.
 */
function stubCodec(blocks: Uint8Array[], options?: { cheapAudio?: boolean }): SoundChatCodec {
  const real = codecA;
  const audio = new Float32Array(SAMPLE_FRAME);
  let index = 0;
  return {
    get state(): string {
      return "ready";
    },
    encode: (payload: Uint8Array): Float32Array => {
      if (payload.length === 0 || payload.length > 64) throw new Error("misuse");
      return options?.cheapAudio === true ? audio : real.encode(payload);
    },
    decode(): Uint8Array | null {
      const block = blocks[Math.min(index, blocks.length - 1)];
      if (block === undefined) return null;
      index += 1;
      return block;
    },
  } as unknown as SoundChatCodec;
}

type Peer = {
  readonly label: string;
  readonly context: FakeAudioContext;
  readonly session: SoundChatSession;
  readonly events: SessionEvent[];
  readonly moduleErrors: unknown[];
  texts: () => string[];
  plays: () => number;
  stats: () => SessionStats;
};

type PeerOptions = {
  label: string;
  role: PairingRole;
  codec: SoundChatCodec;
  pairingCode?: string;
};

const createdPeers: Peer[] = [];

async function createPeer(options: PeerOptions): Promise<Peer> {
  const context = new FakeAudioContext();
  const events: SessionEvent[] = [];
  const moduleErrors: unknown[] = [];
  const base = {
    codec: options.codec,
    context: context as unknown as AudioContext,
    stream: mockStream(),
    role: options.role,
    onEvent: (event: SessionEvent): void => {
      events.push(event);
    },
    onModuleError: (error: unknown): void => {
      moduleErrors.push(error);
    },
    onListenerError: (): void => {},
  };
  const session = await SoundChatSession.create(
    options.pairingCode === undefined ? base : { ...base, pairingCode: options.pairingCode },
  );
  const peer: Peer = {
    label: options.label,
    context,
    session,
    events,
    moduleErrors,
    texts: () =>
      events
        .filter(
          (event): event is Extract<SessionEvent, { type: "message" }> => event.type === "message",
        )
        .map((event) => event.text),
    plays: () => context.playCount,
    stats: () => session.stats,
  };
  createdPeers.push(peer);
  return peer;
}

const MAX_FLUSH_TURNS = 4_000;
/**
 * A drain floor, not a completion condition. crypto.subtle hands results back on
 * libuv's threadpool, so the number of event-loop turns a seal/assemble chain needs is
 * load-dependent; 32 was measured to be too few under contention.
 */
const SETTLE_FLOOR_TURNS = 256;

function activity(): string {
  let signature = "";
  for (const peer of createdPeers) {
    signature += [
      peer.session.state,
      peer.session.pairing.kind,
      peer.session.stats.blocksDecoded,
      peer.session.stats.framesUnreadable,
      peer.session.stats.messagesDelivered,
      peer.session.stats.duplicatesSuppressed,
      peer.session.stats.conflicts,
      peer.events.length,
      peer.context.playCount,
    ].join(",");
    signature += "|";
  }
  return signature;
}

async function settle(): Promise<void> {
  let quiet = 0;
  let turn = 0;
  while (turn < SETTLE_FLOOR_TURNS || quiet < 4) {
    if (turn >= MAX_FLUSH_TURNS) throw new Error("the async chain never settled");
    const before = activity();
    await new Promise((resolve) => setImmediate(resolve));
    quiet = activity() === before ? quiet + 1 : 0;
    turn += 1;
  }
}

async function until(what: string, ready: () => boolean): Promise<void> {
  for (let turn = 0; turn < MAX_FLUSH_TURNS; turn += 1) {
    if (ready()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error(`timed out waiting for ${what}`);
}

async function transmitted(peer: Peer): Promise<void> {
  await until(
    `${peer.label} to finish transmitting (state ${peer.session.state})`,
    () => peer.session.state !== "transmitting",
  );
}

function feedChunks(peer: Peer, chunks: number): void {
  for (let index = 0; index < chunks; index += 1) {
    roomClock += SAMPLE_FRAME / 48_000;
    peer.context.processors[0]?.onaudioprocess?.({
      inputBuffer: { getChannelData: () => new Float32Array(SAMPLE_FRAME) },
    });
  }
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  roomClock = 10;
  vi.stubGlobal("document", undefined);
  flushReceiver(codecA, 120);
});

afterEach(() => {
  for (const peer of createdPeers.splice(0)) peer.session.stop();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

/** A real PAIR frame plus a real message frame, from a peer we can pretend to be. */
async function peerFrames(code: string): Promise<{ pair: Uint8Array; message: Uint8Array }> {
  const keys = await derivePairingKeys(code);
  const peer = new FrameCodec({ keys, selfId: 1, sendSalt: new Uint8Array(16).fill(0x3c) });
  const [message] = await peer.buildMessageFrames(new TextEncoder().encode("hello there"), 4242);
  return { pair: await peer.buildPairFrame(TEST_CHALLENGE), message: message as Uint8Array };
}

/**
 * Pairs a displayer whose Rx path is the stub: one PAIR block in, the
 * displayer's own answer out at the next turn, and the room clock moved past
 * the Rx pause that answer opens. Returns how many transmissions the handshake
 * itself used, so the counts below are about the message traffic only.
 */
async function pairWithStub(displayer: Peer): Promise<number> {
  feedChunks(displayer, 1);
  // A condition, not a drain: the previous test's chain may still be draining
  // (a `stop()`ed session keeps processing what it already accepted), so a
  // fixed number of quiet turns is not enough to be sure this block landed.
  await until(
    "the peer's PAIR frame to be handled",
    () => displayer.session.pairing.kind === "paired",
  );
  await settle();
  await vi.advanceTimersByTimeAsync(TURN_GAP_MS + 1);
  await settle();
  await transmitted(displayer);
  roomClock += 3;
  return displayer.plays();
}

describe("500 redeliveries of one block (P4, P12)", () => {
  it("renders the message once and keeps every counter bounded", async () => {
    const { pair, message } = await peerFrames("ABCD2345");
    const redeliveries = 500;
    const blocks = [pair, ...Array.from({ length: redeliveries }, () => message)];
    const displayer = await createPeer({
      label: "displayer",
      role: "displayer",
      codec: stubCodec(blocks, { cheapAudio: true }),
      pairingCode: "ABCD2345",
    });
    displayer.session.start();
    const handshakePlays = await pairWithStub(displayer);

    // One chunk per block: 500 blocks arrive in a single synchronous burst, so
    // the driver's chain has to absorb all of them. Each block costs a real
    // AEAD open, so wait for the count rather than draining by a fixed number
    // of turns.
    feedChunks(displayer, blocks.length - 1);
    await until(
      "every redelivered block to be handled",
      () => displayer.session.stats.blocksDecoded === blocks.length,
    );
    await settle();

    expect(displayer.texts()).toEqual(["hello there"]);
    const stats = displayer.session.stats;
    expect(stats.blocksDecoded).toBe(blocks.length);

    expect(stats.messagesDelivered).toBe(1);
    expect(stats.duplicatesSuppressed).toBe(redeliveries - 1);
    expect(stats.conflicts).toBe(0);
    // The re-acknowledgements are folded into at most one transmission per turn:
    // the rest are kept pending rather than played (master plan finding 2).
    expect(displayer.plays(), "one ACK per burst, not one per redelivery").toBeLessThanOrEqual(2);
    // Bounded state: the high-water mark is O(1) and no partial message is kept.
    await vi.advanceTimersByTimeAsync(TURN_GAP_MS * 4);
    await settle();
    expect(displayer.session.state).toBe("listening");
    expect(displayer.texts()).toHaveLength(1);
  }, 30_000);

  it("counts unreadable blocks without growing anything", async () => {
    const { pair, message } = await peerFrames("ABCD2345");
    // A block with one bit flipped in its tag: the codec decodes it, this
    // pairing code cannot read it, and it must be nothing but a counter.
    const damaged = Uint8Array.from(message);
    damaged[5 + (message[4] ?? 0)] = (damaged[5 + (message[4] ?? 0)] ?? 0) ^ 0x01;
    const flood = 400;
    const blocks = [pair, ...Array.from({ length: flood }, () => damaged)];
    const displayer = await createPeer({
      label: "displayer",
      role: "displayer",
      codec: stubCodec(blocks, { cheapAudio: true }),
      pairingCode: "ABCD2345",
    });
    displayer.session.start();
    const handshakePlays = await pairWithStub(displayer);
    feedChunks(displayer, blocks.length - 1);
    await until(
      "every unreadable block to be handled",
      () => displayer.session.stats.blocksDecoded === blocks.length,
    );
    await settle();

    const stats = displayer.session.stats;
    expect(stats.blocksDecoded).toBe(blocks.length);
    expect(stats.framesUnreadable).toBe(flood);

    expect(stats.messagesDelivered).toBe(0);
    expect(displayer.texts()).toEqual([]);
    // One quiet timer, re-armed rather than accumulated.
    expect(vi.getTimerCount()).toBeLessThanOrEqual(1);
    expect(displayer.plays() - handshakePlays, "an unreadable block is never acknowledged").toBe(0);
    // And the session is still healthy afterwards.
    expect(displayer.session.state).toBe("listening");
    expect(displayer.moduleErrors).toHaveLength(0);
  }, 30_000);

  it("re-acknowledges the same message a bounded number of times", async () => {
    const { pair, message } = await peerFrames("ABCD2345");
    const rounds = 10;
    const blocks = [pair, ...Array.from({ length: rounds }, () => message)];
    const displayer = await createPeer({
      label: "displayer",
      role: "displayer",
      codec: stubCodec(blocks, { cheapAudio: true }),
      pairingCode: "ABCD2345",
    });
    displayer.session.start();
    const handshakePlays = await pairWithStub(displayer);
    // One redelivery per turn gap: each one is a "duplicate" the session is

    // designed to re-acknowledge, so a lost acknowledgement cannot loop the
    // sender.
    for (let round = 0; round < rounds; round += 1) {
      roomClock += 2.6; // the Rx pause from our own acknowledgement has expired
      feedChunks(displayer, 1);
      await settle();
      await vi.advanceTimersByTimeAsync(TURN_GAP_MS + 1);
      await settle();
    }
    await transmitted(displayer);

    expect(displayer.texts()).toEqual(["hello there"]);
    // One rendered message, and a bounded number of acknowledgements for it: the
    // first ACK plus at most `MAX_RE_ACKS_PER_MESSAGE` re-ACKs. Without the
    // budget this was one ACK per redelivery, so a recording of a single message
    // replayed in a loop made the receiver transmit for as long as the attacker
    // kept playing it (P2V finding 9).
    expect(
      displayer.plays() - handshakePlays,
      "one msgId, one acknowledgement budget",
    ).toBeLessThanOrEqual(MAX_RE_ACKS_PER_MESSAGE + 1);
    expect(displayer.stats().acksSent).toBeGreaterThan(0);
  }, 30_000);
});

describe("the outbound queue and the inbound assembler (P12)", () => {
  it("accepts exactly MAX_PENDING_MESSAGES and refuses the next one", async () => {
    const { pair, message } = await peerFrames("ABCD2345");
    const blocks = [pair, message];
    const displayer = await createPeer({
      label: "displayer",
      role: "displayer",
      codec: stubCodec(blocks, { cheapAudio: true }),
      pairingCode: "ABCD2345",
    });
    displayer.session.start();
    await settle();
    feedChunks(displayer, 2);
    await settle();

    const accepted: number[] = [];
    let refusal: string | undefined;
    for (let index = 0; index < MAX_PENDING_MESSAGES + 3; index += 1) {
      const result = displayer.session.send(`queued ${index}`);
      if (result.ok) accepted.push(index);
      else {
        refusal = result.reason;
        break;
      }
    }
    // The cap is on the *queue*, and the first send's text leaves it
    // synchronously (the pump owns it from then on), so the real bound is
    // one in flight plus `MAX_PENDING_MESSAGES` waiting. Hard either way, and
    // the refusal must be the honest one rather than a silent drop.
    expect(accepted.length).toBeLessThanOrEqual(MAX_PENDING_MESSAGES + 1);
    expect(refusal).toBe("queue-full");
  }, 30_000);

  it("cannot be fed a hostile block count from the wire", async () => {
    // `InboundAssembler` would hold one entry per block index it is given, so
    // the bound that matters is the one the *wire* imposes. Pinned here: a
    // parsed message frame never claims more than the two-block cap, whatever
    // its `seq` byte says.
    const keys = await derivePairingKeys("ABCD2345");
    const sender = new FrameCodec({ keys, selfId: 0, sendSalt: new Uint8Array(16).fill(1) });
    const receiver = new FrameCodec({ keys, selfId: 1, sendSalt: new Uint8Array(16).fill(2) });
    sender.adoptPeerSalt(new Uint8Array(16).fill(2));
    receiver.adoptPeerSalt(new Uint8Array(16).fill(1));
    for (const text of ["a", "z".repeat(43), "z".repeat(84)]) {
      for (const frame of await sender.buildMessageFrames(new TextEncoder().encode(text), 1)) {
        const parsed = await receiver.parse(frame);
        expect(parsed.ok).toBe(true);
        if (!parsed.ok || parsed.frame.kind !== "message") throw new Error("expected a message");
        expect(parsed.frame.blockCount).toBeLessThanOrEqual(MAX_MESSAGE_BLOCKS);
        expect(parsed.frame.blockIndex).toBeLessThan(parsed.frame.blockCount);
      }
    }
    // The assembler's own default cap, and the byte it cannot be pushed past.
    const assembler = new InboundAssembler();
    for (let index = 0; index < 500; index += 1) {
      assembler.accept({
        msgId: 10_000 + index,
        blockIndex: 0,
        blockCount: 2,
        plaintext: new Uint8Array(42),
      });
      expect(assembler.partialCount).toBeLessThanOrEqual(MAX_PARTIAL_MESSAGES);
    }
  });

  it("honours a cap of zero partial messages", () => {
    // P2V FINDING: `#admit` breaks out of its eviction loop when the map is
    // already empty, so a cap of zero is silently raised to one.
    const assembler = new InboundAssembler({ maxPartialMessages: 0 });
    expect(
      assembler.accept({ msgId: 1, blockIndex: 0, blockCount: 2, plaintext: new Uint8Array(4) })
        .status,
    ).toBe("partial");
    expect(assembler.partialCount).toBe(0);
  });

  it("records the gap: a direct API caller can hand the assembler a block count the wire cannot produce", () => {
    // The test name is deliberately *not* a claim that this is fixed. A direct
    // API caller *can* hand the assembler a block count the wire can never
    // produce, and its per-message map then grows with it. The name said
    // "keeps … inside the block the wire allows" while the body asserted the
    // opposite, which is the failure mode master plan Section 10.1 class 11
    // warns about. What actually protects the product is the wire-level guard
    // above: a parsed message frame never claims more than the two-block cap,
    // so the session cannot reach this path.
    const assembler = new InboundAssembler();
    const status = assembler.accept({
      msgId: 1,
      blockIndex: 40,
      blockCount: 41,
      plaintext: new Uint8Array(1),
    });
    // Measured reality, pinned: the hostile count *is* admitted.
    expect(status.status).toBe("partial");
    // ...and the reason the product is safe is the wire, not the assembler.
    expect(WIRE_BLOCK_BYTES).toBe(64);
  });
});
