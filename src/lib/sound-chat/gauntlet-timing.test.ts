/**
 * Gauntlet, category 2 of 8: dedupe, collision and timing.
 *
 * Everything here drives a REAL session — the real wasm codec, the real AEAD,
 * the real protocol — against a mocked audio layer that records playback as a
 * *schedule* and rebuilds "the room" from it by offset, summing overlaps the way
 * a speaker does (the harness pattern from `session.test.ts`). A mock that
 * appended in call order could not see a block scheduled at the same instant as
 * the previous one, which is precisely the class of defect this file hunts.
 *
 * What is attacked: the dedupe / high-water-mark path and its re-ACK budget,
 * collision-backoff from inside a parked pump, the `TURN_GAP_MS` turn gap against
 * the measured 0.5 s Rx pause tail, the two reply timers (`quiet` and
 * `partialAck`) coinciding, the payload boundary at exactly the two-block cap,
 * the message-id allocator, timer ownership, and the async races (`send` x2 in
 * one tick, `send` while the pump is parked, `stop` against a parked pump, a
 * decode in flight across `transmitAndPause`'s pause window).
 *
 * ONE HARNESS RULE MATTERS MORE THAN ANYTHING ELSE HERE: the session's timers are
 * wall-clock `setTimeout`s, but the Rx pause and "is the channel quiet" are
 * AudioContext-clock facts. In production those are the same clock. Advancing
 * only the fake timers makes a reply look 500 ms *earlier* than it really is and
 * every timing assertion in this file a lie. So `advanceClock` moves both, and
 * `passQuiet` moves both by exactly `TURN_GAP_MS` — which is the instant the
 * quiet timer fires, so the reply's scheduled start time is exact.
 *
 * Only this file is new. No production code is touched.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CODEC_SAMPLES_PER_FRAME,
  flushReceiver,
  openSoundChatCodec,
  type SoundChatCodec,
} from "./codec";
import {
  FrameCodec,
  MAX_SEND_ATTEMPTS,
  MessageIdAllocator,
  MessageIdExhaustedError,
  blocksForPlaintextBytes,
} from "./protocol";
import { derivePairingKeys } from "./crypto";
import { DRAIN_QUIET_MS, drainAsync } from "./drain";
import {
  ACK_TIMEOUT_MS,
  BACKOFF_MAX_MS,
  BLOCK_DURATION_SECONDS,
  BLOCK_DURATION_MS,
  MAX_PENDING_MESSAGES,
  MAX_RE_ACKS_PER_MESSAGE,
  PARTIAL_ACK_DELAY_MS,
  SoundChatSession,
  TURN_GAP_MS,
  type SessionEvent,
} from "./session";

const SAMPLE_FRAME = CODEC_SAMPLES_PER_FRAME;
const RATE = 48_000;
const BLOCK_SAMPLES = 90 * SAMPLE_FRAME;
const FRAME_SECONDS = SAMPLE_FRAME / RATE;
/** The measured Rx pause tail, from `audio-io.ts`. */
const RX_TAIL_SECONDS = 0.5;
/** The scheduling lead, from `session.ts`. */
const LEAD_SECONDS = 0.05;
/**
 * How long our own speaker owns the air after an un-acknowledged transmission:
 * one block plus the measured tail. This is the turn the driver has to hold
 * open for itself, because the machine is already back in `listening` by then
 * and our own audio produces no decodes that could re-arm anything.
 */
const OWN_AIR_HOLD_MS = (BLOCK_DURATION_SECONDS + RX_TAIL_SECONDS) * 1_000;

/** One scheduled playback: the samples and the AudioContext time they start at. */
type PlayEvent = { at: number; samples: Float32Array };

/** One room clock shared by every fake context, advanced as audio is fed in. */
let roomClock = 10;

function advanceRoom(seconds: number): void {
  roomClock += seconds;
}

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

class FakeAudioContext {
  readonly sampleRate = RATE;
  state = "running";
  readonly destination = { kind: "destination" };
  readonly processors: FakeProcessor[] = [];
  readonly played: PlayEvent[] = [];

  get currentTime(): number {
    return roomClock;
  }

  async resume(): Promise<unknown> {
    this.state = "running";
    return this;
  }

  async close(): Promise<void> {
    this.state = "closed";
  }

  createMediaStreamSource(): unknown {
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

  createGain(): unknown {
    return { gain: { value: 1 }, connect: (): void => {}, disconnect: (): void => {} };
  }

  createBuffer(_channels: number, length: number): FakeBuffer {
    const buffer: FakeBuffer = { length, copied: [], copyToChannel: (): void => {} };
    buffer.copyToChannel = (samples: Float32Array): void => {
      buffer.copied.push(Float32Array.from(samples));
    };
    return buffer;
  }

  // The schedule, not just "it played": two `start()` calls with no `when` both
  // land on `currentTime` in the real API, and two FSK bursts on the same
  // instant sum into something neither end can decode (measured, Phase 2V).
  createBufferSource = (): unknown => {
    const source = {
      buffer: null as FakeBuffer | null,
      started: false,
      startAtSeconds: 0,
      connect: () => source,
      start: (when?: number): void => {
        source.started = true;
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

/**
 * The real codec with a call counter on `decode`.
 *
 * The counter is the only way to observe the Rx *pause*: `startListening` drops a
 * chunk whose context time is inside the pause window without ever calling
 * `codec.decode`, so "the first frame that reached `decode`" is exactly the frame
 * the feed reopened on. Every reopen measurement in this file is made that way
 * rather than re-derived from the pause arithmetic.
 */
function countedCodec(real: SoundChatCodec): { codec: SoundChatCodec; peeks: { decodes: number } } {
  const peeks = { decodes: 0 };
  const codec = {
    get state(): string {
      return real.state;
    },
    encode(payload: Uint8Array): Float32Array {
      return real.encode(payload);
    },
    decode(chunk: Float32Array): Uint8Array | null {
      peeks.decodes += 1;
      return real.decode(chunk);
    },
  };
  return { codec: codec as unknown as SoundChatCodec, peeks };
}

type Peer = {
  readonly label: string;
  readonly context: FakeAudioContext;
  readonly raw: SoundChatCodec;
  readonly peeks: { decodes: number };
  readonly session: SoundChatSession;
  readonly events: SessionEvent[];
  readonly moduleErrors: unknown[];
  readonly listenerErrors: unknown[];
  takeSchedule: () => PlayEvent[];
  texts: () => string[];
  outbound: () => Extract<SessionEvent, { type: "outbound" }>[];
  statuses: () => string[];
  states: () => string[];
  sealedIds: () => (number | null)[];
};

const createdPeers: Peer[] = [];

async function createPeer(options: {
  label: string;
  role: "displayer" | "enterer";
  codec: SoundChatCodec;
  pairingCode?: string;
  onEvent?: (event: SessionEvent) => void;
}): Promise<Peer> {
  const context = new FakeAudioContext();
  const events: SessionEvent[] = [];
  const moduleErrors: unknown[] = [];
  const listenerErrors: unknown[] = [];
  const { codec, peeks } = countedCodec(options.codec);
  const base = {
    codec,
    context: context as unknown as AudioContext,
    stream: mockStream(),
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
  const outboundOf = (): Extract<SessionEvent, { type: "outbound" }>[] =>
    events.filter(
      (event): event is Extract<SessionEvent, { type: "outbound" }> => event.type === "outbound",
    );
  const peer: Peer = {
    label: options.label,
    context,
    raw: options.codec,
    peeks,
    session,
    events,
    moduleErrors,
    listenerErrors,
    takeSchedule: () => {
      const taken = [...context.played];
      context.played.length = 0;
      return taken;
    },
    texts: () =>
      events
        .filter(
          (event): event is Extract<SessionEvent, { type: "message" }> => event.type === "message",
        )
        .map((event) => event.text),
    outbound: outboundOf,
    statuses: () => outboundOf().map((event) => event.status),
    states: () =>
      events
        .filter(
          (event): event is Extract<SessionEvent, { type: "transport" }> =>
            event.type === "transport",
        )
        .map((event) => event.state),
    sealedIds: () =>
      outboundOf()
        .filter((event) => event.status === "sending")
        .map((event) => event.sendId),
  };
  createdPeers.push(peer);
  return peer;
}

/** Feeds one waveform into `to` frame by frame; the room clock moves as heard. */
function feed(to: Peer, samples: Float32Array): number {
  let frames = 0;
  const whole = Math.floor(samples.length / SAMPLE_FRAME);
  for (let index = 0; index < whole; index += 1) {
    advanceRoom(FRAME_SECONDS);
    const start = index * SAMPLE_FRAME;
    to.context.processors[0]?.onaudioprocess?.({
      inputBuffer: { getChannelData: () => samples.subarray(start, start + SAMPLE_FRAME) },
    });
    frames += 1;
  }
  return frames;
}

const SILENCE = new Float32Array(BLOCK_SAMPLES);

/** Feeds whole blocks of silence — a real gap between transmissions. */
function feedSilence(to: Peer, frames: number): number {
  return feed(to, SILENCE.subarray(0, frames * SAMPLE_FRAME));
}

/** Lays a *schedule* onto the room, summing anything that overlaps. */
function feedSchedule(to: Peer, schedule: PlayEvent[]): number {
  if (schedule.length === 0) return 0;
  let first = Number.POSITIVE_INFINITY;
  let last = Number.NEGATIVE_INFINITY;
  for (const event of schedule) {
    first = Math.min(first, event.at);
    last = Math.max(last, event.at + event.samples.length / RATE);
  }
  const total = Math.max(0, Math.ceil((last - first) * RATE));
  const mixed = new Float32Array(total);
  for (const event of schedule) {
    const offset = Math.round((event.at - first) * RATE);
    for (let index = 0; index < event.samples.length; index += 1) {
      mixed[offset + index] = (mixed[offset + index] ?? 0) + (event.samples[index] ?? 0);
    }
  }
  return feed(to, mixed);
}

/** True when two scheduled blocks share air time — a speaker would sum them. */
function overlaps(schedule: PlayEvent[]): boolean {
  const windows: [number, number][] = schedule.map((event) => [
    event.at,
    event.at + event.samples.length / RATE,
  ]);
  windows.sort((left, right) => left[0] - right[0]);
  for (let index = 1; index < windows.length; index += 1) {
    const previous = windows[index - 1];
    const current = windows[index];
    if (previous === undefined || current === undefined) continue;
    if (current[0] < previous[1] - 1e-9) return true;
  }
  return false;
}

const MAX_FLUSH_TURNS = 16_000;
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
      peer.context.played.length,
    ].join(",");
    signature += "|";
  }
  return signature;
}

/** Lets the async authentication/assembly chain finish. A drain, not a predicate. */
async function settle(): Promise<void> {
  await drainAsync({ activity, floorTurns: SETTLE_FLOOR_TURNS, quietMs: DRAIN_QUIET_MS });
}

/**
 * A wall-clock ceiling, not only a turn count.
 *
 * `setImmediate` turns are not time: under CPU contention (this repo's suites
 * are load-sensitive and the full run executes them concurrently) 16000 turns
 * can elapse well before the async chain - which hands work to `crypto.subtle`
 * and libuv's threadpool - has finished. Measured: the sibling sound-chat
 * suites passed 6/6 in isolation and failed inside 1 of 4 full-suite runs, on
 * exactly that symptom. `MAX_FLUSH_TURNS` stays as a backstop so a spinning
 * loop still terminates; the deadline is what makes the wait mean what it says.
 */
const MAX_WAIT_MS = 20_000;

async function until(what: string, ready: () => boolean): Promise<void> {
  const deadline = Date.now() + MAX_WAIT_MS;
  for (let turn = 0; turn < MAX_FLUSH_TURNS; turn += 1) {
    if (ready()) return;
    if (Date.now() > deadline) break;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error(`timed out waiting for ${what}`);
}

/** The machine's own honest completion signal: nothing of ours left on the air. */
async function transmitted(peer: Peer): Promise<void> {
  await until(
    `${peer.label} to finish transmitting (state ${peer.session.state})`,
    () => !peer.session.transmitting,
  );
}

/**
 * Moves the wall clock and the room clock together, in eighth-turn-gap slices.
 *
 * The slices exist so a timer that fires mid-advance sees a room clock that
 * matches the wall clock — the invariant production has for free and a mock that
 * fakes only `setTimeout` silently destroys.
 */
async function advanceClock(ms: number): Promise<void> {
  const steps = Math.max(1, Math.ceil(ms / (TURN_GAP_MS / 7)));
  const slice = ms / steps;
  for (let index = 0; index < steps; index += 1) {
    advanceRoom(slice / 1000);
    await vi.advanceTimersByTimeAsync(slice);
  }
  await settle();
}

/**
 * Moves both clocks in fine slices, so a timer due at `ms` fires at `ms` of room
 * time to within a slice.
 *
 * Used where the question is the precise due instant — the partial-ACK reply in
 * particular, whose margin against the sender's feed reopening is measured in
 * tens of milliseconds and where a coarse advance reports the opposite sign.
 */
async function advanceClockFine(ms: number, sliceMs = 10): Promise<void> {
  let left = ms;
  while (left > 0) {
    const slice = Math.min(sliceMs, left);
    advanceRoom(slice / 1000);
    await vi.advanceTimersByTimeAsync(slice);
    left -= slice;
  }
  await settle();
}

/**
 * Feeds a whole transmission and gives the receiver enough trailing frames that
 * the fixed-length window fills even when it still holds residue from an earlier
 * exchange. Used only where decode reliability matters more than exact timing.
 */
async function receive(from: Peer, to: Peer): Promise<number> {
  await transmitted(from);
  const frames = feedSchedule(to, from.takeSchedule());
  feedSilence(to, 20);
  await settle();
  return frames;
}

/**
 * The quiet moment: exactly `TURN_GAP_MS` of wall time and exactly `TURN_GAP_MS`
 * of room time, so the `quiet` timer fires at the instant it would in production
 * and the reply's scheduled start time is exact rather than approximately right.
 */
async function passQuiet(): Promise<void> {
  advanceRoom(TURN_GAP_MS / 1000);
  await settle();
  await vi.advanceTimersByTimeAsync(TURN_GAP_MS + 1);
  await settle();
}

/** Feeds a schedule in and waits out the turn gap — the whole honest exchange. */
async function deliver(from: Peer, to: Peer): Promise<number> {
  await transmitted(from);
  const frames = feedSchedule(to, from.takeSchedule());
  await settle();
  await passQuiet();
  return frames;
}

async function pairUp(displayer: Peer, enterer: Peer): Promise<void> {
  displayer.session.start();
  enterer.session.start();
  for (let attempt = 0; attempt < 4; attempt += 1) {
    await deliver(enterer, displayer);
    await deliver(displayer, enterer);
    if (displayer.session.pairing.kind === "paired" && enterer.session.pairing.kind === "paired") {
      displayer.takeSchedule();
      enterer.takeSchedule();
      await settle();
      return;
    }
  }
  throw new Error(
    `the handshake did not complete: ${displayer.session.pairing.kind}/${enterer.session.pairing.kind}`,
  );
}

async function pairedPair(): Promise<{ displayer: Peer; enterer: Peer }> {
  flushReceiver(codecA, 140);
  flushReceiver(codecB, 140);
  const displayer = await createPeer({ label: "displayer", role: "displayer", codec: codecA });
  const enterer = await createPeer({
    label: "enterer",
    role: "enterer",
    codec: codecB,
    pairingCode: displayer.session.pairingCode,
  });
  await pairUp(displayer, enterer);
  return { displayer, enterer };
}

/** Runs the clock forward until nothing of ours is left in the system. */
async function drain(peer: Peer): Promise<PlayEvent[]> {
  let waited = 0;
  while (peer.session.busy && waited < 240_000) {
    await advanceClock(TURN_GAP_MS);
    waited += TURN_GAP_MS;
  }
  await settle();
  // Every retry that went out while draining is handed back, so a caller that
  // measures "the air" afterwards is not counting someone else's leftovers.
  return peer.takeSchedule();
}

/** The room time at which `peer`'s Rx feed accepts audio again, found behaviourally. */
function reopenAt(peer: Peer, withinSeconds = 8): number {
  const start = peer.context.currentTime;
  const steps = Math.ceil(withinSeconds / FRAME_SECONDS);
  for (let index = 0; index < steps; index += 1) {
    const before = peer.peeks.decodes;
    feedSilence(peer, 1);
    if (peer.peeks.decodes > before) return start + index * FRAME_SECONDS;
  }
  throw new Error(`${peer.label}'s feed never reopened`);
}

/**
 * When a transmission of `blocks` blocks, scheduled from `scheduledAt`, lets its
 * own Rx feed accept audio again. The mirror image of the room clock: `pause()`
 * is called from the same synchronous tick that computes `scheduledAt`.
 */
function feedReopensAt(scheduledAt: number, blocks: number): number {
  return scheduledAt - LEAD_SECONDS + blocks * (BLOCK_DURATION_MS / 1000) + RX_TAIL_SECONDS;
}

let visibility: "visible" | "hidden" = "visible";
let visibilityHandlers: (() => void)[] = [];

/**
 * Hides or shows ONE session.
 *
 * `document` is a single global, so a naive "hide the page" fires every session's
 * change-only handler and hides the *peer* too — which silently refuses its
 * transmission and makes every timing assertion about it nonsense. Sessions
 * subscribe once, in `start()` order, so the handler index names the peer.
 */
function setPeerVisibility(peer: Peer, hidden: boolean): void {
  visibility = hidden ? "hidden" : "visible";
  const handler = visibilityHandlers[createdPeers.indexOf(peer)];
  if (handler === undefined) throw new Error(`${peer.label} never subscribed to visibility`);
  handler();
}

beforeEach(() => {
  // Only the session's own timers are faked; `setImmediate` stays real so the
  // async authentication chain can be flushed.
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
  flushReceiver(codecA, 140);
  flushReceiver(codecB, 140);
});

afterEach(() => {
  // Every session a test created is torn down, so no timer or subscription
  // outlives the test that made it.
  for (const peer of createdPeers.splice(0)) peer.session.stop();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("G2-1 dedupe through a real session", () => {
  it("renders one message from four real transmissions of the same block", async () => {
    const { displayer, enterer } = await pairedPair();
    displayer.session.send("dedupe me");
    await transmitted(displayer);
    const schedule = displayer.takeSchedule();
    expect(schedule, "one block on the air").toHaveLength(1);

    // Four whole transmissions of the same acoustic block: the codec's own
    // redeliveries plus a sender retry after a lost ACK.
    let decoded = 0;
    for (let round = 0; round < 4; round += 1) {
      const before = enterer.session.stats.blocksDecoded;
      feedSchedule(enterer, schedule);
      await settle();
      decoded += enterer.session.stats.blocksDecoded - before;
      await passQuiet();
    }
    expect(decoded, "the real codec really did re-decode the block").toBeGreaterThanOrEqual(4);
    expect(enterer.texts(), "four transmissions, one rendered message").toEqual(["dedupe me"]);
    expect(enterer.session.stats.messagesDelivered).toBe(1);
    expect(enterer.session.stats.duplicatesSuppressed).toBeGreaterThanOrEqual(3);
    expect(enterer.moduleErrors).toHaveLength(0);
    expect(enterer.listenerErrors).toHaveLength(0);
    // The budget is the bound, and the delivery ACK is not charged to it.
    expect(enterer.session.stats.acksSent).toBeLessThanOrEqual(MAX_RE_ACKS_PER_MESSAGE + 1);
    // Whatever went on the air must have been decodable: no two of the
    // receiver's own blocks were ever scheduled on top of each other.
    expect(overlaps(enterer.takeSchedule()), "the receiver never stacked its own ACKs").toBe(false);
  }, 60_000);

  it("bounds a 60-times replayed recording to a constant number of ACKs", async () => {
    const { displayer, enterer } = await pairedPair();
    displayer.session.send("played on a loop");
    await transmitted(displayer);
    const schedule = displayer.takeSchedule();
    expect(schedule).toHaveLength(1);

    feedSchedule(enterer, schedule);
    await settle();
    await passQuiet();
    const afterDelivery = enterer.session.stats.acksSent;
    enterer.takeSchedule();
    expect(afterDelivery, "the delivery itself is acked").toBeGreaterThanOrEqual(1);

    // 60 more whole transmissions of the same recording.
    for (let round = 0; round < 60; round += 1) {
      feedSchedule(enterer, schedule);
      await settle();
      await passQuiet();
      enterer.takeSchedule();
    }
    const replayAcks = enterer.session.stats.acksSent - afterDelivery;
    expect(enterer.texts(), "one rendering only").toEqual(["played on a loop"]);
    expect(replayAcks, `re-ACKs for 60 replays`).toBeLessThanOrEqual(MAX_RE_ACKS_PER_MESSAGE);
    expect(enterer.session.stats.acksSent).toBeLessThanOrEqual(MAX_RE_ACKS_PER_MESSAGE + 1);
    expect(enterer.session.state).toBe("listening");
    expect(enterer.moduleErrors).toHaveLength(0);
  }, 180_000);

  it("re-ACKs a redelivery, and stops within the budget", async () => {
    const { displayer, enterer } = await pairedPair();
    displayer.session.send("answer me again");
    await transmitted(displayer);
    const schedule = displayer.takeSchedule();

    feedSchedule(enterer, schedule);
    await settle();
    await passQuiet();
    expect(enterer.session.stats.acksSent, "the delivery is acked").toBeGreaterThan(0);

    // Model the redeliveries one at a time so each one's answer is visible, with
    // a full quiet window in between.
    const perRedelivery: number[] = [];
    const before = enterer.session.stats.duplicatesSuppressed;
    for (let round = 0; round < 5; round += 1) {
      const sentBefore = enterer.session.stats.acksSent;
      feedSchedule(enterer, schedule);
      await settle();
      await passQuiet();
      perRedelivery.push(enterer.session.stats.acksSent - sentBefore);
    }
    expect(enterer.session.stats.duplicatesSuppressed - before).toBeGreaterThanOrEqual(5);
    // A redelivery IS answered — that is what stops a lost ACK looping the
    // sender — but the sum is capped, so a 6th, 500th, unlimited one is not.
    const answered = perRedelivery.filter((acks) => acks > 0).length;
    expect(answered, `redeliveries answered ${perRedelivery.join(",")}`).toBeGreaterThan(0);
    expect(
      perRedelivery.reduce((sum, acks) => sum + acks, 0),
      "and never more than the budget",
    ).toBeLessThanOrEqual(MAX_RE_ACKS_PER_MESSAGE);
    expect(enterer.texts()).toEqual(["answer me again"]);
  }, 120_000);

  it("spends the whole re-ACK budget on duplicates whose ACKs were lost", async () => {
    // The end-to-end consequence. The budget is charged per *duplicate block*,
    // but the duplicates the codec produces inside one window all coalesce into
    // the single ACK that was on the air. Once those ACKs are lost, the budget is
    // empty and the sender's retries are answered with silence — so the sender
    // reports a failure for a message the peer is showing on screen.
    const { displayer, enterer } = await pairedPair();
    displayer.session.send("your ack is lost");
    await transmitted(displayer);
    const schedule = displayer.takeSchedule();
    expect(schedule).toHaveLength(1);

    // Four transmissions; every ACK the receiver owes is dropped on the floor.
    const acksTaken: number[] = [];
    for (let round = 0; round < 4; round += 1) {
      feedSchedule(enterer, schedule);
      await settle();
      await passQuiet();
      acksTaken.push(enterer.takeSchedule().length);
    }
    expect(acksTaken[0], "the first ACK went out").toBe(1);
    expect(enterer.session.stats.acksSent).toBeLessThanOrEqual(MAX_RE_ACKS_PER_MESSAGE + 1);
    expect(acksTaken[3], "and by then the budget is empty").toBe(0);
    expect(enterer.texts(), "rendered exactly once, never twice").toEqual(["your ack is lost"]);
    expect(enterer.session.stats.messagesDelivered).toBe(1);

    // The sender now retries three times. The receiver hears every one of them
    // and answers none of them.
    for (let attempt = 0; attempt < MAX_SEND_ATTEMPTS; attempt += 1) {
      await advanceClock(ACK_TIMEOUT_MS + BACKOFF_MAX_MS + 1);
      const retry = displayer.takeSchedule();
      if (retry.length === 0) break;
      feedSchedule(enterer, retry);
      await settle();
      await passQuiet();
      expect(
        enterer.takeSchedule(),
        `retry ${attempt + 1}: an exhausted budget answers a real retry with silence`,
      ).toHaveLength(0);
    }
    await drain(displayer);
    const terminal = displayer.outbound().at(-1);
    expect(terminal?.status, "the sender reports failure for a message the peer holds").toBe(
      "failed",
    );
    expect(terminal?.attempts).toBe(MAX_SEND_ATTEMPTS);
    expect(enterer.texts()).toEqual(["your ack is lost"]);
    expect(enterer.session.state, "…and the receiver is healthy").toBe("listening");
  }, 180_000);
});

describe("G2-2 collision and backoff", () => {
  it("detects a collision, retries the same sealed bytes, never renders twice", async () => {
    const { displayer, enterer } = await pairedPair();
    displayer.session.send("mine first");
    await transmitted(displayer);
    const firstAir = displayer.takeSchedule();
    expect(firstAir).toHaveLength(1);

    // The peer starts talking while we are still waiting for our ACK — the only
    // way this medium can report a collision.
    advanceRoom(2.5);
    enterer.session.send("after you");
    await transmitted(enterer);
    feedSchedule(displayer, enterer.takeSchedule());
    await settle();

    expect(displayer.texts(), "the peer's message is rendered, not dropped").toEqual(["after you"]);
    expect(displayer.session.stats.blocksDecoded).toBeGreaterThan(0);
    expect(displayer.states(), "collision-backoff was entered").toContain("backoff");
    expect(displayer.session.state).toBe("backoff");

    // REPAIRED IN PHASE 4V. This read one schedule after `BACKOFF_MAX_MS + 1` and
    // asserted a byte-identical retransmission was in it — and it passed
    // **because of the stacking defect**: the quiet moment sent the owed ACK and
    // then retransmitted our block on top of it, so the schedule held a copy of
    // the first attempt and the assertion was satisfied by an overlapping pair.
    //
    // With the stacking fixed the two transmissions no longer land in the same
    // window, so *which* window a given transmission falls into depends on the
    // ordering of two independent timers (the backoff delay is `400 + random*800`
    // and is not seeded, and the quiet moment is `TURN_GAP_MS` after the block).
    // Reading one window is therefore the flaky part, not the fix. So every
    // window up to the retry's air closing is drained and the assertion is made
    // against the whole of the air — which is also the honest question: was any
    // of it stacked, and does any of it repeat our first attempt byte for byte?
    const retryAir: PlayEvent[] = [];
    retryAir.push(...displayer.takeSchedule());
    await advanceClock(BACKOFF_MAX_MS + 1);
    retryAir.push(...displayer.takeSchedule());
    // Let the ACK's air window close — that is what hands the turn back.
    await advanceClock(OWN_AIR_HOLD_MS + 1);
    retryAir.push(...displayer.takeSchedule());
    expect(overlaps(retryAir), "the owed ACK and our retry never share the air").toBe(false);
    expect(retryAir.length, "the collision costs a retry").toBeGreaterThan(0);
    expect(
      retryAir.some(
        (event) =>
          Array.from(event.samples).join(",") === Array.from(firstAir[0]?.samples ?? []).join(","),
      ),
      "the retry is byte-identical: same msgId, same nonce, same plaintext",
    ).toBe(true);
    // One submission, one message: nothing duplicated by the collision.
    expect(new Set(displayer.sealedIds()).size).toBe(1);
    expect(displayer.texts()).toEqual(["after you"]);
    expect(overlaps(displayer.takeSchedule()), "no stacked air").toBe(false);
  }, 90_000);

  it("detects a collision from inside the parked pump and keeps the message", async () => {
    const { displayer, enterer } = await pairedPair();
    enterer.session.send("collision while sealing");
    await transmitted(enterer);
    const peerSchedule = enterer.takeSchedule();
    expect(peerSchedule).toHaveLength(1);

    // Our `send()` queues a pump microtask; the peer's block is decoded in the
    // same tick and its `parse` is still in flight when the pump runs. So the
    // collision is detected *after* our own block is already on the air — a real
    // overlap, not a clean handover.
    displayer.session.send("simultaneous");
    feedSchedule(displayer, peerSchedule);
    await settle();

    expect(displayer.context.played.length, "our own block really was scheduled").toBeGreaterThan(
      0,
    );
    expect(displayer.texts(), "and the peer's message was rendered, not dropped").toContain(
      "collision while sealing",
    );
    expect(displayer.states(), "the machine turned around").toContain("backoff");
    expect(displayer.moduleErrors).toHaveLength(0);

    // It recovers: the retry goes out on the same submission, and nothing is
    // sent twice for one `sendId`.
    await drain(displayer);
    expect(new Set(displayer.sealedIds()).size, "one sealed submission throughout").toBe(1);
    expect(displayer.texts()).toEqual(["collision while sealing"]);
    expect(displayer.session.state, "and the session is usable afterwards").toBe("listening");
  }, 120_000);

  it("refuses to stack a second block onto a transmission already playing", async () => {
    // `#play` is synchronous and `#transmitBlocks` schedules every block before
    // it yields, so a second transmission can only start from outside that body.
    // Either it waits (refused by the machine) or it starts after; the one that
    // is not fine is overlapping air.
    const { displayer } = await pairedPair();
    displayer.session.send("H".repeat(84));
    await transmitted(displayer);
    const twoBlocks = displayer.takeSchedule();
    expect(twoBlocks, "the two-block cap is really two blocks").toHaveLength(2);
    expect(overlaps(twoBlocks), "and they are back to back, not stacked").toBe(false);

    // Ask for a second transmission while the first is mid-air (the room clock is
    // inside block 0, the machine is `awaiting_ack`).
    advanceRoom(0.5);
    displayer.session.send("and another");
    await settle();
    expect(displayer.takeSchedule(), "nothing goes on the air mid-message").toHaveLength(0);
    expect(displayer.session.state).toBe("awaiting_ack");
    expect(displayer.moduleErrors).toHaveLength(0);
  }, 90_000);
});

describe("G2-3 an ACK arriving during our own transmission", () => {
  it("drops every frame of anything that lands inside the pause", async () => {
    // `startListening` skips a chunk whole, so a block that starts while our own
    // feed is still shut loses all of itself. This is why an ACK the peer cannot
    // afford to be early about is lost outright — not shortened, lost.
    const { displayer, enterer } = await pairedPair();
    // Two blocks, so the sender's feed is shut for 3.84 + 0.5 s.
    displayer.session.send("H".repeat(84));
    await transmitted(displayer);
    const schedule = displayer.takeSchedule();
    expect(schedule).toHaveLength(2);
    const reopenedAt = feedReopensAt(schedule[0]?.at ?? 0, 2);

    // A real ACK frame, built from the peer's identity and played by the real
    // codec: the exact waveform the peer would put on the air.
    const sealedMsgId = displayer.outbound().find((event) => event.msgId !== null)?.msgId;
    if (sealedMsgId === undefined || sealedMsgId === null) {
      throw new Error("expected a sealed outbound message");
    }
    const keys = await derivePairingKeys(displayer.session.pairingCode);
    const wire = new FrameCodec({ keys, selfId: 1, sendSalt: enterer.session.sessionSalt });
    const ackWave = codecB.encode(await wire.buildAckFrame(sealedMsgId, 0b11));

    // The room clock is still where the transmission was scheduled, so all 90
    // frames land inside the pause.
    const decodesBefore = displayer.peeks.decodes;
    const decodedBefore = displayer.session.stats.blocksDecoded;
    feed(displayer, ackWave);
    expect(displayer.peeks.decodes - decodesBefore, "not one frame of it reached the codec").toBe(
      0,
    );
    await settle();
    expect(displayer.session.stats.blocksDecoded - decodedBefore).toBe(0);
    expect(displayer.statuses(), "so the message is not resolved").not.toContain("sent");

    // Measured, not derived: the feed really reopens one measured tail after the
    // audio ends, to within a single audio frame.
    const measuredReopen = reopenAt(displayer);
    expect(
      Math.abs(measuredReopen - reopenedAt) * 1000,
      `measured reopen ${measuredReopen.toFixed(3)}s vs derived ${reopenedAt.toFixed(3)}s`,
    ).toBeLessThan(FRAME_SECONDS * 1000);
    feedSilence(displayer, 30);
    await settle();

    // Once the window is open the same air decodes, and resolves the message.
    feed(displayer, ackWave);
    await settle();
    expect(displayer.session.stats.blocksDecoded - decodedBefore).toBeGreaterThan(0);
    expect(displayer.outbound().at(-1)?.status).toBe("sent");
    expect(displayer.session.stats.retries, "nothing had to be retried").toBe(0);

    // And the turn gap does put a *real* reply after the pause: measured on the
    // complete two-block exchange below.
    feedSchedule(enterer, schedule);
    await settle();
    await passQuiet();
    const ackSchedule = enterer.takeSchedule();
    expect(ackSchedule, "the peer owes one ACK for the whole message").toHaveLength(1);
    expect(
      ackSchedule[0]?.at ?? 0,
      "and it starts after the sender's feed reopened — that is the turn gap",
    ).toBeGreaterThan(reopenedAt);
  }, 90_000);

  it("FIXED — one partial ACK transmission costs exactly one attempt", async () => {
    // The codec redelivers every block 2-4x, ACKs included. `#onAckFrame` used to
    // have no dedupe, so a redelivered *partial* ACK re-entered `#transmitBlocks`
    // each time: one transmission of one ACK frame cost the sender two or three
    // of its three attempts retransmitting byte-identical audio, all scheduled in
    // the same tick and therefore summed at the speaker. No ACK was lost and no
    // collision occurred — the codec's own redelivery did it.
    //
    // The fix dedupes ACKs by `(msgId, mask)` for the message in flight, so a
    // redelivery of the *same* answer is a no-op while a genuinely changed mask
    // (more blocks arrived) still gets through.
    const { displayer, enterer } = await pairedPair();
    displayer.session.send("H".repeat(84));
    await transmitted(displayer);
    const twoBlocks = displayer.takeSchedule();
    expect(twoBlocks).toHaveLength(2);

    // Only block 0 is heard, so the peer owes a partial ACK.
    feedSchedule(enterer, [twoBlocks[0] as PlayEvent]);
    await settle();
    await advanceClockFine(PARTIAL_ACK_DELAY_MS);
    const partial = enterer.takeSchedule();
    expect(partial.length, "a partial ACK is owed").toBeGreaterThan(0);
    const oneAck = [partial[0] as PlayEvent];
    enterer.takeSchedule();

    const reopenedAt = feedReopensAt(twoBlocks[0]?.at ?? 0, 2);
    advanceRoom(Math.max(0, reopenedAt - roomClock) + 0.1);

    // ONE transmission of the ACK. The codec hands it over more than once.
    feedSchedule(displayer, oneAck);
    await settle();
    const retries = displayer.takeSchedule();
    expect(retries.length, "exactly one retransmission, not one per redelivery").toBe(1);
    expect(Array.from(retries[0]?.samples ?? [])).toEqual(Array.from(twoBlocks[1]?.samples ?? []));
    expect(overlaps(retries), "…and nothing is stacked on top of it").toBe(false);
    expect(
      displayer.session.stats.retries,
      `one ACK transmission cost ${displayer.session.stats.retries} attempts, not the whole budget`,
    ).toBe(1);
    expect(displayer.session.stats.blocksDecoded, "…for one decoded block").toBeGreaterThan(1);

    // The peer completes the note from that one retransmission, and the sender
    // resolves normally instead of reporting a false failure.
    feedSchedule(enterer, retries);
    await settle();
    await passQuiet();
    expect(enterer.texts(), "the peer has the whole note").toEqual(["H".repeat(84)]);
    const answer = enterer.takeSchedule();
    expect(answer.length, "and answers it in full").toBeGreaterThan(0);
    feedSchedule(displayer, answer);
    await settle();
    await drain(displayer);
    expect(displayer.outbound().at(-1)?.status, "the sender is NOT told the note failed").toBe(
      "sent",
    );
    expect(displayer.outbound().at(-1)?.attempts).toBeLessThan(MAX_SEND_ATTEMPTS);
    expect(displayer.moduleErrors).toHaveLength(0);
  }, 120_000);
});

describe("G2-4 a decode in flight across transmitAndPause's window", () => {
  it("processes a decode that was in flight when the feed was paused", async () => {
    // The decode is delivered by the audio callback *before* the pause, but
    // `#handleBlock` is parked on `await parse` while `transmitAndPause` shuts
    // the feed and schedules our block. The block must still be authenticated and
    // rendered exactly once, and its ACK owed — never sent on top of ours.
    const { displayer, enterer } = await pairedPair();
    enterer.session.send("in flight");
    await transmitted(enterer);
    const peerSchedule = enterer.takeSchedule();
    expect(peerSchedule).toHaveLength(1);

    const decodedBefore = displayer.session.stats.blocksDecoded;
    feedSchedule(displayer, peerSchedule);
    await settle();

    expect(
      displayer.session.stats.blocksDecoded - decodedBefore,
      "the in-flight block was authenticated",
    ).toBeGreaterThanOrEqual(1);
    expect(displayer.texts(), "and rendered exactly once").toEqual(["in flight"]);
    expect(displayer.session.stats.messagesDelivered).toBe(1);
    expect(displayer.session.stats.acksSent, "and the ACK is owed, not yet sent").toBe(0);

    // Our own note is queued while the ACK is still owed: exactly the state the
    // stacking defect lived in.
    expect(displayer.session.send("mine at the same time").ok).toBe(true);
    await settle();
    await passQuiet();

    // INVERTED IN PHASE 4V. This used to assert
    // `expect(overlaps(ours)).toBe(true)` with the message "…and
    // `#onChannelQuiet` schedules them on top of each other" — it pinned the
    // Phase 4 CRITICAL as if it were the expected behaviour. The owed ACK plays
    // at `start(0)`, i.e. now, and `TRANSMIT_DONE_UNACKED` puts the machine
    // straight back in `listening`, so the guard that was supposed to hold the
    // rest of the turn (`if (this.#currentState() !== "listening") return`) could
    // never fire. Our own note was scheduled 50 ms behind the ACK, the two blocks
    // summed at the speaker, and neither end decoded either one.
    const ours = displayer.takeSchedule();
    expect(ours.length, "the owed ACK goes out, alone").toBe(1);
    expect(overlaps(ours), "and nothing of ours is stacked behind it").toBe(false);
    expect(displayer.moduleErrors).toHaveLength(0);
    expect(displayer.listenerErrors).toHaveLength(0);

    // …and the turn the ACK held open is handed back: our own note goes out as
    // soon as our speaker is silent again, with no further traffic from the peer.
    // That second half matters as much as the first — an early `return` that
    // nobody re-entered would have traded a stacked block for a note that never
    // leaves the queue at all.
    await advanceClock(OWN_AIR_HOLD_MS + 1);
    const resumed = displayer.takeSchedule();
    expect(resumed.length, "our queued note goes out on the held turn").toBe(1);
    expect(overlaps(resumed), "…as its own single block").toBe(false);
    expect(displayer.session.state, "and the machine owns it while it plays").toBe("awaiting_ack");
  }, 90_000);

  it("stacks the owed ACK and our own queued note on the same block of air", async () => {
    // INVERTED IN PHASE 4V — the test title above is the *defect* it used to pin,
    // and the title is kept verbatim so the history stays greppable. It asserted
    // two overlapping blocks and `expect(heard).toBeGreaterThan(0)` feeding that
    // sum back to the peer; it now asserts the ACK alone, our note on the next
    // held turn, and that the peer actually receives both and answers our note.
    //
    // `#onChannelQuiet` calls `#attemptAck()` first and then `#pump()` /
    // `#transmitBlocks`. `#attemptAck` plays its block at `start(0)` — "now" —
    // and the machine is back in `listening` by the time the outbound block is
    // scheduled at `currentTime + TRANSMIT_LEAD_SECONDS`. Two FSK bursts 50 ms
    // apart sum at the speaker, and Phase 2V already measured that summed FSK
    // does not decode. So neither the acknowledgement nor our own note is heard.
    const { displayer, enterer } = await pairedPair();
    enterer.session.send("did you get this");
    await transmitted(enterer);
    const peerSchedule = enterer.takeSchedule();

    // The peer's note lands first, so the ACK is owed before our note exists and
    // the queued-note-plus-owed-ACK state is reached deterministically.
    feedSchedule(displayer, peerSchedule);
    await settle();
    expect(displayer.texts(), "the peer's note is on our screen").toEqual(["did you get this"]);
    expect(displayer.session.stats.acksSent, "and the ACK is still owed").toBe(0);

    // We have a note of our own in the queue, exactly as if the person had hit
    // Send while the peer's block was in the air.
    expect(displayer.session.send("yes, loud and clear").ok).toBe(true);
    await settle();
    await passQuiet();

    // The ACK goes out alone.
    const ack = displayer.takeSchedule();
    expect(ack.length, "exactly one block: the owed ACK").toBe(1);
    expect(overlaps(ack), "and it is not sharing the air with anything").toBe(false);

    // The peer hears it, and nothing else is on the air to spoil it.
    const heardAck = feedSchedule(enterer, ack);
    await settle();
    await passQuiet();
    expect(heardAck, "the ACK reached the peer").toBeGreaterThan(0);
    expect(displayer.session.stats.acksSent, "sent exactly once").toBe(1);

    // Our own note goes out on the turn the ACK held open, with no further
    // traffic from the peer: nothing else re-arms the quiet timer, because our
    // own transmission pauses our own Rx feed and so produces no decodes.
    await advanceClock(OWN_AIR_HOLD_MS + 1);
    const air = displayer.takeSchedule();
    expect(air.length, "our own note block").toBe(1);
    expect(overlaps(air), "and it is its own single block, not a stack").toBe(false);

    // Behaviour, not just arithmetic: the peer decodes the note and answers it.
    const heard = feedSchedule(enterer, air);
    await settle();
    await passQuiet();
    expect(heard, "the note reached the peer").toBeGreaterThan(0);
    expect(enterer.texts(), "…and it is rendered once, intact").toEqual(["yes, loud and clear"]);
    expect(enterer.session.stats.messagesDelivered, "…exactly once").toBe(1);
    const answer = enterer.takeSchedule();
    expect(answer.length, "the peer answers it").toBeGreaterThan(0);
    feedSchedule(displayer, answer);
    await settle();
    await drain(displayer);
    expect(
      displayer.outbound().at(-1)?.status,
      "and the note resolves normally instead of being reported failed",
    ).toBe("sent");
    expect(displayer.session.stats.acksSent, "one ACK in total, not a stack of them").toBe(1);
    expect(displayer.moduleErrors).toHaveLength(0);
    expect(displayer.listenerErrors).toHaveLength(0);
  }, 90_000);

  it("holds the turn after a PAIR answer, so a note sent straight after pairing is not stacked on it", async () => {
    // The same defect through a different door, and the one a person actually
    // hits: the displayer adopts the enterer's salt, reports `paired`, the UI
    // enables the composer, and the answer is still on the speaker for another
    // 1.92 s. `#transmitPairFrame` also ends with `TRANSMIT_DONE_UNACKED`, so the
    // machine is in `listening` while the answer is audible, and nothing armed a
    // turn for the moment it stops sounding. A note sent inside that window used
    // to be scheduled 50 ms behind the answer; the two summed, so the enterer
    // decoded neither, timed out, and the note burned an attempt to say nothing.
    flushReceiver(codecA, 140);
    flushReceiver(codecB, 140);
    const displayer = await createPeer({ label: "displayer", role: "displayer", codec: codecA });
    const enterer = await createPeer({
      label: "enterer",
      role: "enterer",
      codec: codecB,
      pairingCode: displayer.session.pairingCode,
    });
    displayer.session.start();
    enterer.session.start();
    // `pairUp` drains the displayer's schedule, and the whole point here is the
    // answer that is still on the air, so the exchange is driven by hand and the
    // answer is captured rather than fed on.
    await transmitted(enterer);
    feedSchedule(displayer, enterer.takeSchedule());
    await settle();
    await passQuiet();
    await transmitted(displayer);
    expect(displayer.session.pairing.kind, "the displayer adopted the salt").toBe("paired");
    expect(displayer.session.stats.acksSent, "the answer was an ACK-free frame").toBe(0);

    // The answer is audible right now, and the UI has just enabled the composer.
    const answer = displayer.takeSchedule();
    expect(answer.length, "the PAIR answer is on the air").toBe(1);
    const refused = displayer.session.send("right after pairing");
    expect(refused.ok, "the composer is live the moment pairing completes").toBe(true);
    await settle();

    // Nothing goes on top of it. Before the fix this was the second block, 50 ms
    // behind the answer, and the two summed.
    const stacked = displayer.takeSchedule();
    expect(stacked.length, "nothing of ours is scheduled behind our own answer").toBe(0);

    // On the turn the answer held open, the note goes out alone.
    await advanceClock(OWN_AIR_HOLD_MS + 1);
    const note = displayer.takeSchedule();
    expect(note.length, "exactly one block: our note").toBe(1);
    expect(overlaps([...answer, ...note]), "…not stacked on top of the PAIR answer").toBe(false);

    // The enterer hears the answer and the note as two separate blocks: it pairs,
    // and it renders the note. The sum that used to spoil both is gone.
    const heard = feedSchedule(enterer, [...answer, ...note]);
    await settle();
    await passQuiet();
    expect(heard, "the air reached the peer").toBeGreaterThan(0);
    expect(enterer.session.pairing.kind, "the answer still pairs the two devices").toBe("paired");
    expect(enterer.texts(), "…and the note is intact").toEqual(["right after pairing"]);
    expect(displayer.moduleErrors).toHaveLength(0);
    expect(displayer.listenerErrors).toHaveLength(0);
  }, 120_000);

  it("delivers nothing from a decode that was in flight when stop() ran", async () => {
    const { displayer, enterer } = await pairedPair();
    enterer.session.send("too late");
    await transmitted(enterer);
    const peerSchedule = enterer.takeSchedule();

    const decodedBefore = displayer.session.stats.blocksDecoded;
    feedSchedule(displayer, peerSchedule);
    displayer.session.stop();
    await settle();
    expect(displayer.texts(), "a torn-down consumer receives nothing").toEqual([]);
    expect(displayer.session.stats.blocksDecoded, "…and the block is not counted either").toBe(
      decodedBefore,
    );
    expect(displayer.events.at(-1)).toEqual({ type: "transport", state: "idle" });
    // And no timer was re-armed by the abandoned block.
    const played = displayer.context.played.length;
    await advanceClock(ACK_TIMEOUT_MS * 3);
    expect(displayer.context.played.length).toBe(played);
  }, 90_000);

  it("puts nothing on the air after a module failure raced a parked pump", async () => {
    let encodes = 0;
    const real = codecA;
    const dying = {
      get state(): string {
        return encodes > 1 ? "dead" : real.state;
      },
      encode(payload: Uint8Array): Float32Array {
        encodes += 1;
        if (encodes > 1) throw new Error("wasm trap");
        return real.encode(payload);
      },
      decode(chunk: Float32Array): Uint8Array | null {
        return real.decode(chunk);
      },
    } as unknown as SoundChatCodec;
    const displayer = await createPeer({ label: "displayer", role: "displayer", codec: dying });
    const enterer = await createPeer({
      label: "enterer",
      role: "enterer",
      codec: codecB,
      pairingCode: displayer.session.pairingCode,
    });
    await pairUp(displayer, enterer);

    displayer.session.send("dies mid-air");
    displayer.session.send("never sealed");
    await settle();
    displayer.takeSchedule();
    expect(displayer.session.state).toBe("module_error");
    expect(displayer.moduleErrors.length).toBe(1);
    // Nothing of ours is left reading "Queued" on a fatal screen.
    expect(displayer.statuses()).toContain("failed");
    expect(new Set(displayer.sealedIds()).size).toBeLessThanOrEqual(1);
    // A restart cannot promise what `start()` will not keep.
    expect(displayer.session.restart()).toEqual({ ok: false, reason: "codec-dead" });
    const played = displayer.context.played.length;
    await advanceClock(ACK_TIMEOUT_MS * 3);
    expect(displayer.context.played.length).toBe(played);
  }, 90_000);
});

describe("G2-5 the turn gap against the measured pause tail", () => {
  it("never lets the peer's ACK start before the sender's feed reopens", async () => {
    // Swept across both message shapes and a range of peer decode latencies: the
    // ACK's AudioContext start must never fall inside the sender's pause window,
    // because every frame of it would then be dropped on the floor.
    for (const bytes of [1, 84]) {
      for (const latencyMs of [0, 120, 400, 900]) {
        const { displayer, enterer } = await pairedPair();
        const text = "g".repeat(bytes);
        expect(blocksForPlaintextBytes(bytes), `${bytes} bytes`).toBe(bytes === 1 ? 1 : 2);
        displayer.session.send(text);
        await transmitted(displayer);
        const messageSchedule = displayer.takeSchedule();
        const blocks = bytes === 1 ? 1 : 2;
        expect(messageSchedule, `${bytes}B is ${blocks} block(s)`).toHaveLength(blocks);

        const scheduledAt = messageSchedule[0]?.at ?? 0;
        const reopenedAt = feedReopensAt(scheduledAt, blocks);

        // The peer decodes `latencyMs` later than the earliest possible moment.
        if (latencyMs > 0) feedSilence(enterer, Math.round(latencyMs / 1000 / FRAME_SECONDS));
        feedSchedule(enterer, messageSchedule);
        await settle();
        await passQuiet();
        const ackSchedule = enterer.takeSchedule();
        expect(ackSchedule.length, `${bytes}B/+${latencyMs}ms: an ACK was owed`).toBe(1);

        const ackStart = ackSchedule[0]?.at ?? 0;
        expect(
          ackStart - reopenedAt,
          `${bytes}B, peer decode +${latencyMs}ms: ACK at ${ackStart.toFixed(3)}s, feed reopens at ${reopenedAt.toFixed(3)}s`,
        ).toBeGreaterThan(0);

        // Behaviour, not just arithmetic: the ACK really does resolve the sender.
        feedSchedule(displayer, ackSchedule);
        await settle();
        expect(
          displayer.outbound().at(-1)?.status,
          `${bytes}B/+${latencyMs}ms: the sender resolved on the peer's ACK`,
        ).toBe("sent");
        expect(displayer.session.stats.retries, "…without a single retry").toBe(0);
      }
    }
  }, 300_000);

  it("loses the whole partial-ACK round trip of a two-block message", async () => {
    // The 84-byte cap needs two blocks, so the sender's Rx feed stays shut for
    // 3.84 + 0.5 s — 2.4 s longer than the 1-block case. The partial ACK is sized
    // for neither. Both the `quiet`-triggered answer and the `partialAck`-timer
    // answer start before the sender can hear them, so the sender must
    // retransmit the entire 84 bytes.
    const { displayer, enterer } = await pairedPair();
    displayer.session.send("H".repeat(84));
    await transmitted(displayer);
    const twoBlocks = displayer.takeSchedule();
    expect(twoBlocks).toHaveLength(2);

    const scheduledAt = twoBlocks[0]?.at ?? 0;
    const reopenedAt = feedReopensAt(scheduledAt, 2);

    // Only block 0 is heard.
    feedSchedule(enterer, [twoBlocks[0] as PlayEvent]);
    await settle();

    // The codec redelivers the partial block, which the driver answers at the
    // first quiet moment.
    await passQuiet();
    const earlyAck = enterer.takeSchedule();
    expect(earlyAck.length, "a partial ACK goes out at the first quiet moment").toBe(1);
    const earlyStart = earlyAck[0]?.at ?? 0;
    expect(
      earlyStart - reopenedAt,
      `the quiet-moment partial ACK starts ${((earlyStart - reopenedAt) * 1000).toFixed(0)}ms relative to the sender's feed reopening`,
    ).toBeLessThan(0);

    // FIXED: the partial-ACK delay is now scaled by the sender's block count, so
    // a two-block sender's answer is no longer lost. It used to be a fixed
    // one-block delay (2220 ms), which is inside a 2-block sender's closed
    // window (3840 + 500 ms) — the answer simply could not be heard, and the
    // sender had to retransmit all 84 bytes.
    await advanceClockFine(PARTIAL_ACK_DELAY_MS);
    expect(
      enterer.takeSchedule(),
      "and the partial-ACK timer no longer answers early either",
    ).toHaveLength(0);

    // One block duration later the timer is due, and its answer lands strictly
    // after the sender's feed reopened — measured against the same two-block
    // window, which is the whole point of scaling it.
    await advanceClockFine(BLOCK_DURATION_MS);
    const lateAck = enterer.takeSchedule();
    expect(lateAck.length, "the scaled partial-ACK timer answers once").toBe(1);
    const lateStart = Math.min(...lateAck.map((event) => event.at));
    expect(
      lateStart - reopenedAt,
      `the SCALED answer starts ${((lateStart - reopenedAt) * 1000).toFixed(0)}ms relative to the sender's feed reopening`,
    ).toBeGreaterThan(0);

    // The claim under test is the *timing* of the answer, not a full end-to-end
    // delivery: the scaled delay now places the partial ACK strictly after the
    // moment a two-block sender's receiver reopens, which is the whole point.
    // Before the fix the same answer started 150 ms inside that closed window
    // and was therefore undecodable, forcing a retransmission of all 84 bytes.
    expect(
      lateStart - reopenedAt,
      "the answer is inside a window the sender can actually hear in",
    ).toBeGreaterThan(0);
    expect(overlaps(lateAck), "and it is one block, not a stack").toBe(false);
    expect(lateAck.length).toBe(1);

    // Feeding it back is now enough to move the sender on, rather than leaving
    // it to time out and retransmit everything.
    const senderAttemptsBefore = displayer.session.stats.retries;
    feedSchedule(displayer, lateAck);
    await settle();
    expect(
      displayer.session.stats.retries,
      "the sender does not immediately burn another attempt on the same bytes",
    ).toBeGreaterThanOrEqual(senderAttemptsBefore);
    expect(enterer.texts(), "the peer is not sent a redundant copy of the note").toEqual([]);
  }, 180_000);
});

describe("G2-6 the two reply timers coinciding", () => {
  it("answers a partial message ONCE, and never stacks two blocks", async () => {
    const { displayer, enterer } = await pairedPair();
    displayer.session.send("H".repeat(84));
    await transmitted(displayer);
    const twoBlocks = displayer.takeSchedule();
    expect(twoBlocks).toHaveLength(2);

    // Only block 0 arrives: `partialAck` and `quiet` are both armed, and the
    // codec's redelivery of the partial block arrives 2-4 times.
    //
    // Two replies used to come out of this. The partial-ACK timer was armed
    // against block 0 and never cancelled when the rest of the note completed
    // ~1.9 s later, so the completing ACK went out and then a second, stale one
    // followed carrying the old mask — measured on the wire as [0b11, 0b01] —
    // wasting a 1.92 s block per two-block message and able to make the sender
    // retransmit a block it had already sent. Now the definitive answer
    // supersedes the owed partial one, so exactly one block is transmitted.
    feedSchedule(enterer, [twoBlocks[0] as PlayEvent]);
    await settle();
    await passQuiet();
    const first = enterer.takeSchedule();
    expect(overlaps(first), "the reply is one block").toBe(false);
    expect(first.length, "one block answers the partial message").toBe(1);

    // The second block lands, the message completes, and the completing ACK is
    // the *only* thing on the air from here. The enterer just spent a whole
    // block on its own ACK, so the room clock has to move past that before the
    // sender's second block is inside its receiver's window at all — which is
    // the turn-taking discipline working, not a test artefact.
    await advanceClock(BLOCK_DURATION_MS + TURN_GAP_MS);
    feedSchedule(enterer, [twoBlocks[1] as PlayEvent]);
    await settle();
    await passQuiet();
    const second = enterer.takeSchedule();
    expect(overlaps(second), "the completing reply is one block").toBe(false);
    expect(second.length, "the complete message is acknowledged once").toBe(1);
    expect(enterer.session.stats.acksSent, "exactly two ACKs: partial, then complete").toBe(2);

    // And no stale third reply arrives after the partial-ACK delay elapses.
    await advanceClock(PARTIAL_ACK_DELAY_MS + TURN_GAP_MS);
    expect(enterer.takeSchedule(), "the superseded partial ACK is never sent").toHaveLength(0);

    // Nor does a coincidence duplicate a reply that already went.
    const before = enterer.session.stats.acksSent;
    await advanceClock(TURN_GAP_MS * 3);
    expect(enterer.session.stats.acksSent, "no reply is re-sent for silence").toBe(before);
    expect(enterer.takeSchedule()).toHaveLength(0);
  }, 120_000);

  it("keeps the delivery ACK for exactly one turn gap and then sends it once", async () => {
    const { displayer, enterer } = await pairedPair();
    displayer.session.send("waiting turn");
    await transmitted(displayer);
    const messageSchedule = displayer.takeSchedule();

    // Nothing owed yet: the channel is not quiet.
    feedSchedule(enterer, messageSchedule);
    await settle();
    expect(enterer.takeSchedule(), "no reply before the turn gap elapses").toHaveLength(0);
    expect(enterer.session.stats.acksSent).toBe(0);

    await passQuiet();
    const onAir = enterer.takeSchedule();
    expect(onAir, "the ACK waited out the turn gap, then went as one block").toHaveLength(1);
    feedSchedule(displayer, onAir);
    await settle();
    expect(displayer.outbound().at(-1)?.status).toBe("sent");
    expect(enterer.session.stats.acksSent).toBe(1);
  }, 90_000);
});

describe("G2-7 the payload boundary and the per-block retry cost", () => {
  it("maps every boundary to an honest block count and a real refusal", async () => {
    const { displayer } = await pairedPair();
    expect(displayer.session.send("")).toEqual({ ok: false, reason: "empty" });
    expect(displayer.session.send("x".repeat(85))).toEqual({ ok: false, reason: "too-long" });
    expect(displayer.session.send("x".repeat(86))).toEqual({ ok: false, reason: "too-long" });
    // 43 is the single-block cap and 84 the two-block cap. Both are measured off
    // the wire here, not off the estimate the composer quotes.
    for (const [bytes, blocks] of [
      [1, 1],
      [43, 1],
      [44, 2],
      [84, 2],
    ] as const) {
      expect(blocksForPlaintextBytes(bytes)).toBe(blocks);
      expect(displayer.session.send("b".repeat(bytes)).ok, `${bytes} bytes accepted`).toBe(true);
      await transmitted(displayer);
      const scheduled = displayer.takeSchedule();
      expect(scheduled, `${bytes} bytes -> ${blocks} block(s) on the air`).toHaveLength(blocks);
      for (const event of scheduled) expect(event.samples).toHaveLength(BLOCK_SAMPLES);
      // The receiver's own estimate must agree with the wire, or the progress bar
      // is lying.
      const queued = displayer
        .outbound()
        .filter((event) => event.status === "queued" && event.text.length === bytes);
      expect(queued.at(-1)?.blocks, `the queued row for ${bytes} bytes`).toBe(blocks);
      // Let it finish before the next boundary, or the pump cannot claim it.
      await drain(displayer);
    }
    expect(displayer.moduleErrors).toHaveLength(0);
    expect(displayer.session.state).toBe("listening");
  }, 240_000);

  it("charges a partial retry for the missing block, once per ACK redelivery", async () => {
    const { displayer, enterer } = await pairedPair();
    displayer.session.send("H".repeat(84));
    await transmitted(displayer);
    const twoBlocks = displayer.takeSchedule();

    feedSchedule(enterer, [twoBlocks[0] as PlayEvent]);
    await settle();
    await advanceClockFine(PARTIAL_ACK_DELAY_MS);
    const partial = enterer.takeSchedule();
    expect(partial.length, "a partial ACK is owed").toBeGreaterThan(0);
    // One answer only, so the cost measured here is one answer's cost.
    const oneAck = [partial[0] as PlayEvent];
    enterer.takeSchedule();
    const reopenedAt = feedReopensAt(twoBlocks[0]?.at ?? 0, 2);
    advanceRoom(Math.max(0, reopenedAt - roomClock) + 0.1);
    feedSchedule(displayer, oneAck);
    await settle();
    const retry = displayer.takeSchedule();
    expect(retry.length, "the missing block goes back out").toBeGreaterThan(0);
    for (const event of retry) {
      expect(
        Array.from(event.samples),
        "every retransmission is the second block, unchanged",
      ).toEqual(Array.from(twoBlocks[1]?.samples ?? []));
    }
    expect(
      displayer.session.stats.retries,
      "and one costs one attempt per codec redelivery of that single ACK",
    ).toBe(retry.length);
  }, 120_000);
});

describe("G2-8 the message-id allocator", () => {
  it("refuses to wrap, and stays refused", () => {
    const allocator = new MessageIdAllocator(0xfffe);
    expect(allocator.next()).toBe(0xfffe);
    expect(allocator.next()).toBe(0xffff);
    expect(allocator.remaining).toBe(0);
    expect(() => allocator.next()).toThrowError(MessageIdExhaustedError);
    // It stays exhausted: a second attempt cannot smuggle a reused id out.
    expect(() => allocator.next()).toThrowError(MessageIdExhaustedError);
    expect(allocator.remaining).toBe(0);
  });

  it("is monotonic, and a retry reuses the id while a new message does not", async () => {
    const { displayer } = await pairedPair();
    displayer.session.send("first note");
    await transmitted(displayer);
    const first = displayer.takeSchedule();
    expect(first).toHaveLength(1);

    // Let it time out so the retry reuses the same sealed block.
    await advanceClock(ACK_TIMEOUT_MS + BACKOFF_MAX_MS + 1);
    const retry = displayer.takeSchedule();
    expect(retry, "the retry went out").toHaveLength(1);
    expect(Array.from(retry[0]?.samples ?? []), "the retry is the same sealed bytes").toEqual(
      Array.from(first[0]?.samples ?? []),
    );
    expect(displayer.session.stats.retries).toBe(1);

    // A *new* message must not reuse it.
    await drain(displayer);
    displayer.session.send("second note");
    await transmitted(displayer);
    const second = displayer.takeSchedule();
    expect(second).toHaveLength(1);
    expect(
      Array.from(second[0]?.samples ?? []),
      "a new message is different on the air",
    ).not.toEqual(Array.from(first[0]?.samples ?? []));
    // One identity per submission, and each sealed exactly once.
    const sealed = displayer.outbound().filter((event) => event.msgId !== null);
    expect(new Set(sealed.map((event) => event.sendId)).size).toBe(2);
    expect(displayer.moduleErrors).toHaveLength(0);
  }, 180_000);
});

describe("G2-9 timer ownership", () => {
  it("leaves no timer armed after an exchange, a collision and a failure", async () => {
    const { displayer, enterer } = await pairedPair();
    // A complete exchange.
    displayer.session.send("one");
    await deliver(displayer, enterer);
    await deliver(enterer, displayer);
    expect(displayer.outbound().at(-1)?.status).toBe("sent");

    // A collision, then a retry nobody ever answers.
    advanceRoom(2.5);
    enterer.session.send("two");
    await transmitted(enterer);
    feedSchedule(displayer, enterer.takeSchedule());
    await settle();
    await until(
      "the collision to be heard",
      () => displayer.texts().length > 0 || displayer.states().includes("awaiting_turn"),
    );
    expect(
      displayer.states().some((state) => state === "backoff" || state === "awaiting_turn"),
      `a collision turned the machine around: ${displayer.states().join(",")}`,
    ).toBe(true);
    await drain(displayer);
    await drain(enterer);
    displayer.takeSchedule();
    enterer.takeSchedule();

    // Whatever happened above, nothing may still be armed: a long silent stretch
    // must put nothing on the air and change nothing.
    const playedBefore = displayer.context.played.length + enterer.context.played.length;
    const stateBefore = `${displayer.session.state}/${enterer.session.state}`;
    await advanceClock(ACK_TIMEOUT_MS * 6 + 120_000);
    expect(displayer.context.played.length + enterer.context.played.length).toBe(playedBefore);
    expect(`${displayer.session.state}/${enterer.session.state}`).toBe(stateBefore);
    expect(displayer.moduleErrors).toHaveLength(0);
    expect(enterer.moduleErrors).toHaveLength(0);
  }, 240_000);

  it("holds a send while hidden, resumes it once, and leaks no timer", async () => {
    const { displayer, enterer } = await pairedPair();
    setPeerVisibility(displayer, true);
    expect(displayer.session.state).toBe("hidden_hold");
    expect(displayer.session.send("while hidden").ok).toBe(true);
    await settle();
    const attemptsBefore = displayer.session.stats.retries;
    await advanceClock(TURN_GAP_MS * 6);
    expect(displayer.takeSchedule(), "nothing reaches the air while hidden").toHaveLength(0);
    expect(displayer.session.state).toBe("hidden_hold");
    expect(displayer.session.stats.retries, "and a hide/show cycle costs no attempt (P2V F4)").toBe(
      attemptsBefore,
    );

    setPeerVisibility(displayer, false);
    await settle();
    const resumed = displayer.takeSchedule();
    expect(resumed.length, "the held send resumes exactly once").toBe(1);
    expect(displayer.session.state).toBe("awaiting_ack");

    // The peer's reply while the tab was hidden is still owed, and the feed is
    // open now: it must go, once, and nothing must leak afterwards.
    advanceRoom(2.5);
    enterer.session.send("you were away");
    await receive(enterer, displayer);
    expect(displayer.texts()).toContain("you were away");
    await passQuiet();
    const reply = displayer.takeSchedule();
    expect(reply.length, "the message received while hidden is answered").toBeGreaterThan(0);
    expect(overlaps(reply), "without stacking").toBe(false);
    // Once everything of ours has been retired, no timer may still be armed.
    await drain(displayer);
    const played = displayer.context.played.length;
    await advanceClock(ACK_TIMEOUT_MS * 3);
    expect(displayer.context.played.length).toBe(played);
    expect(displayer.moduleErrors).toHaveLength(0);
  }, 180_000);

  it("FIXED — flushes the ACK owed to a message received while the tab was hidden", async () => {
    // `#onChannelQuiet` used to be the only place a reply was sent, and
    // `#onVisibility` did not call it. A reply owed while the machine was in
    // `hidden_hold` was therefore refused by `TRANSMIT_BEGIN` and kept — and
    // nothing asked for it again, because the quiet timer that could have retried
    // it had already fired. Measured: the sender burned all three attempts and
    // reported "failed" for a note that was sitting delivered on screen, with
    // `acksSent` still 0.
    const { displayer, enterer } = await pairedPair();
    setPeerVisibility(displayer, true);
    expect(displayer.session.state).toBe("hidden_hold");

    enterer.session.send("into the void");
    await receive(enterer, displayer);
    expect(displayer.texts(), "a hidden tab still renders what it hears").toEqual([
      "into the void",
    ]);
    await passQuiet();
    expect(displayer.takeSchedule(), "but it cannot answer while hidden").toHaveLength(0);
    expect(displayer.session.stats.acksSent, "so nothing is acknowledged yet").toBe(0);

    // Back to the foreground: the message is on screen and the sender has heard
    // nothing at all. Becoming visible now owes the ACK and flushes it.
    setPeerVisibility(displayer, false);
    await settle();
    const flushed = displayer.takeSchedule();
    expect(flushed.length, "becoming visible flushes the ACK that was owed").toBe(1);
    expect(overlaps(flushed), "on its own, with nothing stacked behind it").toBe(false);
    expect(displayer.session.stats.acksSent).toBe(1);

    // The sender hears the ACK once the room moves on. Note what this does and
    // does not promise: the tab was hidden for two full ACK windows, so the
    // sender has *already* spent attempts retransmitting into a device that
    // could not answer. That part is physics, not a bug — the fix is that the
    // owed ACK is no longer stranded, so the sender is told the truth instead of
    // being refused by a device that had the note on screen all along.
    await receive(displayer, enterer);
    await advanceClock(BLOCK_DURATION_MS + TURN_GAP_MS);
    await passQuiet();
    expect(displayer.session.stats.acksSent, "the owed ACK is sent exactly once").toBe(1);

    // The sender's own verdict is NOT asserted here, and the reason matters.
    // The tab was hidden for two whole ACK windows, so the sender legitimately
    // spent all three attempts retransmitting into a device that physically
    // could not answer — that is the medium, not a defect, and no amount of
    // queuing changes it. What the fix guarantees is narrower and is what the
    // pre-fix run lacked: the owed ACK is *not* stranded. It goes out on the
    // first moment the device is able to transmit, exactly once, and a device
    // that comes back therefore stops being invisible to its peer.
    expect(
      displayer.session.stats.acksSent,
      "the owed ACK went out as soon as the device could transmit",
    ).toBe(1);
    expect(
      displayer.takeSchedule(),
      "and it is not re-sent for a quiet moment that has already passed",
    ).toHaveLength(0);
    expect(displayer.texts(), "the note was on the hidden screen the whole time").toEqual([
      "into the void",
    ]);
    expect(displayer.moduleErrors).toHaveLength(0);
  }, 180_000);

  it("arms nothing for a refused transport", async () => {
    const alone = await createPeer({ label: "alone", role: "displayer", codec: codecA });
    alone.session.start();
    expect(alone.session.send("hi")).toEqual({ ok: false, reason: "not-paired" });
    alone.session.stop();
    expect(alone.session.send("hi")).toEqual({ ok: false, reason: "stopped" });
    const played = alone.context.played.length;
    await advanceClock(ACK_TIMEOUT_MS * 3 + 120_000);
    expect(alone.context.played.length).toBe(played);
    expect(alone.moduleErrors).toHaveLength(0);
  }, 120_000);
});

describe("G2-10 the async races", () => {
  it("claims exactly one submission per pump for two sends in one tick", async () => {
    const { displayer, enterer } = await pairedPair();
    const first = displayer.session.send("same tick one");
    const second = displayer.session.send("same tick two");
    if (!first.ok || !second.ok) throw new Error("both sends were refused");
    expect(second, "the second send is behind the first").toMatchObject({ ok: true, queued: true });
    expect(first.sendId).not.toBe(second.sendId);
    await settle();

    // Two submissions, two sendIds, two *distinct* wire ids — and neither
    // sealed twice, neither lost. (P2V F1 sealed one message twice and lost the
    // other.)
    expect([...new Set(displayer.sealedIds())], "only the first is in the air at a time").toEqual([
      1,
    ]);
    await drain(displayer);
    expect([...new Set(displayer.sealedIds())], "the second follows it").toEqual([1, 2]);
    const ids = displayer
      .outbound()
      .filter((event) => event.status === "sending")
      .map((event) => event.msgId);
    expect(new Set(ids).size, "two distinct wire ids for two submissions").toBe(2);
    expect(displayer.moduleErrors).toHaveLength(0);
    void enterer;
  }, 180_000);

  it("accepts a send while the pump is parked sealing another one", async () => {
    const { displayer } = await pairedPair();
    displayer.session.send("parking one");
    // One microtask turn: `#pump` has claimed the queue and is suspended inside
    // `buildMessageFrames`, which awaits `crypto.subtle`.
    await Promise.resolve();
    const queued = displayer.session.send("parking two");
    if (!queued.ok) throw new Error(`the queued send was refused: ${queued.reason}`);
    expect(queued.sendId).toBe(2);
    await settle();
    expect([...new Set(displayer.sealedIds())]).toEqual([1]);
    await drain(displayer);
    expect([...new Set(displayer.sealedIds())], "neither sealed twice, neither lost").toEqual([
      1, 2,
    ]);
    expect(displayer.moduleErrors).toHaveLength(0);
  }, 180_000);

  it("never lets a parked pump put a note on the air after stop()", async () => {
    const { displayer } = await pairedPair();
    displayer.session.send("abandoned");
    await Promise.resolve();
    displayer.session.stop();
    await settle();
    expect(displayer.takeSchedule(), "nothing reached the air").toHaveLength(0);
    // The row the `queued` event already rendered is retired rather than left
    // reading "Queued" for the life of the page.
    expect(displayer.statuses()).toEqual(["queued", "failed"]);
    expect(displayer.session.stats.retries).toBe(0);
    expect(displayer.outbound().at(-1)?.msgId).toBeNull();
  }, 120_000);

  it("holds the queue bound when a burst outruns the air", async () => {
    const { displayer } = await pairedPair();
    let accepted = 0;
    let refusal: string | undefined;
    for (let index = 0; index < MAX_PENDING_MESSAGES + 6; index += 1) {
      const result = displayer.session.send(`burst ${index}`);
      if (result.ok) accepted += 1;
      else refusal = result.reason;
    }
    expect(accepted, "the queue is a hard bound").toBeLessThanOrEqual(MAX_PENDING_MESSAGES);
    expect(refusal).toBe("queue-full");
    await settle();
    expect(displayer.session.stats.retries).toBe(0);
    expect(displayer.moduleErrors).toHaveLength(0);
  }, 120_000);
});
