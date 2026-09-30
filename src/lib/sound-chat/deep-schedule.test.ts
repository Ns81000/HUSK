/**
 * How a message's blocks are *scheduled* on the air.
 *
 * Phase 2V found that a 2-block message was transmitted as two `start()` calls
 * with no `when` argument, so both began at the same `context.currentTime` and
 * their waveforms **summed** at the destination. Two FSK bursts at volume 25 do
 * not decode, so the feature's headline 84-byte cap did not work over real audio
 * — while the whole suite stayed green, because every mock appended samples in
 * call order and so could not see a schedule at all.
 *
 * This file pins the schedule itself: the block start offsets, the Rx pause
 * window, and the fact that a paused sender cannot decode its own second block.
 * It is the guard master plan Section 10.1 class 4 asks for — a mock able to
 * misbehave, tested rather than assumed.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CODEC_SAMPLES_PER_FRAME,
  flushReceiver,
  openSoundChatCodec,
  type SoundChatCodec,
} from "./codec";
import { REQUIRED_SAMPLE_RATE } from "./audio-io";
import {
  BLOCK_DURATION_SECONDS,
  MAX_PENDING_MESSAGES,
  TRANSMIT_LEAD_SECONDS,
  TURN_GAP_MS,
  SoundChatSession,
  type SessionEvent,
  type SoundChatSessionOptions,
} from "./session";

const CODE = "ABCD2345";
const SAMPLE_FRAME = CODEC_SAMPLES_PER_FRAME;
const BLOCK_SAMPLES = 90 * SAMPLE_FRAME;

/** One scheduled playback: the samples and the AudioContext time they start at. */
type PlayEvent = { at: number; samples: Float32Array };

let roomClock = 10;

function advanceRoom(seconds: number): void {
  roomClock += seconds;
}

type FakeBuffer = {
  length: number;
  copied: Float32Array[];
  copyToChannel: (s: Float32Array) => void;
};

type FakeProcessor = {
  onaudioprocess:
    ((event: { inputBuffer: { getChannelData: (index: number) => Float32Array } }) => void) | null;
  connect: () => void;
  disconnect: () => void;
};

/**
 * A context that records the *schedule* rather than the fact of playing, and
 * that mixes overlapping sources exactly as a speaker does.
 */
class ScheduledAudioContext {
  readonly played: PlayEvent[] = [];
  readonly processors: FakeProcessor[] = [];
  pausedUntil = 0;
  lastPauseSeconds: number | null = null;
  closeCalls = 0;

  get currentTime(): number {
    return roomClock;
  }

  get sampleRate(): number {
    return REQUIRED_SAMPLE_RATE;
  }

  get destination(): unknown {
    return { connect: () => {}, disconnect: () => {} };
  }

  async resume(): Promise<this> {
    return this;
  }

  async close(): Promise<void> {
    this.closeCalls += 1;
    if (this.closeCalls > 1) throw new DOMException("closed", "InvalidStateError");
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
    const buffer: FakeBuffer = {
      length,
      copied: [],
      copyToChannel: (samples: Float32Array) => {
        buffer.copied.push(Float32Array.from(samples));
      },
    };
    return buffer;
  }

  createBufferSource = (): unknown => {
    const source = {
      buffer: null as FakeBuffer | null,
      startAtSeconds: 0,
      connect: () => source,
      start: (when?: number) => {
        // `start(0)` — and no argument at all — means "now" in the real API.
        source.startAtSeconds = when === undefined || when === 0 ? roomClock : when;
        const samples = source.buffer?.copied[0];
        if (samples !== undefined) this.played.push({ at: source.startAtSeconds, samples });
      },
    };
    return source;
  };
}

type MockTrack = { stop: () => void; label: string };

function mockStream(): MediaStream {
  const track: MockTrack = { stop: (): void => {}, label: "fake-mic" };
  const tracks = [track];
  return {
    getAudioTracks: () => tracks,
    getTracks: () => tracks,
  } as unknown as MediaStream;
}

type Peer = {
  readonly label: string;
  readonly context: ScheduledAudioContext;
  readonly session: SoundChatSession;
  readonly events: SessionEvent[];
  takeSchedule: () => PlayEvent[];
};

const createdPeers: Peer[] = [];
const MAX_FLUSH_TURNS = 12_000;

async function until(what: string, ready: () => boolean): Promise<void> {
  for (let turn = 0; turn < MAX_FLUSH_TURNS; turn += 1) {
    if (ready()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error(`timed out waiting for ${what}`);
}

/** A generous drain: a floor, then quiescence. */
async function settle(): Promise<void> {
  let quiet = 0;
  let turn = 0;
  // 32, not 4. A four-turn quiet streak is short enough that a libuv
  // threadpool callback from real AEAD work can land between two of the
  // samples, reset the streak, and leave this loop waiting out the cascade
  // until it hits MAX_FLUSH_TURNS - which is how a test that passes alone
  // fails under parallel load. A longer streak makes settle() return later
  // rather than earlier, which is the only safe direction: returning early
  // leaks work into the next settle, and returning late only costs turns.
  while (turn < 256 || quiet < 32) {
    const before = createdPeers.map((peer) => peer.context.played.length).join(",");
    await new Promise((resolve) => setImmediate(resolve));
    quiet =
      createdPeers.map((peer) => peer.context.played.length).join(",") === before ? quiet + 1 : 0;
    turn += 1;
  }
}

async function createPeer(options: {
  label: string;
  role: "displayer" | "enterer";
  codec: SoundChatCodec;
  pairingCode?: string;
}): Promise<Peer> {
  const context = new ScheduledAudioContext();
  const events: SessionEvent[] = [];
  const base = {
    codec: options.codec,
    context: context as unknown as AudioContext,
    stream: mockStream(),
    role: options.role,
    onEvent: (event: SessionEvent): void => {
      events.push(event);
    },
    onModuleError: (): void => {},
    onListenerError: (): void => {},
  } satisfies Omit<SoundChatSessionOptions, "pairingCode">;
  const session = await SoundChatSession.create(
    options.pairingCode === undefined ? base : { ...base, pairingCode: options.pairingCode },
  );
  const peer: Peer = {
    label: options.label,
    context,
    session,
    events,
    takeSchedule: () => {
      const taken = [...context.played];
      context.played.length = 0;
      return taken;
    },
  };
  createdPeers.push(peer);
  return peer;
}

/** Feeds a schedule into `to`, summing anything that overlaps, as a speaker does. */
function playInto(to: Peer, schedule: PlayEvent[]): number {
  if (schedule.length === 0) return 0;
  const rate = REQUIRED_SAMPLE_RATE;
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
  let frames = 0;
  const whole = Math.floor(mixed.length / SAMPLE_FRAME);
  for (let index = 0; index < whole; index += 1) {
    const chunk = mixed.subarray(index * SAMPLE_FRAME, (index + 1) * SAMPLE_FRAME);
    advanceRoom(SAMPLE_FRAME / rate);
    to.context.processors[0]?.onaudioprocess?.({ inputBuffer: { getChannelData: () => chunk } });
    frames += 1;
  }
  return frames;
}

async function converse(from: Peer, to: Peer, rounds = 8): Promise<void> {
  for (let round = 0; round < rounds; round += 1) {
    await until(`${from.label} to stop transmitting`, () => !from.session.transmitting);
    playInto(to, from.takeSchedule());
    await settle();
    // Two passes, so a reply that is armed while the first one fires also runs —
    // the same shape the driver relies on, and the reason a turn gap is a timer
    // and not a single hop.
    advanceRoom(TURN_GAP_MS / 1000);
    await settle();
    await vi.advanceTimersByTimeAsync(TURN_GAP_MS + 1);
    await settle();
    await vi.advanceTimersByTimeAsync(TURN_GAP_MS + 1);
    await settle();
  }
}

async function pairedPair(): Promise<{ displayer: Peer; enterer: Peer }> {
  const displayer = await createPeer({ label: "displayer", role: "displayer", codec: codecA });
  const enterer = await createPeer({
    label: "enterer",
    role: "enterer",
    codec: codecB,
    pairingCode: displayer.session.pairingCode,
  });
  displayer.session.start();
  enterer.session.start();
  for (let attempt = 0; attempt < 4; attempt += 1) {
    await converse(enterer, displayer, 2);
    await converse(displayer, enterer, 2);
    if (displayer.session.pairing.kind === "paired" && enterer.session.pairing.kind === "paired") {
      return { displayer, enterer };
    }
  }
  throw new Error("the handshake did not complete");
}

const codecA = await openSoundChatCodec();
const codecB = await openSoundChatCodec();

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  roomClock = 10;
  flushReceiver(codecA, 120);
  flushReceiver(codecB, 120);
});

afterEach(() => {
  for (const peer of createdPeers.splice(0)) peer.session.stop();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

afterAll(() => {
  /* The two module-level codecs are wasm modules; nothing of ours to release. */
});

describe("a multi-block message is scheduled, not stacked", () => {
  it("puts each block on the air exactly one block after the previous one", async () => {
    const { displayer } = await pairedPair();
    displayer.takeSchedule();
    expect(displayer.session.send("H".repeat(84))).toMatchObject({ ok: true, queued: false });
    await until("the transmission to be scheduled", () => !displayer.session.transmitting);

    const schedule = displayer.takeSchedule();
    // Two blocks, at the two-block cap.
    expect(schedule).toHaveLength(2);
    for (const event of schedule) {
      expect(event.samples).toHaveLength(BLOCK_SAMPLES);
    }
    const [first, second] = schedule;
    if (first === undefined || second === undefined) throw new Error("expected two blocks");
    // The whole point: the second block starts one block-length later. Two
    // `start()` calls with no `when` would both land on `currentTime`, and the
    // two FSK bursts would sum into something neither end can decode.
    expect(second.at - first.at).toBeCloseTo(BLOCK_DURATION_SECONDS, 6);
    // ...and the first is a little in the future, because `start(when)` treats a
    // past `when` as "now" and would collapse the schedule back onto one instant.
    expect(first.at).toBeGreaterThan(roomClock - BLOCK_DURATION_SECONDS);
  });

  it("holds its own Rx feed for the whole window plus the tail, not per block", async () => {
    const { displayer } = await pairedPair();
    displayer.takeSchedule();
    expect(displayer.session.send("H".repeat(84))).toMatchObject({ ok: true, queued: false });
    await until("the transmission to be scheduled", () => !displayer.session.transmitting);
    const schedule = displayer.takeSchedule();
    expect(schedule).toHaveLength(2);

    // Feeding the sender its own two blocks back must decode *nothing*: the Rx
    // feed was shut for the whole window. Pausing per block instead would leave
    // the second half of the transmission audible to the sender, and it would
    // decode its own second block.
    const decodedBefore = displayer.session.stats.blocksDecoded;
    playInto(displayer, schedule);
    await settle();
    expect(displayer.session.stats.blocksDecoded - decodedBefore).toBe(0);
  });

  it("plays a single-block message immediately, with no stacking window", async () => {
    const { displayer } = await pairedPair();
    displayer.takeSchedule();
    expect(displayer.session.send("short")).toMatchObject({ ok: true, queued: false });
    await until("the transmission to be scheduled", () => !displayer.session.transmitting);
    const schedule = displayer.takeSchedule();
    // One block, plus the receiver's ACK later in the exchange.
    expect(schedule).toHaveLength(1);
    expect(schedule[0]?.samples).toHaveLength(BLOCK_SAMPLES);
    // The lead is the only thing between "now" and the start.
    expect((schedule[0]?.at ?? 0) - roomClock).toBeLessThanOrEqual(TRANSMIT_LEAD_SECONDS + 0.001);
  });

  it("delivers a two-block message end to end, byte-exact, at the measured cap", async () => {
    const { displayer, enterer } = await pairedPair();
    const text = "the cap".repeat(12).slice(0, 84);
    expect(text).toHaveLength(84);
    expect(displayer.session.send(text)).toMatchObject({ ok: true, queued: false });
    await until("the transmission to be scheduled", () => !displayer.session.transmitting);
    const schedule = displayer.takeSchedule();
    expect(schedule).toHaveLength(2);
    // Both blocks on the air, and the peer assembles them in order — which is the
    // property the stacking bug destroyed.
    playInto(enterer, schedule);
    await settle();
    await vi.advanceTimersByTimeAsync(TURN_GAP_MS + 1);
    await settle();
    const messages = enterer.events.filter((event) => event.type === "message");
    expect(messages).toHaveLength(1);
    if (messages[0]?.type !== "message") throw new Error("expected a message");
    expect(messages[0].text).toBe(text);
    // The sender played exactly two blocks for an 84-byte message: no wasted
    // third block, and no block put on the air twice.
    expect(schedule).toHaveLength(2);
    expect(new Set(schedule.map((event) => event.at)).size).toBe(2);
    // The peer's acknowledgement is owed on both halves and it sends both, so the
    // sender's window is exercised rather than skipped.
    await converse(enterer, displayer, 2);
    expect(enterer.session.stats.acksSent).toBeGreaterThan(0);
    expect(enterer.session.stats.acksSent).toBeLessThanOrEqual(2);
  });

  it("keeps a burst inside the queue cap while the air is busy", async () => {
    const { displayer } = await pairedPair();
    let accepted = 0;
    for (let index = 0; index < MAX_PENDING_MESSAGES + 6; index += 1) {
      if (displayer.session.send(`burst ${index}`).ok) accepted += 1;
    }
    // A hard bound (P12): at most MAX_PENDING_MESSAGES messages exist at once.
    expect(accepted).toBeLessThanOrEqual(MAX_PENDING_MESSAGES);
    expect(displayer.session.send("overflow")).toEqual({ ok: false, reason: "queue-full" });
  });
});
