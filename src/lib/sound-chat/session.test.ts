/**
 * Session driver tests — the real codec, the real protocol, a mocked audio
 * layer. Master plan Section 10.1 (classes 1, 4, 5, 6, 10, 12) and Section 10.2
 * P4-P7, P11, P12, with the Section 10.3 hostile-input set for transport.
 *
 * The acoustic path is simulated the way Phase 0 did it in-process: whatever a
 * session "plays" is captured from its mocked AudioContext and fed back into the
 * other session's capture callback one 1024-sample frame at a time. The codec,
 * the frames, the AEAD and the timers are all real.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flushReceiver, openSoundChatCodec, type SoundChatCodec } from "./codec";
import { derivePairingKeys } from "./crypto";
import type { PairingRole } from "./pairing";
import { FrameCodec, MAX_MESSAGE_BLOCKS, MAX_SEND_ATTEMPTS } from "./protocol";
import { drainAsync } from "./drain.ts";
import {
  ACK_TIMEOUT_MS,
  BACKOFF_MAX_MS,
  BACKOFF_MIN_MS,
  BLOCK_DURATION_MS,
  MAX_PENDING_MESSAGES,
  PAIR_CONFIRM_TIMEOUT_MS,
  PAIR_PEER_TIMEOUT_MS,
  SoundChatSession,
  TURN_GAP_MS,
  type SessionEvent,
} from "./session";

/** A fixed handshake challenge; the session generates a fresh one per pairing. */
const TEST_CHALLENGE = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);

const CODE = "ABCD2345";
const SAMPLE_FRAME = 1024;

/** One scheduled playback: the samples and the AudioContext time they start at. */
type PlayEvent = { at: number; samples: Float32Array };

/**
 * One room clock shared by every fake context, advanced as audio is fed in —
 * exactly what wall-clock time does. Without it a peer's Rx-pause window (which
 * is measured on the AudioContext clock) would never expire and every feed
 * would be silently skipped, which is how this harness first exposed the
 * missing turn gap in the driver.
 */
let roomClock = 10;

function advanceRoom(seconds: number): void {
  roomClock += seconds;
}

/** Two wasm modules for the whole file: sessions come and go, the codecs do not. */
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

type FakeBuffer = {
  length: number;
  copied: Float32Array[];
  copyToChannel: (samples: Float32Array) => void;
};

/** A minimal AudioContext: playback and capture, with the "air" tappable. */
class FakeAudioContext {
  readonly sampleRate = 48_000;
  state = "running";
  readonly destination = { kind: "destination" };
  readonly processors: FakeProcessor[] = [];
  readonly played: PlayEvent[] = [];
  closeCalls = 0;

  /** The one room clock: real audio time, shared by both peers. */
  get currentTime(): number {
    return roomClock;
  }

  async resume(): Promise<unknown> {
    this.state = "running";
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
    return { gain: { value: 1 }, connect: () => {}, disconnect: () => {} };
  }

  createBuffer(_channels: number, length: number): FakeBuffer {
    const buffer: FakeBuffer = { length, copied: [], copyToChannel: () => {} };
    buffer.copyToChannel = (samples: Float32Array) => {
      // A copy, like the real API: the caller may reuse its array afterwards.
      buffer.copied.push(Float32Array.from(samples));
    };
    return buffer;
  }

  // An arrow field, so `this` is the context without aliasing it (which the
  // lint rules reject, correctly).
  //
  // `start(when)` records the *schedule*, not just the fact of playing. A mock
  // that ignored `when` structurally could not see two blocks scheduled at the
  // same instant — which is exactly the defect this file now guards: with
  // `start()` and no argument, a 2-block message's two waveforms overlapped and
  // summed at the destination, so the 84-byte cap was undecodable over real
  // audio while every test stayed green (Phase 2V, master plan Section 10.1
  // class 4).
  createBufferSource = (): unknown => {
    const source = {
      buffer: null as FakeBuffer | null,
      started: false,
      startAtSeconds: 0,
      connect: () => source,
      start: (when?: number) => {
        source.started = true;
        // `start(0)` means "now" in the real API, and so does no argument at all.
        source.startAtSeconds = when === undefined || when === 0 ? roomClock : when;
        const samples = source.buffer?.copied[0];
        if (samples !== undefined) this.played.push({ at: source.startAtSeconds, samples });
      },
    };
    return source;
  };
}

type MockTrack = { stop: () => void; label: string };
type MockStream = { getAudioTracks: () => MockTrack[]; getTracks: () => MockTrack[] };

function mockStream(): MockStream {
  const track: MockTrack = { stop: (): void => {}, label: "fake-mic" };
  return { getAudioTracks: () => [track], getTracks: () => [track] };
}

type Peer = {
  readonly label: string;
  readonly context: FakeAudioContext;
  readonly session: SoundChatSession;
  readonly events: SessionEvent[];
  readonly moduleErrors: unknown[];
  readonly listenerErrors: unknown[];
  /** Audio played but not yet taken by a `deliver`. */
  pendingAir: () => number;
  /** Everything this peer has played since the last call. */
  takeAir: () => Float32Array[];
  /** The same, with each block's scheduled AudioContext start time. */
  takeSchedule: () => PlayEvent[];
};

type PeerOptions = {
  label: string;
  role: PairingRole;
  codec: SoundChatCodec;
  pairingCode?: string;
  onEvent?: (event: SessionEvent) => void;
};

/** Every peer created in a test, stopped afterwards so no timer survives it. */
const createdPeers: Peer[] = [];

async function createPeer(options: PeerOptions): Promise<Peer> {
  const context = new FakeAudioContext();
  const events: SessionEvent[] = [];
  const moduleErrors: unknown[] = [];
  const listenerErrors: unknown[] = [];
  const base = {
    codec: options.codec,
    context: context as unknown as AudioContext,
    stream: mockStream() as unknown as MediaStream,
    role: options.role,
    onEvent: (event: SessionEvent): void => {
      events.push(event);
      options.onEvent?.(event);
    },
    onModuleError: (error: unknown): void => {
      moduleErrors.push(error);
    },
    onListenerError: (error: unknown): void => {
      listenerErrors.push(error);
    },
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
      const played = context.played.map((event) => event.samples);
      context.played.length = 0;
      return played;
    },
    takeSchedule: () => {
      const played = [...context.played];
      context.played.length = 0;
      return played;
    },
  };
  createdPeers.push(peer);
  return peer;
}

/** Feeds one waveform frame by frame; the room clock moves as it is heard. */
function feed(to: Peer, samples: Float32Array): number {
  let frames = 0;
  const whole = Math.floor(samples.length / SAMPLE_FRAME);
  for (let index = 0; index < whole; index += 1) {
    const chunk = samples.subarray(index * SAMPLE_FRAME, (index + 1) * SAMPLE_FRAME);
    advanceRoom(SAMPLE_FRAME / 48_000);
    to.context.processors[0]?.onaudioprocess?.({ inputBuffer: { getChannelData: () => chunk } });
    frames += 1;
  }
  return frames;
}

/**
 * Lays a *schedule* onto the room, summing anything that overlaps — which is
 * what a speaker does.
 *
 * This is the difference between a mock that can catch a scheduling bug and one
 * that cannot. A schedule of adjacent blocks (the correct one) lays down exactly
 * the same samples as a plain concatenation; a schedule where two blocks start at
 * the same instant — what `AudioBufferSourceNode.start()` with no argument
 * produces — sums two FSK bursts, and the real receiver decodes nothing. The
 * old mock appended in call order, so a 2-block message "worked" no matter how
 * the product scheduled it, and the 84-byte cap was untested against real audio
 * (Phase 2V, master plan Section 10.1 class 4).
 */
function feedSchedule(to: Peer, schedule: PlayEvent[]): number {
  if (schedule.length === 0) return 0;
  const rate = 48_000;
  let first = Number.POSITIVE_INFINITY;
  let last = Number.NEGATIVE_INFINITY;
  for (const event of schedule) {
    first = Math.min(first, event.at);
    last = Math.max(last, event.at + event.samples.length / rate);
  }
  const total = Math.max(0, Math.ceil((last - first) * rate));
  const mixed = new Float32Array(total);
  for (const event of schedule) {
    const offset = Math.round((event.at - first) * rate);
    for (let index = 0; index < event.samples.length; index += 1) {
      mixed[offset + index] = (mixed[offset + index] ?? 0) + (event.samples[index] ?? 0);
    }
  }
  return feed(to, mixed);
}

/**
 * Feeds a whole transmission — every block of it, back to back, exactly as the
 * sender transmits it — and then lets the turn gap pass, so any reply the
 * receiver owes has been played by the time this resolves.
 */
async function deliver(from: Peer, to: Peer): Promise<number> {
  // The sender must have finished before its air is taken: a two-block message
  // is two separate `start()` calls, and taking early feeds only the first.
  await transmitted(from);
  let frames = 0;
  frames += feedSchedule(to, from.takeSchedule());
  await settle();
  await passTurnGap();
  return frames;
}

/** The same, for a waveform a test built by hand rather than captured. */
async function feedSamples(to: Peer, samples: Float32Array): Promise<number> {
  const frames = feed(to, samples);
  await settle();
  await passTurnGap();
  return frames;
}

/** Lets a receiver's own reply finish transmitting before the air is used again. */
async function waitOutReply(): Promise<void> {
  advanceRoom(2.5);
  await settle();
  await vi.advanceTimersByTimeAsync(1_500);
  await settle();
}

/**
 * Waits out the driver's turn gap: what a replying device must leave before it
 * transmits, so its whole block lands inside the peer's listening window. Two
 * passes, so a timer armed while the first one fires also runs.
 */
async function passTurnGap(): Promise<void> {
  advanceRoom(TURN_GAP_MS / 1000);
  await settle();
  await vi.advanceTimersByTimeAsync(TURN_GAP_MS + 1);
  await settle();
  await vi.advanceTimersByTimeAsync(TURN_GAP_MS + 1);
  await settle();
}

/** A real hang must fail the test with a message, never spin forever. */
const MAX_FLUSH_TURNS = 12_000;
/**
 * A drain floor, not a completion condition. crypto.subtle hands results back on
 * libuv's threadpool, so the number of event-loop turns a seal/assemble chain needs is
 * load-dependent; 32 was measured to be too few under contention.
 */
const SETTLE_FLOOR_TURNS = 256;

/**
 * Waits until `ready` holds, yielding real `setImmediate` turns in between.
 * Bounded, so a genuine failure surfaces as this error rather than a timeout.
 */
async function until(what: string, ready: () => boolean): Promise<void> {
  for (let turn = 0; turn < MAX_FLUSH_TURNS; turn += 1) {
    if (ready()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error(`timed out waiting for ${what}`);
}

/**
 * Waits until `peer` has put everything it was going to transmit on the air.
 *
 * This replaces a fixed `setImmediate` turn count, which is *not* sufficient
 * here: `crypto.subtle` hands results back through libuv's threadpool, so how
 * many turns a seal/assemble chain needs is load-dependent. The old fixed count
 * failed about 40% of runs under contention (measured in Phase 2V: 4 of 10 full
 * suites, 1 of 5 in isolation), reading a half-finished session and reporting
 * `expected 0 to be >= 90`.
 *
 * The transport machine is the honest completion signal: a send stays
 * `transmitting` until its last block is played, then moves to `awaiting_ack`.
 * `SoundChatSession.transmitting` also covers the window after `send()` returns
 * but before the first block is played, so taking the air can never race the
 * pump.
 */
async function transmitted(peer: Peer): Promise<void> {
  await until(
    `${peer.label} to finish transmitting (state ${peer.session.state})`,
    () => !peer.session.transmitting,
  );
}

/**
 * Lets the async authentication/assembly chain finish.
 *
 * A drain, not a completion condition — call `transmitted()` or a
 * `pairing.kind` wait for that. Kept generous because a threadpool callback
 * can land several turns after the last observable change.
 */
async function settle(turns = 256): Promise<void> {
  await drainAsync({ activity, floorTurns: turns });
}

/** Everything a still-pending async chain would have to touch. */
function activity(): string {
  let signature = "";
  for (const peer of createdPeers) {
    const { session, context, events } = peer;
    signature += [
      session.state,
      session.pairing.kind,
      session.stats.blocksDecoded,
      session.stats.framesUnreadable,
      session.stats.messagesDelivered,
      session.stats.duplicatesSuppressed,
      session.stats.conflicts,
      session.stats.acksSent,
      session.stats.retries,
      events.length,
      context.played.length,
    ].join(",");
    signature += "|";
  }
  return signature;
}

/**
 * Runs the two-way pairing handshake to completion. Each `deliver` already waits
 * for its sender to finish and waits out the turn gap, so the displayer's answer
 * is played by the time the second delivery starts. The loop makes the handshake
 * condition-driven rather than pass-counted: it ends only once both sides have
 * actually paired, so a slow `crypto.subtle` round trip cannot leave a
 * half-finished handshake behind.
 */
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
    `handshake did not complete: displayer ${displayer.session.pairing.kind}, ` +
      `enterer ${enterer.session.pairing.kind}`,
  );
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
    removeEventListener: () => {
      visibilityHandlers = [];
    },
  });
}

function setVisibility(next: "visible" | "hidden"): void {
  visibility = next;
  for (const handler of [...visibilityHandlers]) handler();
}

beforeEach(() => {
  // `document` is stubbed per test only: the codec loader needs it to be absent.
  // Only the session's own timers are faked; `setImmediate` stays real so the
  // async authentication chain can be flushed.
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  roomClock = 10;
  visibility = "visible";
  visibilityHandlers = [];
  flushReceiver(codecA, 120);
  flushReceiver(codecB, 120);
});

afterEach(() => {
  // Every session a test created is torn down, so no timer or subscription
  // outlives the test that made it (10.1 class 6).
  for (const peer of createdPeers.splice(0)) peer.session.stop();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("pairing handshake", () => {
  it("pairs both devices when the code matches and unlocks sending", async () => {
    const displayer = await createPeer({ label: "displayer", role: "displayer", codec: codecA });
    const enterer = await createPeer({
      label: "enterer",
      role: "enterer",
      codec: codecB,
      pairingCode: displayer.session.pairingCode,
    });
    expect(displayer.session.pairing.kind).toBe("idle");
    await pairUp(displayer, enterer);
    expect(displayer.session.pairing.kind).toBe("paired");
    expect(enterer.session.pairing.kind).toBe("paired");
    expect(displayer.session.pairingCode).toBe(enterer.session.pairingCode);
    expect(displayer.session.stats.blocksDecoded).toBeGreaterThan(0);
    expect(displayer.session.state).toBe("listening");
    // The handshake really did go through the transport machine.
    const states = displayer.events.filter((event) => event.type === "transport");
    expect(states.length).toBeGreaterThan(0);
    // Sending is refused before pairing, accepted after.
    const late = await createPeer({ label: "late", role: "displayer", codec: codecA });
    expect(late.session.send("hello")).toEqual({ ok: false, reason: "not-paired" });
    expect(displayer.session.send("hello").ok).toBe(true);
  });

  it("reports a wrong code on the side that hears it, and nothing back", async () => {
    const displayer = await createPeer({ label: "displayer", role: "displayer", codec: codecA });
    const enterer = await createPeer({
      label: "enterer",
      role: "enterer",
      codec: codecB,
      pairingCode: "ABCD2346",
    });
    displayer.session.start();
    enterer.session.start();
    // The displayer can only fail once it has *received* the enterer's PAIR
    // frame and failed to open it with a key that does not match, so wait for
    // that outcome rather than a turn count. (This call was previously
    // un-awaited and relied on a later `settle()` covering it.)
    await deliver(enterer, displayer);
    await until(
      "the displayer to reject the wrong code",
      () => displayer.session.pairing.kind === "failed",
    );
    expect(displayer.session.pairing.kind).toBe("failed");
    expect(displayer.session.pairingFailureMessage).toContain("different pairing code");
    expect(displayer.events.some((event) => event.type === "heard-unreadable")).toBe(true);
    // The enterer heard no answer, so it is still waiting — never falsely paired.
    expect(enterer.session.pairing.kind).toBe("awaiting-confirmation");
    expect(displayer.session.send("nope")).toEqual({ ok: false, reason: "not-paired" });
  });

  it("refuses a code that cannot be one, before any key is derived", async () => {
    await expect(
      createPeer({ label: "short", role: "enterer", codec: codecB, pairingCode: "abcd12" }),
    ).rejects.toThrowError();
    await expect(
      createPeer({ label: "confusable", role: "enterer", codec: codecB, pairingCode: "abcdI234" }),
    ).rejects.toThrowError();
  });
});

describe("messages, acks and dedupe", () => {
  async function pairedPeers(): Promise<{ displayer: Peer; enterer: Peer }> {
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

  it("delivers a message and resolves the sender on the peer's ACK", async () => {
    const { displayer, enterer } = await pairedPeers();
    expect(displayer.session.send("hello there")).toMatchObject({ ok: true, queued: false });
    await transmitted(displayer);
    expect(await deliver(displayer, enterer)).toBeGreaterThanOrEqual(90);
    const messages = enterer.events.filter((event) => event.type === "message");
    expect(messages).toHaveLength(1);
    if (messages[0]?.type !== "message") throw new Error("expected a message event");
    expect(messages[0].text).toBe("hello there");
    expect(enterer.session.stats.messagesDelivered).toBe(1);
    expect(enterer.session.stats.acksSent).toBeGreaterThan(0);

    // The ACK was played during the turn gap; sending it back resolves the sender.
    await deliver(enterer, displayer);
    const outbound = displayer.events.filter((event) => event.type === "outbound");
    expect(outbound.at(-1)).toMatchObject({ status: "sent" });
    expect(displayer.session.state).toBe("listening");
    expect(displayer.session.stats.retries).toBe(0);
    expect(enterer.listenerErrors).toHaveLength(0);
    expect(displayer.listenerErrors).toHaveLength(0);
  });

  it("carries a two-block message at exactly the measured cap", async () => {
    const { displayer, enterer } = await pairedPeers();
    const text = "H".repeat(84);
    expect(displayer.session.send(text)).toMatchObject({ ok: true, queued: false });
    await transmitted(displayer);
    // Two blocks, one after the other: 180 frames of audio.
    expect(await deliver(displayer, enterer)).toBeGreaterThanOrEqual(180);
    const messages = enterer.events.filter((event) => event.type === "message");
    expect(messages).toHaveLength(1);
    if (messages[0]?.type !== "message") throw new Error("expected a message event");
    expect(messages[0].text).toBe(text);
    expect(displayer.session.send("H".repeat(85))).toEqual({ ok: false, reason: "too-long" });
  });

  it("renders one message however many times the codec redelivers the block (P4)", async () => {
    const { displayer, enterer } = await pairedPeers();
    expect(displayer.session.send("twice")).toMatchObject({ ok: true, queued: false });
    await transmitted(displayer);
    const waveform = displayer.takeAir()[0];
    if (waveform === undefined) {
      throw new Error(`expected a transmission, state is ${displayer.session.state}`);
    }
    // The real codec decodes the same block 2-4 times while it streams through
    // the window; the second feed models a retry arriving after a lost ACK.
    await feedSamples(enterer, waveform);
    await waitOutReply();
    await feedSamples(enterer, waveform);
    const messages = enterer.events.filter((event) => event.type === "message");
    expect(messages).toHaveLength(1);
    expect(enterer.session.stats.blocksDecoded).toBeGreaterThan(1);
    expect(enterer.session.stats.duplicatesSuppressed).toBeGreaterThan(0);
    // Every redelivery is answered, so a lost ACK cannot loop the sender.
    expect(enterer.session.stats.acksSent).toBeGreaterThan(0);
  });

  it("turns silence and an unreadable transmission into different signals (P5, P6)", async () => {
    const { displayer, enterer } = await pairedPeers();
    // The codec keeps re-decoding a block while it is inside its window, so
    // first flush the pairing audio; only then does silence mean silence.
    await feedSamples(enterer, new Float32Array(SAMPLE_FRAME * 200));
    const before = enterer.session.stats;
    // (a) nothing in the air at all.
    await feedSamples(enterer, new Float32Array(SAMPLE_FRAME * 90));
    expect(enterer.session.stats.blocksDecoded).toBe(before.blocksDecoded);
    expect(enterer.events.some((event) => event.type === "heard-unreadable")).toBe(false);
    expect(enterer.session.state).toBe("listening");

    // (b) a real frame whose tag is damaged: the codec decodes it, we cannot read
    // it. It is built with the *displayer's* identity and salt, so it is a frame
    // the enterer would otherwise accept — only the damage makes it unreadable.
    const keys = await derivePairingKeys(displayer.session.pairingCode);
    const impostor = new FrameCodec({
      keys,
      selfId: 0,
      sendSalt: displayer.session.sessionSalt,
    });
    const tampered = (
      await impostor.buildMessageFrames(new TextEncoder().encode("unreadable"), 0x7777)
    )[0] as Uint8Array;
    tampered[tampered.length - 1] = (tampered[tampered.length - 1] ?? 0) ^ 0x01;
    await feedSamples(enterer, codecA.encode(tampered));
    expect(enterer.session.stats.blocksDecoded).toBeGreaterThan(before.blocksDecoded);
    expect(enterer.session.stats.framesUnreadable).toBeGreaterThan(0);
    expect(enterer.events.some((event) => event.type === "heard-unreadable")).toBe(true);
    expect(enterer.events.some((event) => event.type === "message")).toBe(false);

    // (c) the same frame without the damage *is* read: the control that proves
    // the tampering is what changed the outcome, not the plumbing.
    const sound = (
      await impostor.buildMessageFrames(new TextEncoder().encode("readable"), 0x7778)
    )[0] as Uint8Array;
    await feedSamples(enterer, codecA.encode(sound));
    const messages = enterer.events.filter((event) => event.type === "message");
    expect(messages).toHaveLength(1);
    if (messages[0]?.type !== "message") throw new Error("expected a message event");
    expect(messages[0].text).toBe("readable");
  });

  it("ignores an ACK for a message it never sent, and a PAIR frame after pairing", async () => {
    const { displayer, enterer } = await pairedPeers();
    const keys = await derivePairingKeys(displayer.session.pairingCode);
    // An *authentic* ACK from the displayer's identity, for a message the
    // displayer never sent: it must not move anything.
    const impostor = new FrameCodec({
      keys,
      selfId: 0,
      sendSalt: displayer.session.sessionSalt,
    });
    await feedSamples(displayer, codecB.encode(await impostor.buildAckFrame(0x4321, 0b1)));
    expect(displayer.events.some((event) => event.type === "outbound")).toBe(false);
    expect(displayer.session.state).toBe("listening");

    // A replayed PAIR frame cannot move a session that is already paired either.
    const realEnterer = new FrameCodec({
      keys,
      selfId: 1,
      sendSalt: enterer.session.sessionSalt,
    });
    await feedSamples(displayer, codecB.encode(await realEnterer.buildPairFrame(TEST_CHALLENGE)));
    expect(displayer.session.pairing.kind).toBe("paired");
    expect(displayer.moduleErrors).toHaveLength(0);
  });
});

describe("retry, hold and failure (P11, P12)", () => {
  async function pairedPeers(): Promise<{ displayer: Peer; enterer: Peer }> {
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

  it("retries the same msgId with byte-identical audio, then gives up (P11)", async () => {
    const { displayer } = await pairedPeers();
    expect(displayer.session.send("no ack coming")).toMatchObject({ ok: true, queued: false });
    await transmitted(displayer);
    const first = displayer.takeAir()[0];
    if (first === undefined) throw new Error("expected a first attempt");
    const airings: Float32Array[] = [first];

    for (let attempt = 0; attempt < 2; attempt += 1) {
      // Both clocks, always: the ACK deadline and the backoff are wall-clock
      // `setTimeout`s, while the Rx pause our own transmission arms is measured on
      // the AudioContext clock. Advancing only the fake timers leaves the session
      // believing its speaker is still busy, so the retry is deferred for ever and
      // this wait times out.
      advanceRoom((ACK_TIMEOUT_MS + BACKOFF_MAX_MS + 1) / 1000);
      await vi.advanceTimersByTimeAsync(ACK_TIMEOUT_MS + BACKOFF_MAX_MS + 1);
      await settle();
      const again = displayer.takeAir()[0];
      expect(again, `retry ${attempt}`).toBeDefined();
      airings.push(again as Float32Array);
    }
    // A retry re-transmits the *same sealed frame*: same msgId, same nonce, same
    // plaintext — never a nonce reuse with different content.
    for (const airing of airings) {
      expect(Array.from(airing)).toEqual(Array.from(airings[0] as Float32Array));
    }

    // The attempt budget is exhausted: the message fails, and nothing loops.
    advanceRoom((ACK_TIMEOUT_MS + 1) / 1000);
    await vi.advanceTimersByTimeAsync(ACK_TIMEOUT_MS + 1);
    await settle();
    const outbound = displayer.events.filter((event) => event.type === "outbound");
    expect(outbound.at(-1)).toMatchObject({ status: "failed", attempts: 3 });
    // One submission across every retry — the property this test exists for.
    // Counted on `sendId`, not `msgId`: the accept-time `queued` record carries
    // a null `msgId`, so counting ids would read two identities where there is
    // one message, and would pass a genuinely duplicated message.
    expect(
      new Set(outbound.map((event) => (event.type === "outbound" ? event.sendId : -1))).size,
    ).toBe(1);
    const played = displayer.context.played.length;
    await vi.advanceTimersByTimeAsync(ACK_TIMEOUT_MS * 4);
    await settle();
    expect(displayer.context.played.length).toBe(played);
    expect(displayer.session.state).toBe("listening");
  });

  it("treats a peer message while awaiting our ACK as a collision (P11)", async () => {
    const { displayer, enterer } = await pairedPeers();
    expect(displayer.session.send("collide")).toMatchObject({ ok: true, queued: false });
    await transmitted(displayer);
    const firstAttempt = displayer.takeAir()[0];
    if (firstAttempt === undefined) throw new Error("expected a first attempt");
    // The peer transmits a couple of seconds later — after the displayer's own
    // Rx feed is listening again, which is what makes this a *heard* collision.
    advanceRoom(2.5);
    expect(enterer.session.send("after you")).toMatchObject({ ok: true, queued: false });
    await transmitted(enterer);
    await deliver(enterer, displayer);
    expect(displayer.events.some((event) => event.type === "message")).toBe(true);
    expect(displayer.session.stats.blocksDecoded).toBeGreaterThan(0);
    const states = displayer.events.filter((event) => event.type === "transport");
    expect(states.some((event) => event.type === "transport" && event.state === "backoff")).toBe(
      true,
    );
    // And the collision is handled by retrying the same message, not by lying:
    // the same msgId, the same sealed frame, after a jittered backoff.
    //
    // Both clocks again, and the retry's own air window with them: the ACK the
    // displayer owes the peer holds the turn for a block plus the measured tail,
    // and the retry follows it. Every window up to that point is drained, because
    // which window a given transmission lands in depends on the ordering of two
    // independent timers — the unseeded jittered backoff and the quiet moment.
    const airings = displayer.takeAir();
    await advanceRoom((BACKOFF_MAX_MS + 1) / 1000);
    await vi.advanceTimersByTimeAsync(BACKOFF_MAX_MS + 1);
    await settle();
    airings.push(...displayer.takeAir());
    advanceRoom(BLOCK_DURATION_MS / 1000 + 0.5);
    await vi.advanceTimersByTimeAsync(BLOCK_DURATION_MS + 500 + 1);
    await settle();
    airings.push(...displayer.takeAir());
    expect(airings).not.toHaveLength(0);
    expect(
      airings.some((airing) => Array.from(airing).join(",") === Array.from(firstAttempt).join(",")),
    ).toBe(true);
  });

  it("holds a send while hidden and resumes it when the tab returns (P11)", async () => {
    stubVisibility();
    const { displayer } = await pairedPeers();
    expect(displayer.session.state).toBe("listening");
    setVisibility("hidden");
    expect(displayer.session.state).toBe("hidden_hold");
    expect(displayer.session.send("while hidden")).toMatchObject({ ok: true, queued: false });
    await transmitted(displayer);
    await vi.advanceTimersByTimeAsync(TURN_GAP_MS * 4);
    await settle();
    expect(displayer.takeAir()).toHaveLength(0);
    expect(displayer.session.state).toBe("hidden_hold");

    setVisibility("visible");
    await settle();
    expect(displayer.takeAir()).toHaveLength(1);
    expect(displayer.session.state).toBe("awaiting_ack");
  });

  it("turns a codec throw mid-send into module_error, with no retry and no restart", async () => {
    const real = codecA;
    let encodes = 0;
    let dead = false;
    const flaky = {
      get state(): string {
        return dead ? "dead" : real.state;
      },
      encode(payload: Uint8Array): Float32Array {
        encodes += 1;
        // The pairing answer goes out; the message does not.
        if (encodes > 1) {
          dead = true;
          throw new Error("wasm trap");
        }
        return real.encode(payload);
      },
      decode(chunk: Float32Array): Uint8Array | null {
        return real.decode(chunk);
      },
    } as unknown as SoundChatCodec;
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
    await transmitted(displayer);
    expect(displayer.session.state).toBe("module_error");
    expect(displayer.moduleErrors).toHaveLength(1);
    const outbound = displayer.events.filter((event) => event.type === "outbound");
    expect(outbound.at(-1)).toMatchObject({ status: "failed" });
    expect(displayer.session.send("again")).toEqual({ ok: false, reason: "module-error" });
    // Recovery is a reload, and the session says so instead of pretending.
    expect(displayer.session.restart()).toEqual({ ok: false, reason: "codec-dead" });
    expect(displayer.session.state).toBe("module_error");
    const played = displayer.context.played.length;
    await vi.advanceTimersByTimeAsync(ACK_TIMEOUT_MS * 4);
    await settle();
    expect(displayer.context.played.length).toBe(played);
  });
});

describe("send refusals, consumer errors and teardown", () => {
  it("refuses empty, over-long, unpaired and overflowing sends without throwing", async () => {
    const alone = await createPeer({ label: "alone", role: "displayer", codec: codecA });
    expect(alone.session.send("hi")).toEqual({ ok: false, reason: "not-paired" });

    const displayer = await createPeer({ label: "displayer", role: "displayer", codec: codecA });
    const enterer = await createPeer({
      label: "enterer",
      role: "enterer",
      codec: codecB,
      pairingCode: displayer.session.pairingCode,
    });
    await pairUp(displayer, enterer);
    displayer.takeAir();

    expect(displayer.session.send("")).toEqual({ ok: false, reason: "empty" });
    expect(displayer.session.send("x".repeat(85))).toEqual({ ok: false, reason: "too-long" });
    expect(displayer.session.send("x".repeat(84)).ok).toBe(true);
    let refusal: string | undefined;
    for (let index = 0; index <= MAX_PENDING_MESSAGES + 2; index += 1) {
      const result = displayer.session.send(`queued ${index}`);
      if (!result.ok) {
        refusal = result.reason;
        break;
      }
    }
    expect(refusal).toBe("queue-full");
    // The queue is bounded, so only a bounded number of transmissions can follow.
    await settle();
    await vi.advanceTimersByTimeAsync(ACK_TIMEOUT_MS * 2);
    await settle();
    expect(displayer.context.played.length).toBeLessThanOrEqual(MAX_PENDING_MESSAGES + 3);
  });

  it("keeps feeding when its own event consumer throws (10.1 class 1)", async () => {
    let thrown = 0;
    const displayer = await createPeer({
      label: "displayer",
      role: "displayer",
      codec: codecA,
      onEvent: () => {
        thrown += 1;
        throw new Error("consumer bug");
      },
    });
    const enterer = await createPeer({
      label: "enterer",
      role: "enterer",
      codec: codecB,
      pairingCode: displayer.session.pairingCode,
    });
    await pairUp(displayer, enterer);
    if (thrown === 0) throw new Error("expected the consumer to have been called");
    // The handshake completed anyway, and the codec was never blamed.
    expect(displayer.session.pairing.kind).toBe("paired");
    expect(displayer.session.state).toBe("listening");
    expect(displayer.listenerErrors.length).toBe(thrown);
    expect(displayer.moduleErrors).toHaveLength(0);
    // And the feed is still alive: a message from the peer still arrives.
    expect(enterer.session.send("still here").ok).toBe(true);
    await transmitted(enterer);
    await deliver(enterer, displayer);
    expect(displayer.session.stats.blocksDecoded).toBeGreaterThan(0);
    expect(displayer.moduleErrors).toHaveLength(0);
  });

  it("tears down twice, stops feeding, and cannot be moved afterwards", async () => {
    const displayer = await createPeer({ label: "displayer", role: "displayer", codec: codecA });
    const enterer = await createPeer({
      label: "enterer",
      role: "enterer",
      codec: codecB,
      pairingCode: displayer.session.pairingCode,
    });
    await pairUp(displayer, enterer);
    const processor = displayer.context.processors[0];
    const decoded = displayer.session.stats.blocksDecoded;

    displayer.session.stop();
    displayer.session.stop();
    expect(displayer.session.state).toBe("idle");
    expect(processor?.onaudioprocess).toBeNull();

    feed(displayer, new Float32Array(SAMPLE_FRAME * 20));
    await settle();
    expect(displayer.session.stats.blocksDecoded).toBe(decoded);
    expect(displayer.events.at(-1)).toEqual({ type: "transport", state: "idle" });
    expect(displayer.session.send("after stop")).toEqual({ ok: false, reason: "stopped" });
    // Every timer is gone: nothing fires however far time is advanced.
    const played = displayer.context.played.length;
    await vi.advanceTimersByTimeAsync(ACK_TIMEOUT_MS * 4);
    await settle();
    expect(displayer.context.played.length).toBe(played);
  });
});

describe("the timing contract the medium sets (10.2 P11, class 11)", () => {
  it("derives every deadline from the measured 1.92 s block", () => {
    // 90 whole 1024-sample frames at 48000 Hz. Everything below is arithmetic on
    // this one measurement, so a changed protocol constant must move them all.
    expect(BLOCK_DURATION_MS).toBe(Math.round((90 * 1024 * 1000) / 48_000));
    // 0.5 s of measured Rx pause tail + 200 ms of decode/scheduling margin.
    expect(TURN_GAP_MS).toBe(700);
    // Two blocks + the turn gap + the peer's own ACK block + 1 s of slack. The
    // timer is armed when the audio is *scheduled*, so the window has to cover
    // the whole round trip from the first sample leaving us — which for the
    // longest message the cap allows is
    // `2 x 1920 + 700 + 1920 + 1000`.
    expect(ACK_TIMEOUT_MS).toBe(
      BLOCK_DURATION_MS * MAX_MESSAGE_BLOCKS + TURN_GAP_MS + BLOCK_DURATION_MS + 1_000,
    );
    expect(ACK_TIMEOUT_MS).toBe(7_460);
    // A one-block message gets the tighter window, so a lost ACK on a short
    // message is still noticed promptly.
    expect(BLOCK_DURATION_MS * 1 + TURN_GAP_MS + BLOCK_DURATION_MS + 1_000).toBeLessThan(
      ACK_TIMEOUT_MS,
    );
    expect(BACKOFF_MAX_MS).toBeGreaterThan(BACKOFF_MIN_MS);
    // Long enough to cover a two-block send plus a human reacting to the code.
    expect(PAIR_CONFIRM_TIMEOUT_MS).toBe(BLOCK_DURATION_MS * 2 + 2_000);
    expect(PAIR_PEER_TIMEOUT_MS).toBeGreaterThan(PAIR_CONFIRM_TIMEOUT_MS);
  });

  it("gives up on a displayer that never hears a peer, and says so", async () => {
    const alone = await createPeer({ label: "alone", role: "displayer", codec: codecA });
    alone.session.start();
    expect(alone.session.pairing.kind).toBe("waiting-for-peer");
    // Nothing else advances time in this test, so the boundary is exact.
    await vi.advanceTimersByTimeAsync(PAIR_PEER_TIMEOUT_MS - 1);
    expect(alone.session.pairing.kind).toBe("waiting-for-peer");
    await vi.advanceTimersByTimeAsync(2);
    await settle();
    expect(alone.session.pairing.kind).toBe("failed");
    expect(alone.session.pairingFailureMessage).toContain("No paired device was heard");
    // Failing closed: a timeout never looks like a pairing.
    expect(alone.session.send("anyone there?")).toEqual({ ok: false, reason: "not-paired" });
  });

  it("gives up on an enterer that hears no confirmation", async () => {
    const displayer = await createPeer({ label: "displayer", role: "displayer", codec: codecA });
    const enterer = await createPeer({
      label: "enterer",
      role: "enterer",
      codec: codecB,
      pairingCode: displayer.session.pairingCode,
    });
    displayer.session.start();
    enterer.session.start();
    // Only the enterer's PAIR frame is delivered; the answer never comes back.
    // `deliver` already advances the turn gap, so this measures from the point
    // the frame landed. The exact 1 ms boundary is pinned by the displayer test
    // above, where nothing else advances the clock.
    await deliver(enterer, displayer);
    displayer.takeAir();
    expect(enterer.session.pairing.kind).toBe("awaiting-confirmation");
    await vi.advanceTimersByTimeAsync(PAIR_CONFIRM_TIMEOUT_MS);
    await settle();
    expect(enterer.session.pairing.kind).toBe("failed");
    expect(enterer.session.pairingFailureMessage).toContain("did not answer");
    // The displayer did pair with someone, so only the enterer failed — and the
    // enterer never claims a pairing it did not get.
    expect(displayer.session.pairing.kind).toBe("paired");
    expect(enterer.session.send("anyone there?")).toEqual({ ok: false, reason: "not-paired" });
  });

  it("keeps the outbound queue bounded when the peer never acknowledges", async () => {
    const displayer = await createPeer({ label: "displayer", role: "displayer", codec: codecA });
    const enterer = await createPeer({
      label: "enterer",
      role: "enterer",
      codec: codecB,
      pairingCode: displayer.session.pairingCode,
    });
    await pairUp(displayer, enterer);
    expect(displayer.session.send("lost ack")).toMatchObject({ ok: true, queued: false });
    await transmitted(displayer);
    // The peer hears nothing at all, so nothing is ever acked: the session must
    // exhaust its attempts and report a failure per message, never grow (P12).
    for (let index = 0; index < MAX_PENDING_MESSAGES + 6; index += 1) {
      displayer.session.send(`queued ${index}`);
    }
    // Both clocks, and *repeatedly*: every attempt is an ACK timeout plus a
    // backoff plus the air window that retry then holds open, and all of it is
    // measured on two different clocks. Advancing once by a multiple of the ACK
    // timeout does not cover it, because a session whose speaker still believes
    // it is talking simply defers the next attempt.
    for (let round = 0; round < MAX_SEND_ATTEMPTS * (MAX_PENDING_MESSAGES + 2); round += 1) {
      advanceRoom((ACK_TIMEOUT_MS + BACKOFF_MAX_MS + BLOCK_DURATION_MS + 500) / 1000);
      await vi.advanceTimersByTimeAsync(ACK_TIMEOUT_MS + BACKOFF_MAX_MS + BLOCK_DURATION_MS + 500);
      await settle();
    }
    const failed = displayer.events.filter(
      (event: SessionEvent) => event.type === "outbound" && event.status === "failed",
    );
    expect(failed.length).toBeGreaterThan(0);
    // Nothing unbounded accumulated, and the session is still usable.
    expect(displayer.session.state).not.toBe("module_error");
    expect(displayer.moduleErrors).toHaveLength(0);
  });
});
