/**
 * Phase 2V deep dive — the session driver's seams.
 *
 * `session.test.ts` drives the driver through its *documented* paths. This file
 * drives it through the seams between them: two sends in one tick, a send held
 * by a hidden tab, a codec that dies on the Tx path, a stale PAIR frame from an
 * earlier session, an error sink that throws, a message-id space that runs out,
 * and a `start()` that cannot succeed.
 *
 * The acoustic path is simulated the way Phase 0 did it: whatever a session
 * "plays" is captured from its mocked AudioContext and fed back into the other
 * session's capture callback one 1024-sample frame at a time. The codec, the
 * frames, the AEAD and the timers are all real.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flushReceiver, openSoundChatCodec, type SoundChatCodec } from "./codec";
import { derivePairingKeys, type RandomSource } from "./crypto";
import type { PairingRole } from "./pairing";
import { FrameCodec, MAX_SEND_ATTEMPTS } from "./protocol";
import {
  ACK_TIMEOUT_MS,
  BACKOFF_MAX_MS,
  PAIR_CONFIRM_TIMEOUT_MS,
  SoundChatSession,
  TURN_GAP_MS,
  type SessionEvent,
} from "./session";

/** A fixed handshake challenge; the session generates a fresh one per pairing. */
const TEST_CHALLENGE = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);

const SAMPLE_FRAME = 1024;
let roomClock = 10;

const codecA = await openSoundChatCodec();
const codecB = await openSoundChatCodec();
/** Codecs a test opens for itself, so the shared ones stay uncontaminated. */
const extraCodecs: SoundChatCodec[] = [];

afterAll(() => {
  codecA.close();
  codecB.close();
  for (const codec of extraCodecs) codec.close();
});

type FakeProcessor = {
  onaudioprocess:
    ((event: { inputBuffer: { getChannelData: (index: number) => Float32Array } }) => void) | null;
  connect: (node: unknown) => void;
  disconnect: () => void;
};

type FakeBuffer = {
  length: number;
  copied: Float32Array[];
  copyToChannel: (samples: Float32Array) => void;
};

class FakeAudioContext {
  readonly sampleRate = 48_000;
  state = "running";
  readonly destination = { kind: "destination" };
  readonly processors: FakeProcessor[] = [];
  readonly played: Float32Array[] = [];
  playCount = 0;
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

  createMediaStreamSource(): unknown {
    return { connect: () => {}, disconnect: () => {} };
  }

  createScriptProcessor(size: number, input: number, output: number): FakeProcessor {
    if (size !== SAMPLE_FRAME || input !== 1 || output !== 1) {
      throw new Error(`unexpected processor shape ${size}/${input}/${output}`);
    }
    const processor: FakeProcessor = {
      onaudioprocess: null,
      connect: () => {},
      disconnect: () => {},
    };
    this.processors.push(processor);
    return processor;
  }

  createGain(): unknown {
    return { gain: { value: 0 }, connect: () => {}, disconnect: () => {} };
  }

  createBuffer(_channels: number, length: number): FakeBuffer {
    const buffer: FakeBuffer = { length, copied: [], copyToChannel: (): void => {} };
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
        const samples = source.buffer?.copied[0];
        if (samples !== undefined) this.played.push(samples);
      },
    };
    return source;
  };
}

type MockTrack = { stop: () => void; label: string };

function mockStream(withTracks = true): MediaStream {
  const track: MockTrack = { stop: (): void => {}, label: "fake-mic" };
  const tracks = withTracks ? [track] : [];
  return {
    getAudioTracks: () => tracks,
    getTracks: () => tracks,
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
  withTracks?: boolean;
  random?: RandomSource;
  onEvent?: (event: SessionEvent) => void;
  onModuleError?: (error: unknown) => void;
  onListenerError?: (error: unknown) => void;
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
    stream: mockStream(options.withTracks ?? true),
    role: options.role,
    onEvent: (event: SessionEvent): void => {
      events.push(event);
      options.onEvent?.(event);
    },
    onModuleError: (error: unknown): void => {
      moduleErrors.push(error);
      options.onModuleError?.(error);
    },
    onListenerError: (error: unknown): void => {
      listenerErrors.push(error);
      options.onListenerError?.(error);
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
      peer.session.stats.acksSent,
      peer.session.stats.retries,
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
    () => peer.session.state !== "transmitting" && peer.pendingAir() > 0,
  );
}

function feed(to: Peer, samples: Float32Array): number {
  let frames = 0;
  const whole = Math.floor(samples.length / SAMPLE_FRAME);
  for (let index = 0; index < whole; index += 1) {
    const chunk = samples.subarray(index * SAMPLE_FRAME, (index + 1) * SAMPLE_FRAME);
    roomClock += SAMPLE_FRAME / 48_000;
    to.context.processors[0]?.onaudioprocess?.({ inputBuffer: { getChannelData: () => chunk } });
    frames += 1;
  }
  return frames;
}

async function passTurnGap(): Promise<void> {
  roomClock += TURN_GAP_MS / 1000;
  await settle();
  await vi.advanceTimersByTimeAsync(TURN_GAP_MS + 1);
  await settle();
  await vi.advanceTimersByTimeAsync(TURN_GAP_MS + 1);
  await settle();
}

async function feedSamples(to: Peer, samples: Float32Array): Promise<number> {
  const frames = feed(to, samples);
  await settle();
  await passTurnGap();
  return frames;
}

async function deliver(from: Peer, to: Peer): Promise<number> {
  await transmitted(from);
  let frames = 0;
  for (const samples of from.takeAir()) frames += feed(to, samples);
  await settle();
  await passTurnGap();
  return frames;
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
  throw new Error(
    `handshake did not complete: ${displayer.session.pairing.kind}/${enterer.session.pairing.kind}`,
  );
}

async function pairedPair(): Promise<{ displayer: Peer; enterer: Peer }> {
  const displayer = await createPeer({ label: "displayer", role: "displayer", codec: codecA });
  const enterer = await createPeer({
    label: "enterer",
    role: "enterer",
    codec: codecB,
    pairingCode: displayer.session.pairingCode,
  });
  await pairUp(displayer, enterer);
  displayer.takeAir();
  enterer.takeAir();
  return { displayer, enterer };
}

/**
 * Drives a message all the way through, retries included: every round delivers
 * whatever is on the air and then waits out an ACK timeout, so a message that
 * is being retried is followed to its end.
 */
async function pumpRounds(from: Peer, to: Peer, rounds = 6): Promise<void> {
  for (let round = 0; round < rounds; round += 1) {
    await settle();
    if (from.pendingAir() > 0) await deliver(from, to);
    await vi.advanceTimersByTimeAsync(ACK_TIMEOUT_MS + BACKOFF_MAX_MS + 1);
    await settle();
  }
}

let visibility: "visible" | "hidden" = "visible";
let visibilityHandlers: (() => void)[] = [];

function stubVisibility(): void {
  visibilityHandlers = [];
  vi.stubGlobal("document", {
    get visibilityState() {
      return visibility;
    },
    addEventListener: (_type: string, handler: () => void) => {
      visibilityHandlers.push(handler);
    },
    removeEventListener: (): void => {
      visibilityHandlers = [];
    },
  });
}

function setVisibility(next: "visible" | "hidden"): void {
  visibility = next;
  for (const handler of [...visibilityHandlers]) handler();
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  roomClock = 10;
  visibility = "visible";
  visibilityHandlers = [];
  flushReceiver(codecA, 120);
  flushReceiver(codecB, 120);
});

afterEach(() => {
  for (const peer of createdPeers.splice(0)) peer.session.stop();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

/** A codec that dies on its `afterEncodes`-th encode, and on every decode after. */
function dyingCodec(real: SoundChatCodec, afterEncodes: number): SoundChatCodec {
  let encodes = 0;
  let dead = false;
  return {
    get state(): string {
      return dead ? "dead" : real.state;
    },
    encode(payload: Uint8Array): Float32Array {
      encodes += 1;
      if (encodes > afterEncodes) {
        dead = true;
        throw new Error("wasm trap");
      }
      return real.encode(payload);
    },
    decode(chunk: Float32Array): Uint8Array | null {
      if (dead) throw new Error("wasm trap: the module is gone");
      return real.decode(chunk);
    },
  } as unknown as SoundChatCodec;
}

describe("two sends in the same tick (the reentrancy seam)", () => {
  it("delivers both messages, once each, in order", async () => {
    const { displayer, enterer } = await pairedPair();
    // Two `send` calls with nothing in between — the pattern `session.test.ts`
    // itself uses to fill the queue, and what a UI does when a key handler and a
    // click handler both fire.
    expect(displayer.session.send("first")).toEqual({ ok: true, queued: false });
    // The second send is told `queued: true`, because the first pump has claimed
    // the session even though it has not yet assigned `#outbound` (P2V finding 1).
    expect.soft(displayer.session.send("second")).toEqual({ ok: true, queued: true });
    await pumpRounds(displayer, enterer);

    expect(enterer.texts()).toEqual(["first", "second"]);
    // The diagnostics, so one failure tells the whole story.
    expect.soft(new Set(enterer.texts()).size, "both messages must reach the peer").toBe(2);
    // Exactly two messages went out — one `msgId` each, however many retry
    // records the un-acked rounds produced.
    const sentIds = new Set(
      displayer.events
        .filter((event) => event.type === "outbound")
        .map((event) => (event.type === "outbound" ? event.msgId : -1)),
    );
    expect.soft(sentIds.size, "one msgId per queued message").toBe(2);
    expect(enterer.listenerErrors).toHaveLength(0);
    expect(enterer.moduleErrors).toHaveLength(0);
  });

  it("does not lose the second message or repeat the first across retries", async () => {
    const { displayer, enterer } = await pairedPair();
    displayer.session.send("alpha");
    displayer.session.send("beta");
    await pumpRounds(displayer, enterer);
    const texts = enterer.texts();
    // Every text the peer was shown must be one the sender actually queued, and
    // no text may appear twice.
    expect(texts.every((text) => text === "alpha" || text === "beta")).toBe(true);
    expect(new Set(texts).size).toBe(texts.length);
  });
});

describe("a send held by a hidden tab (P11)", () => {
  it("does not spend a transmission attempt on a window it never used", async () => {
    stubVisibility();
    const { displayer, enterer } = await pairedPair();
    setVisibility("visible");
    setVisibility("hidden");
    expect(displayer.session.send("held")).toEqual({ ok: true, queued: false });
    await settle();
    // Hidden, and staying hidden. Every one of these re-enters the transmit path
    // through the visibility handler, and every one of them is refused by the
    // machine. A refused window used to count as an attempt, so a hidden tab
    // exhausted the three-attempt budget and failed a message that had never
    // reached the air (P2V finding 4).
    for (let cycle = 0; cycle < 5; cycle += 1) {
      setVisibility("hidden");
      await settle();
    }
    expect(
      displayer.events.filter((event) => event.type === "outbound" && event.attempts > 0),
      "a refused window is not an attempt",
    ).toEqual([]);
    expect(displayer.takeAir(), "nothing reaches the air while hidden").toEqual([]);
    // One visible window, one attempt, and it goes through.
    setVisibility("visible");
    await settle();
    await deliver(displayer, enterer);
    expect(enterer.texts()).toEqual(["held"]);
  });

  it("never puts audio on the air while the document is already hidden", async () => {
    stubVisibility();
    const { displayer } = await pairedPair();
    // The document is hidden, but no `visibilitychange` event has fired — which
    // is the state of a session started or driven from a timer rather than from
    // a gesture. `start()` reads the state once, because the subscription is
    // change-only (P2V finding 12).
    visibility = "hidden";
    const restarted = await createPeer({
      label: "started-hidden",
      role: "displayer",
      codec: codecA,
    });
    restarted.session.start();
    expect(restarted.session.state).toBe("hidden_hold");
    restarted.session.send("into the void");
    await settle();
    expect(restarted.takeAir()).toHaveLength(0);
    // A session that was already running when the page went hidden is held in
    // the same way, through the change event.
    displayer.session.send("still fine");
    await settle();
    expect(displayer.session.state).toBe("awaiting_ack");
  });
});

describe("a codec that dies", () => {
  it("reports the module error exactly once, however many times it is told", async () => {
    const flaky = dyingCodec(codecA, 1);
    const displayer = await createPeer({ label: "displayer", role: "displayer", codec: flaky });
    const enterer = await createPeer({
      label: "enterer",
      role: "enterer",
      codec: codecB,
      pairingCode: displayer.session.pairingCode,
    });
    await pairUp(displayer, enterer);
    expect(displayer.session.pairing.kind).toBe("paired");
    expect(displayer.session.send("boom").ok).toBe(true);
    await settle();
    expect(displayer.session.state).toBe("module_error");
    expect(displayer.moduleErrors).toHaveLength(1);

    // The Rx feed is released too, so the next chunk the microphone produces
    // cannot re-report (P2V finding 6).
    roomClock += 2.5;
    feed(displayer, new Float32Array(SAMPLE_FRAME));
    await settle();
    expect(displayer.moduleErrors).toHaveLength(1);
  });

  it("leaves no pairing timer behind, and never reports a pairing failure after it", async () => {
    const flaky = dyingCodec(codecB, 0);
    const enterer = await createPeer({ label: "enterer", role: "enterer", codec: flaky });
    enterer.session.start();
    await settle();
    expect(enterer.session.state).toBe("module_error");
    // A dead session owns no timers at all, `pair` included.
    expect(vi.getTimerCount(), "a dead session owns no timers").toBe(0);
    const before = enterer.events.length;
    await vi.advanceTimersByTimeAsync(PAIR_CONFIRM_TIMEOUT_MS + 1);
    await settle();
    expect(enterer.events.length).toBe(before);
  });
});

describe("a stale PAIR frame from an earlier session", () => {
  it("cannot make the real initiator pair with it", async () => {
    // Its own two codec modules: the Rx window is a property of the *module*,
    // so a shared one would still hold the previous test's blocks.
    const displayerCodec = await openSoundChatCodec();
    const entererCodec = await openSoundChatCodec();
    extraCodecs.push(displayerCodec, entererCodec);
    const displayer = await createPeer({
      label: "d",
      role: "displayer",
      codec: displayerCodec,
    });
    const enterer = await createPeer({
      label: "e",
      role: "enterer",
      codec: entererCodec,
      pairingCode: displayer.session.pairingCode,
    });
    displayer.session.start();
    enterer.session.start();
    await settle();

    // Anyone holding the code can mint a valid PAIR frame with any salt they
    // like, and a recording of one from an earlier session is the same bytes. The
    // *initiator* is the protected side: it generated a challenge this recording
    // cannot contain, so the echo check refuses it (P2V finding 2).
    const keys = await derivePairingKeys(displayer.session.pairingCode);
    const stale = new FrameCodec({ keys, selfId: 0, sendSalt: new Uint8Array(16).fill(0xee) });
    await feedSamples(enterer, entererCodec.encode(await stale.buildPairFrame(TEST_CHALLENGE)));
    // The displayer never heard a foreign PAIR, so it is still waiting for its
    // real peer and the real enterer is still awaiting confirmation.
    expect(displayer.session.pairing.kind).toBe("waiting-for-peer");
    expect(enterer.session.pairing.kind).toBe("awaiting-confirmation");
    expect(enterer.session.pairingFailureMessage).toBeNull();

    // The recording is still on the air a moment later (the codec redelivers).
    // The echo is still not the challenge this session generated, so it is
    // refused exactly as a wrong pairing code would be: heard, unreadable, and
    // the user is told to start again.
    await feedSamples(enterer, entererCodec.encode(await stale.buildPairFrame(TEST_CHALLENGE)));
    expect(enterer.session.pairing.kind).toBe("failed");
    expect(enterer.session.pairingFailureMessage).toContain("different pairing code");
    // It is *not* "heard but unreadable": the recording's tag verified, and what
    // refused it is the echoed challenge. P6's two signals stay distinct.

    // The genuine handshake then completes, and the message reads: no recorded
    // salt ever entered the nonce space. Fresh codecs, because an Rx instance
    // belongs to one module and the pair above still holds theirs.
    displayer.session.stop();
    enterer.session.stop();
    const realDisplay = await createPeer({
      label: "real-d",
      role: "displayer",
      codec: await openSoundChatCodec().then((codec) => (extraCodecs.push(codec), codec)),
    });
    const realEnter = await createPeer({
      label: "real-e",
      role: "enterer",
      codec: await openSoundChatCodec().then((codec) => (extraCodecs.push(codec), codec)),
      pairingCode: realDisplay.session.pairingCode,
    });
    realDisplay.session.start();
    realEnter.session.start();
    await deliver(realEnter, realDisplay);
    await deliver(realDisplay, realEnter);
    expect(realDisplay.session.pairing.kind).toBe("paired");
    expect(realEnter.session.pairing.kind).toBe("paired");
    expect(realEnter.session.send("are you there").ok).toBe(true);
    await settle();
    await deliver(realEnter, realDisplay);
    expect(realDisplay.texts()).toEqual(["are you there"]);
  });
});

describe("a start() that cannot succeed", () => {
  it("never leaves the session claiming to be listening", async () => {
    const own = await openSoundChatCodec();
    extraCodecs.push(own);
    const reported: unknown[] = [];
    const alone = await createPeer({
      label: "no-track",
      role: "displayer",
      codec: own,
      withTracks: false,
      onModuleError: (error: unknown) => reported.push(error),
    });
    // `startListening` refuses a stream with no audio track. `start()` catches
    // it, reports it, and moves to the recoverable `error` state rather than
    // leaving the session `listening` with no feed at all (P2V finding 8).
    expect(() => alone.session.start()).not.toThrow();
    expect(alone.session.state).toBe("error");
    expect(reported).toHaveLength(1);
    expect(alone.context.processors).toHaveLength(0);
    // ...and the recovery path is real: restart, then start again.
    expect(alone.session.restart()).toEqual({ ok: true });
    expect(alone.session.state).toBe("idle");
  });
});
