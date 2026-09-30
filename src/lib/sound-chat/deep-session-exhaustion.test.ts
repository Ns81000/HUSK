/**
 * Phase 2V deep dive — the message-id space running out.
 *
 * Master plan Section 10.2 P2/P12 make the allocator refuse to wrap, and the
 * session seeds it from the first two bytes of its own session salt — so a
 * session that draws a high salt can start with as few as one usable id. This
 * file takes the session to that edge through the public `random` option (the
 * documented injection point) and watches what the UI is told.
 *
 * It is its own file on purpose: the failure path produces an unhandled promise
 * rejection, which a shared file would report as a file-level error and hide
 * every other result in it.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flushReceiver, openSoundChatCodec, type SoundChatCodec } from "./codec";
import type { RandomSource } from "./crypto";
import { MessageIdExhaustedError } from "./protocol";
import type { PairingRole } from "./pairing";
import { ACK_TIMEOUT_MS, BACKOFF_MAX_MS, SoundChatSession, type SessionEvent } from "./session";

const SAMPLE_FRAME = 1024;
let roomClock = 10;

const codecA = await openSoundChatCodec();
const codecB = await openSoundChatCodec();

afterAll(() => {
  codecA.close();
  codecB.close();
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
  readonly played: Float32Array[] = [];
  closeCalls = 0;

  get currentTime(): number {
    return roomClock;
  }

  async resume(): Promise<unknown> {
    return this;
  }

  async close(): Promise<void> {
    this.closeCalls += 1;
    if (this.state === "closed") {
      throw new DOMException("Cannot close a closed AudioContext.", "InvalidStateError");
    }
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
        const samples = source.buffer?.copied[0];
        if (samples !== undefined) this.played.push(samples);
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

type Peer = {
  readonly label: string;
  readonly context: FakeAudioContext;
  readonly session: SoundChatSession;
  readonly events: SessionEvent[];
  readonly moduleErrors: unknown[];
  readonly listenerErrors: unknown[];
  pendingAir: () => number;
  takeAir: () => Float32Array[];
  texts: () => string[];
};

type PeerOptions = {
  label: string;
  role: PairingRole;
  codec: SoundChatCodec;
  pairingCode?: string;
  random?: RandomSource;
};

const createdPeers: Peer[] = [];

async function createPeer(options: PeerOptions): Promise<Peer> {
  const context = new FakeAudioContext();
  const events: SessionEvent[] = [];
  const moduleErrors: unknown[] = [];
  const listenerErrors: unknown[] = [];
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
    session,
    events,
    moduleErrors,
    listenerErrors,
    pendingAir: () => context.played.length,
    takeAir: () => {
      const played = [...context.played];
      context.played.length = 0;
      return played;
    },
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

const MAX_FLUSH_TURNS = 12_000;

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
      peer.context.played.length,
    ].join(",");
    signature += "|";
  }
  return signature;
}

/**
 * A drain floor, not a completion condition. `crypto.subtle` hands results back
 * on libuv's threadpool, so how many event-loop turns a seal chain needs is
 * load-dependent; 32 was measured to be too few under full-suite contention
 * (1 failure in 8 `pnpm test` runs, 0 in 14 isolated — Phase 2V).
 */
const SETTLE_FLOOR_TURNS = 256;

async function settle(): Promise<void> {
  let quiet = 0;
  let turn = 0;
  // 32, not 4. A four-turn quiet streak is short enough that a libuv
  // threadpool callback from real AEAD work can land between two of the
  // samples, reset the streak, and leave this loop waiting out the cascade
  // until it hits MAX_FLUSH_TURNS - which is how a test that passes alone
  // fails under parallel load. A longer streak makes settle() return later
  // rather than earlier, which is the only safe direction: returning early
  // leaks work into the next settle, and returning late costs turns.
  while (turn < SETTLE_FLOOR_TURNS || quiet < 32) {
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
    () => peer.session.state !== "transmitting" && peer.pendingAir() > 0,
  );
}

function feed(to: Peer, samples: Float32Array): void {
  const whole = Math.floor(samples.length / SAMPLE_FRAME);
  for (let index = 0; index < whole; index += 1) {
    const chunk = samples.subarray(index * SAMPLE_FRAME, (index + 1) * SAMPLE_FRAME);
    roomClock += SAMPLE_FRAME / 48_000;
    to.context.processors[0]?.onaudioprocess?.({ inputBuffer: { getChannelData: () => chunk } });
  }
}

async function passTurnGap(): Promise<void> {
  roomClock += 0.7;
  await settle();
  await vi.advanceTimersByTimeAsync(701);
  await settle();
  await vi.advanceTimersByTimeAsync(701);
  await settle();
}

async function deliver(from: Peer, to: Peer): Promise<void> {
  await transmitted(from);
  for (const samples of from.takeAir()) feed(to, samples);
  await settle();
  await passTurnGap();
}

async function pairUp(displayer: Peer, enterer: Peer): Promise<void> {
  displayer.session.start();
  enterer.session.start();
  for (let attempt = 0; attempt < 4; attempt += 1) {
    await deliver(enterer, displayer);
    await deliver(displayer, enterer);
    if (displayer.session.pairing.kind === "paired" && enterer.session.pairing.kind === "paired") {
      return;
    }
  }
  throw new Error("handshake did not complete");
}

/** A salt whose first two bytes are 0xff, so the allocator starts at 0xffff. */
const highSalt: RandomSource = (bytes) => {
  bytes.fill(0);
  bytes[0] = 0xff;
  bytes[1] = 0xff;
  return bytes;
};

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  roomClock = 10;
  vi.stubGlobal("document", undefined);
  flushReceiver(codecA, 120);
  flushReceiver(codecB, 120);
});

afterEach(() => {
  for (const peer of createdPeers.splice(0)) peer.session.stop();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("a session that runs out of message ids (P2, P12)", () => {
  it("tells the consumer instead of dropping the message on the floor", async () => {
    const displayer = await createPeer({
      label: "displayer",
      role: "displayer",
      codec: codecA,
      pairingCode: "ABCD2345",
      random: highSalt,
    });
    const enterer = await createPeer({
      label: "enterer",
      role: "enterer",
      codec: codecB,
      pairingCode: "ABCD2345",
    });
    await pairUp(displayer, enterer);
    expect(displayer.session.pairing.kind).toBe("paired");
    expect(Array.from(displayer.session.sessionSalt.slice(0, 2))).toEqual([0xff, 0xff]);

    // The one and only id this session will ever have.
    expect(displayer.session.send("the only one")).toEqual({ ok: true, queued: false });
    await settle();
    await deliver(displayer, enterer);
    expect(enterer.texts()).toEqual(["the only one"]);

    // The second message exhausts the space. The allocator refuses to wrap, which
    // is the designed behaviour, and the allocation now sits *inside* the pump's
    // `try` — so a refusal to wrap is our own misuse, reported on the consumer
    // channel with nothing rejecting (P2V finding 7). It used to sit outside the
    // try, so `void #pump()` left an unhandled rejection.
    const rejections: unknown[] = [];
    const onRejection = (reason: unknown): void => {
      rejections.push(reason);
    };
    process.on("unhandledRejection", onRejection);
    try {
      expect(displayer.session.send("the second one").ok).toBe(true);
      await deliver(enterer, displayer);
      await vi.advanceTimersByTimeAsync(ACK_TIMEOUT_MS + BACKOFF_MAX_MS + 1);
      await settle();
      await new Promise((resolve) => setImmediate(resolve));
    } finally {
      process.off("unhandledRejection", onRejection);
    }
    // The refusal is reported, not swallowed, and nothing rejects.
    expect(
      rejections.some((reason) => reason instanceof MessageIdExhaustedError),
      "the exhaustion must not leave an unhandled rejection behind",
    ).toBe(false);
    expect(
      displayer.listenerErrors.some((error) => error instanceof MessageIdExhaustedError),
      "a session that cannot allocate an id must say so on the consumer channel",
    ).toBe(true);
    // The first message still went out; the second cannot, because there is no
    // id left to put on the wire. It is *refused and reported*, not silently
    // lost: the consumer channel carries the refusal, which is the documented
    // route for our own misuse (there is no `msgId` to key an `outbound` record
    // on, because the allocation is what failed).
    expect(enterer.texts()).toEqual(["the only one"]);
    expect(
      displayer.events.some((event) => event.type === "outbound" && event.msgId !== undefined),
      "the message that did go out is still reported",
    ).toBe(true);
    // ...and the session is not in a failed state: exhaustion of a 16-bit id
    // space is a bound, not a codec death.
    expect(displayer.session.state).toBe("listening");
    expect(displayer.moduleErrors).toHaveLength(0);
  });

  it("keeps refusing, without ever putting audio on the air", async () => {
    const displayer = await createPeer({
      label: "displayer",
      role: "displayer",
      codec: codecA,
      pairingCode: "ABCD2345",
      random: highSalt,
    });
    const enterer = await createPeer({
      label: "enterer",
      role: "enterer",
      codec: codecB,
      pairingCode: "ABCD2345",
    });
    await pairUp(displayer, enterer);
    displayer.session.send("one");
    await settle();
    await deliver(displayer, enterer);
    displayer.takeAir();
    enterer.takeAir();

    for (let attempt = 0; attempt < 3; attempt += 1) {
      // Every one of these is accepted...
      expect(displayer.session.send(`lost ${attempt}`).ok).toBe(true);
    }
    await vi.advanceTimersByTimeAsync(ACK_TIMEOUT_MS + BACKOFF_MAX_MS + 1);
    await settle();
    // Nothing the user queued after the first message ever reaches the air: the
    // driver can no longer allocate an id, so no frame is ever built for them.
    // (The first message's own retry is expected and is byte-identical.)
    expect(enterer.texts()).toEqual(["one"]);
    const outbound = displayer.events.filter(
      (event): event is Extract<SessionEvent, { type: "outbound" }> => event.type === "outbound",
    );
    expect(new Set(outbound.map((event) => event.msgId)).size).toBe(1);
    // P2V FINDING: expected a refusal the UI can show, received nothing until
    // the (now permanently stuck) queue fills.
    expect(displayer.listenerErrors).toHaveLength(0);
    let refusal: string | undefined;
    for (let index = 0; index < 8; index += 1) {
      const result = displayer.session.send(`filler ${index}`);
      if (!result.ok) {
        refusal = result.reason;
        break;
      }
    }
    expect(refusal).toBe("queue-full");
  });
});
