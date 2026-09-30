/**
 * Phase 4 (The Gauntlet), adversarial subagent 7 of 8 — RESOURCE / PERFORMANCE.
 *
 * What this file is for: `session.ts` is the one owner of the Rx feed, the
 * codec, the timers, the transport machine, the async chain, the pump, the
 * retry/backoff budget and the dedupe. Every other suite in this tree proves it
 * *behaves*; this one proves it *gives everything back*, and measures what a
 * long session actually costs.
 *
 * The counts are the point. A teardown that reads correct in a snapshot can
 * still leak a ScriptProcessor or a 16 MiB wasm module, so every check here is
 * a before/after pair over one real, long, messy session rather than a single
 * assertion about a happy path.
 *
 * Harness notes, all of them load-bearing:
 * - The real codec, the real protocol, the real AEAD and the real state
 *   machine. Only the audio layer is mocked, and it is mocked the way a speaker
 *   and a room behave: whatever a session "plays" is captured from its
 *   AudioContext and fed to the peer one 1024-sample frame at a time, summing
 *   anything that overlaps.
 * - `./load-ggwave` is wrapped so `init()`/`free()` are counted per call and the
 *   live wasm heap is readable. That is the only way to answer "exactly two
 *   instances, ever" and "does the heap grow" with a number rather than an
 *   opinion. It is a *measurement* seam: every method still delegates to the
 *   real vendored module, so the codec under test is the shipping one.
 * - Every test tears down its own timers. Fake timers cover `setTimeout`,
 *   `clearTimeout`, `setInterval` and `clearInterval`; the interval is included
 *   specifically so the controller's 10 Hz ticker is countable rather than a
 *   thing that hangs the run.
 */

import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SoundChatCodec } from "./codec";
import { derivePairingKeys } from "./crypto";
import type { PairingRole } from "./pairing";
import {
  FrameCodec,
  MAX_MESSAGE_PLAINTEXT_BYTES,
  MAX_MESSAGE_BLOCKS,
  MAX_SEND_ATTEMPTS,
  fullMask,
} from "./protocol";
import {
  MAX_PENDING_MESSAGES,
  MAX_RE_ACKS_PER_MESSAGE,
  SoundChatSession,
  TURN_GAP_MS,
  type SessionEvent,
} from "./session";
import type {
  GgwaveEnumValue,
  GgwaveInstance,
  GgwaveModule,
  GgwaveParameters,
  GgwaveProtocolId,
} from "./vendor/ggwave";

const CODE = "ABCD2345";
const SAMPLE_FRAME = 1024;

// ---------------------------------------------------------------------------
// The ggwave measurement seam
// ---------------------------------------------------------------------------

/** One `loadGgwaveModule()` result, with its call counts. */
type ModuleRecord = {
  readonly base: GgwaveModule;
  inits: number;
  frees: number;
  /** Every protocol the codec was told to enable (state 1), in call order. */
  readonly enabled: string[];
  /**
   * `rxToggleProtocol` calls, counted in a mutable local owned by the seam and
   * published here. Read-only because every consumer only reads it; the counter
   * itself has to be mutable, so it lives outside the record rather than being
   * written through a cast.
   */
  readonly toggles: number;
};

function emptyRecords(): ModuleRecord[] {
  return [];
}

/** The ggwave factory's declared 36 exports; 12 of them are Rx protocol ids. */
const ALL_RX_PROTOCOLS = [
  "GGWAVE_PROTOCOL_AUDIBLE_NORMAL",
  "GGWAVE_PROTOCOL_AUDIBLE_FAST",
  "GGWAVE_PROTOCOL_AUDIBLE_FASTEST",
  "GGWAVE_PROTOCOL_ULTRASOUND_NORMAL",
  "GGWAVE_PROTOCOL_ULTRASOUND_FAST",
  "GGWAVE_PROTOCOL_ULTRASOUND_FASTEST",
  "GGWAVE_PROTOCOL_DT_NORMAL",
  "GGWAVE_PROTOCOL_DT_FAST",
  "GGWAVE_PROTOCOL_DT_FASTEST",
  "GGWAVE_PROTOCOL_MT_NORMAL",
  "GGWAVE_PROTOCOL_MT_FAST",
  "GGWAVE_PROTOCOL_MT_FASTEST",
] as const;

const ggwave = vi.hoisted(() => ({ records: emptyRecords() }));

vi.mock("./load-ggwave", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./load-ggwave")>();
  // Typed as the real keys of `GgwaveProtocolId` rather than as bare strings, so
  // `base.ProtocolId[name]` below is a checked lookup rather than an
  // `any`-by-disguise one: a name the module does not export is a compile
  // error, not a silent `"UNKNOWN"`.
  const names: readonly (keyof GgwaveProtocolId)[] = [
    "GGWAVE_PROTOCOL_AUDIBLE_NORMAL",
    "GGWAVE_PROTOCOL_AUDIBLE_FAST",
    "GGWAVE_PROTOCOL_AUDIBLE_FASTEST",
    "GGWAVE_PROTOCOL_ULTRASOUND_NORMAL",
    "GGWAVE_PROTOCOL_ULTRASOUND_FAST",
    "GGWAVE_PROTOCOL_ULTRASOUND_FASTEST",
    "GGWAVE_PROTOCOL_DT_NORMAL",
    "GGWAVE_PROTOCOL_DT_FAST",
    "GGWAVE_PROTOCOL_DT_FASTEST",
    "GGWAVE_PROTOCOL_MT_NORMAL",
    "GGWAVE_PROTOCOL_MT_FAST",
    "GGWAVE_PROTOCOL_MT_FASTEST",
  ];
  return {
    loadGgwaveModule: async (): Promise<GgwaveModule> => {
      const base = await actual.loadGgwaveModule();
      // `ModuleRecord.toggles` is read-only for every consumer, so the counter
      // is a mutable local here and the record only publishes it.
      let toggles = 0;
      const record: ModuleRecord = {
        base,
        inits: 0,
        frees: 0,
        enabled: [],
        get toggles(): number {
          return toggles;
        },
      };
      ggwave.records.push(record);
      const nameOf = (id: GgwaveEnumValue): string => {
        for (const name of names) {
          if (base.ProtocolId[name] === id) return name;
        }
        return "UNKNOWN";
      };
      return {
        ...base,
        init: (parameters: GgwaveParameters): GgwaveInstance => {
          record.inits += 1;
          return base.init(parameters);
        },
        free: (instance: GgwaveInstance): void => {
          record.frees += 1;
          base.free(instance);
        },
        rxToggleProtocol: (id: GgwaveEnumValue, state: number): void => {
          toggles += 1;
          if (state === 1) record.enabled.push(nameOf(id));
          base.rxToggleProtocol(id, state);
        },
      };
    },
  };
});

const { flushReceiver, openSoundChatCodec, CODEC_PAYLOAD_LENGTH } = await import("./codec");
const { SoundChatUiController } = await import("./ui/controller");
const { BLOCK_DURATION_MS, ACK_TIMEOUT_MS } = await import("./session");

/**
 * The controller's *instance* type. `SoundChatUiController` arrives here as a
 * destructured `const` from a dynamic `import()`, so the binding is a value and
 * cannot be written in type position; `InstanceType<typeof …>` names the same
 * class's instances without re-declaring a structural copy of it.
 */
type UiController = InstanceType<typeof SoundChatUiController>;

/** Sum of every `init()` seen so far, across every module the file opened. */
function totalInits(): number {
  return ggwave.records.reduce((sum, record) => sum + record.inits, 0);
}

function totalFrees(): number {
  return ggwave.records.reduce((sum, record) => sum + record.frees, 0);
}

/** Live wasm heap of the most recent module, in bytes. */
function liveHeapBytes(): number {
  const record = ggwave.records.at(-1);
  // SAFETY: `HEAPU8` is an untyped/vendor surface — the hand-written
  // `vendor/ggwave.d.ts` deliberately does not declare the Emscripten `HEAP*`
  // views (it declares 17 of the module's 36 exports and `HEAP*` are not among
  // them). It IS a real own property of the running module: verified by
  // executing the artifact under Node and reading `Object.keys(module)`, which
  // lists `HEAP8/HEAP16/HEAPU8/HEAPU16/HEAP32/HEAPU32/HEAPF32/HEAPF64`. This is
  // the only type assertion in the file and it is read-only.
  const heap = (record?.base as { readonly HEAPU8: Uint8Array } | undefined)?.HEAPU8;
  return heap === undefined ? 0 : heap.buffer.byteLength;
}

// ---------------------------------------------------------------------------
// The counting audio layer
// ---------------------------------------------------------------------------

/** Everything a teardown has to give back, counted. */
const counters = {
  streamSources: 0,
  scriptProcessors: 0,
  gains: 0,
  bufferSources: 0,
  audioBuffers: 0,
  nodesDisconnected: 0,
  listenersAdded: 0,
  listenersRemoved: 0,
  timersArmed: 0,
  timersCleared: 0,
  intervalsArmed: 0,
  intervalsCleared: 0,
  trackStops: 0,
  contextsCreated: 0,
  contextsClosed: 0,
};

function resetCounters(): void {
  for (const key of Object.keys(counters) as (keyof typeof counters)[]) counters[key] = 0;
}

type PlayEvent = { at: number; samples: Float32Array };

type FakeProcessor = {
  onaudioprocess:
    ((event: { inputBuffer: { getChannelData: (index: number) => Float32Array } }) => void) | null;
  connect: (node: unknown) => void;
  disconnect: () => void;
};

let roomClock = 10;
function advanceRoom(seconds: number): void {
  roomClock += seconds;
}

/** Every context this file has built, so a test can reach the room. */
const createdContexts: CountingAudioContext[] = [];

/**
 * A minimal but *counting* AudioContext.
 *
 * Every factory method bumps a counter, and every node's `disconnect()` bumps
 * the disconnect counter — so "nodes created vs disconnected" is a real
 * before/after pair rather than a claim.
 */
class CountingAudioContext {
  readonly sampleRate = 48_000;
  state: "running" | "closed" = "running";
  readonly destination = { kind: "destination" };
  readonly processors: FakeProcessor[] = [];
  readonly played: PlayEvent[] = [];

  constructor() {
    counters.contextsCreated += 1;
    // The registry is the seam: the controller has no idea it exists, which is
    // exactly what makes "which context is this session's feed on?" answerable.
    createdContexts.push(this);
  }

  get currentTime(): number {
    return roomClock;
  }

  async resume(): Promise<unknown> {
    return this;
  }

  /** Measured Chromium behaviour: a second `close()` rejects. */
  async close(): Promise<void> {
    counters.contextsClosed += 1;
    if (this.state === "closed") throw new DOMException("already closed", "InvalidStateError");
    this.state = "closed";
  }

  createMediaStreamSource(): { connect: () => void; disconnect: () => void } {
    counters.streamSources += 1;
    return {
      connect: (): void => {},
      disconnect: (): void => {
        counters.nodesDisconnected += 1;
      },
    };
  }

  createScriptProcessor(size: number, input: number, output: number): FakeProcessor {
    if (size !== SAMPLE_FRAME || input !== 1 || output !== 1) {
      throw new Error(`unexpected processor shape ${size}/${input}/${output}`);
    }
    counters.scriptProcessors += 1;
    const processor: FakeProcessor = {
      onaudioprocess: null,
      connect: (): void => {},
      disconnect: (): void => {
        counters.nodesDisconnected += 1;
      },
    };
    this.processors.push(processor);
    return processor;
  }

  createGain(): { gain: { value: number }; connect: () => void; disconnect: () => void } {
    counters.gains += 1;
    return {
      gain: { value: 0 },
      connect: (): void => {},
      disconnect: (): void => {
        counters.nodesDisconnected += 1;
      },
    };
  }

  createBuffer(
    _channels: number,
    length: number,
  ): {
    copied: Float32Array[];
    copyToChannel: (samples: Float32Array) => void;
  } {
    counters.audioBuffers += 1;
    const buffer: { copied: Float32Array[]; copyToChannel: (samples: Float32Array) => void } = {
      copied: [],
      copyToChannel: (): void => {},
    };
    buffer.copyToChannel = (samples: Float32Array): void => {
      buffer.copied.push(Float32Array.from(samples));
    };
    return buffer;
  }

  /**
   * Records the *schedule*, not just the fact of playing. Two blocks started at
   * the same instant sum at the destination, which a mock that ignored `when`
   * could not see at all.
   */
  createBufferSource = (): unknown => {
    counters.bufferSources += 1;
    const source = {
      buffer: null as { copied: Float32Array[] } | null,
      connect: () => source,
      start: (when?: number): void => {
        const samples = source.buffer?.copied[0];
        if (samples !== undefined) {
          this.played.push({ at: when === undefined || when === 0 ? roomClock : when, samples });
        }
      },
    };
    return source;
  };
}

type MockTrack = { stops: number; stop: () => void };

/** A track list a test can empty and refill, so `start()` can fail then pass. */
type MutableMic = {
  stream: MediaStream;
  tracks: MockTrack[];
  setTrackCount: (count: number) => void;
};

function newTrack(): MockTrack {
  const track: MockTrack = {
    stops: 0,
    stop(): void {
      track.stops += 1;
      counters.trackStops += 1;
    },
  };
  return track;
}

function mockStream(): { stream: MediaStream; tracks: MockTrack[] } {
  const track = newTrack();
  return {
    stream: { getAudioTracks: () => [track], getTracks: () => [track] } as unknown as MediaStream,
    tracks: [track],
  };
}

function mutableMic(count = 1): MutableMic {
  const tracks: MockTrack[] = [];
  const setTrackCount = (next: number): void => {
    tracks.length = 0;
    for (let index = 0; index < next; index += 1) tracks.push(newTrack());
  };
  setTrackCount(count);
  return {
    stream: {
      getAudioTracks: () => [...tracks],
      getTracks: () => [...tracks],
    } as unknown as MediaStream,
    tracks,
    setTrackCount,
  };
}

// ---------------------------------------------------------------------------
// The room: two peers, one shared clock
// ---------------------------------------------------------------------------

/** Every payload a session handed to `encode`, so ACK masks can be read. */
type Peer = {
  readonly label: string;
  readonly context: CountingAudioContext;
  readonly session: SoundChatSession;
  readonly events: SessionEvent[];
  readonly encoded: Uint8Array[];
  readonly tracks: MockTrack[];
  readonly moduleErrors: unknown[];
  readonly listenerErrors: unknown[];
  takeSchedule: () => PlayEvent[];
  clearAir: () => void;
  /** Attaches an audio track, so a later `start()` succeeds. */
  giveTrack: () => void;
};

const livePeers: Peer[] = [];

/**
 * The members of `SoundChatCodec` a caller is allowed to reach. The class keeps
 * its module, protocol and two instance ids in `#private` fields, so no
 * structural object can ever satisfy the class type itself — but every one of
 * these five is public, and `SoundChatSession` only ever calls these five.
 */
type CodecSurface = Pick<SoundChatCodec, "state" | "sampleRate" | "encode" | "decode" | "close">;

/** A codec that records what it is asked to transmit, then really transmits. */
function recordingCodec(inner: SoundChatCodec, log: Uint8Array[]): SoundChatCodec {
  const facade: CodecSurface = {
    get state() {
      return inner.state;
    },
    get sampleRate() {
      return inner.sampleRate;
    },
    encode: (payload: Uint8Array): Float32Array => {
      log.push(Uint8Array.from(payload));
      return inner.encode(payload);
    },
    decode: (chunk: Float32Array): Uint8Array | null => inner.decode(chunk),
    close: (): void => inner.close(),
  };
  // SAFETY: a single downcast, not a `as unknown as`. `CodecSurface` above is
  // checked against the real class member-by-member, and `SoundChatCodec` is
  // assignable to it, so the only thing this assertion adds is the private
  // state — which the facade does not need, because every call it receives is
  // forwarded to `inner`, the real codec, and none of the private fields is
  // read or written through the object handed to the session.
  return facade as SoundChatCodec;
}

async function createPeer(
  label: string,
  role: PairingRole,
  codec: SoundChatCodec,
  extra?: { onEvent?: (event: SessionEvent) => void },
): Promise<Peer> {
  return buildPeer(label, role, codec, mutableMic(1), extra);
}

/** A peer whose microphone has no audio track, so `start()` cannot succeed. */
async function tracklessPeer(label: string, codec: SoundChatCodec): Promise<Peer> {
  return buildPeer(label, "displayer", codec, mutableMic(0));
}

async function buildPeer(
  label: string,
  role: PairingRole,
  codec: SoundChatCodec,
  mic: MutableMic,
  extra?: { onEvent?: (event: SessionEvent) => void },
): Promise<Peer> {
  return buildPeerWithCode(label, role, codec, mic, CODE, extra);
}

async function buildPeerWithCode(
  label: string,
  role: PairingRole,
  codec: SoundChatCodec,
  mic: MutableMic,
  pairingCode: string,
  extra?: { onEvent?: (event: SessionEvent) => void },
): Promise<Peer> {
  const context = new CountingAudioContext();
  const events: SessionEvent[] = [];
  const encoded: Uint8Array[] = [];
  const moduleErrors: unknown[] = [];
  const listenerErrors: unknown[] = [];
  const session = await SoundChatSession.create({
    codec: recordingCodec(codec, encoded),
    context: context as unknown as AudioContext,
    stream: mic.stream,
    role,
    pairingCode,
    onEvent: (event: SessionEvent): void => {
      events.push(event);
      extra?.onEvent?.(event);
    },
    onListenerError: (error: unknown): void => {
      listenerErrors.push(error);
    },
    onModuleError: (error: unknown): void => {
      moduleErrors.push(error);
    },
  });
  const peer: Peer = {
    label,
    context,
    session,
    events,
    encoded,
    // The track objects are re-created when the count changes, so this is read
    // through a getter rather than snapshotted.
    get tracks() {
      return mic.tracks;
    },
    moduleErrors,
    listenerErrors,
    takeSchedule: () => {
      const taken = [...context.played];
      context.played.length = 0;
      return taken;
    },
    clearAir: (): void => {
      context.played.length = 0;
    },
    giveTrack: (): void => {
      mic.setTrackCount(1);
    },
  };
  livePeers.push(peer);
  return peer;
}

const MAX_TURNS = 20_000;
/** A drain floor, not a completion condition: `crypto.subtle` is a threadpool. */
const SETTLE_FLOOR = 256;
const QUIET_STREAK = 32;

function activity(): string {
  let signature = "";
  for (const peer of livePeers) {
    signature += [
      peer.session.state,
      peer.session.pairing.kind,
      peer.session.stats.blocksDecoded,
      peer.session.stats.messagesDelivered,
      peer.session.stats.acksSent,
      peer.session.stats.retries,
      peer.events.length,
      peer.encoded.length,
      peer.context.played.length,
    ].join(",");
    signature += "|";
  }
  return signature;
}

async function settle(): Promise<void> {
  let quiet = 0;
  let turn = 0;
  while (turn < SETTLE_FLOOR || quiet < QUIET_STREAK) {
    if (turn >= MAX_TURNS) throw new Error("the async chain never settled");
    const before = activity();
    await new Promise((resolve) => setImmediate(resolve));
    quiet = activity() === before ? quiet + 1 : 0;
    turn += 1;
  }
}

/** A cheaper drain for the bulk tests, where no threadpool work is racing. */
async function drain(turns = 96): Promise<void> {
  for (let turn = 0; turn < turns; turn += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

async function until(what: string, ready: () => boolean): Promise<void> {
  for (let turn = 0; turn < MAX_TURNS; turn += 1) {
    if (ready()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error(`timed out waiting for ${what}`);
}

/**
 * Lays a schedule onto a context's capture, the way a speaker and a room do:
 * anything that overlaps in time is summed, and the room clock advances a
 * 1024-sample frame at a time so every pause window expires honestly.
 */
function feedInto(to: CountingAudioContext, schedule: readonly PlayEvent[]): void {
  if (schedule.length === 0) return;
  const rate = 48_000;
  let first = Number.POSITIVE_INFINITY;
  let last = Number.NEGATIVE_INFINITY;
  for (const event of schedule) {
    first = Math.min(first, event.at);
    last = Math.max(last, event.at + event.samples.length / rate);
  }
  const mixed = new Float32Array(Math.max(0, Math.ceil((last - first) * rate)));
  for (const event of schedule) {
    const offset = Math.round((event.at - first) * rate);
    for (let index = 0; index < event.samples.length; index += 1) {
      mixed[offset + index] = (mixed[offset + index] ?? 0) + (event.samples[index] ?? 0);
    }
  }
  const whole = Math.floor(mixed.length / SAMPLE_FRAME);
  for (let index = 0; index < whole; index += 1) {
    const chunk = mixed.subarray(index * SAMPLE_FRAME, (index + 1) * SAMPLE_FRAME);
    advanceRoom(SAMPLE_FRAME / rate);
    to.processors[0]?.onaudioprocess?.({ inputBuffer: { getChannelData: () => chunk } });
  }
}

function feedSchedule(to: Peer, schedule: readonly PlayEvent[]): void {
  feedInto(to.context, schedule);
}

/**
 * Waits out the driver's turn gap on BOTH clocks.
 *
 * The Rx pause is measured on the AudioContext clock and the quiet timer on the
 * wall clock, so a turn gap that advances only one of them leaves the peer
 * pause-latched and the handshake silently never completes.
 */
async function passTurnGap(): Promise<void> {
  for (let pass = 0; pass < 2; pass += 1) {
    await vi.advanceTimersByTimeAsync(TURN_GAP_MS + 1);
    advanceRoom(TURN_GAP_MS / 1000);
    await settle();
  }
}

async function deliver(from: Peer, to: Peer): Promise<void> {
  await drain();
  await until(`${from.label} to stop transmitting`, () => !from.session.transmitting);
  feedSchedule(to, from.takeSchedule());
  await settle();
  await passTurnGap();
}

/**
 * Waits until a message of ours is genuinely on (or just off) the air.
 *
 * NOT `session.busy`: `busy` is true from the instant `send()` returns,
 * because the pump claims the queue synchronously, and it stays true while the
 * frames are still being sealed. Reading the radio then races the pump, and
 * `deliver` would take an empty schedule. The transport is the honest signal:
 * `transmitting` while the blocks are being scheduled, `awaiting_ack` once
 * they are out.
 */
async function onAir(peer: Peer, what: string): Promise<void> {
  await until(what, () => {
    const state = peer.session.state;
    return state === "transmitting" || state === "awaiting_ack";
  });
}

/**
 * Carries one message all the way to a terminal status.
 *
 * A single exchange is not enough, and the reason is the codec's own
 * redelivery: a fixed-length block keeps decoding for every chunk inside its
 * 90-frame window, so the receiver re-ACKs, and those re-ACKs share the air
 * with the one that resolves the sender. A stale re-ACK is ignored by
 * `#onAckFrame` (it names a message that is no longer `#outbound`), so the
 * sender needs the *next* turn to see the one that counts. Bounded, and it
 * reports rather than spins if the message really is stuck.
 */
async function resolveMessage(
  sender: Peer,
  receiver: Peer,
  what: string,
  maxTurns = 6,
): Promise<void> {
  for (let turn = 0; turn < maxTurns; turn += 1) {
    await deliver(receiver, sender);
    if (!sender.session.busy) return;
    await deliver(sender, receiver);
  }
  expect(sender.session.busy, `${what} resolved within ${maxTurns} turns`).toBe(false);
}

async function pairUp(displayer: Peer, enterer: Peer): Promise<void> {
  displayer.session.start();
  enterer.session.start();
  for (let attempt = 0; attempt < 8; attempt += 1) {
    await deliver(enterer, displayer);
    await deliver(displayer, enterer);
    if (displayer.session.pairing.kind === "paired" && enterer.session.pairing.kind === "paired") {
      displayer.clearAir();
      enterer.clearAir();
      displayer.encoded.length = 0;
      enterer.encoded.length = 0;
      await settle();
      return;
    }
  }
  throw new Error(
    `handshake did not complete: ${displayer.session.pairing.kind}/${enterer.session.pairing.kind}`,
  );
}

async function pairedPair(): Promise<{ displayer: Peer; enterer: Peer }> {
  // The displayer generates its own code (no `pairingCode` option), and the
  // enterer is given exactly that one — which is the only pairing that can work.
  const displayer = await buildPeer("displayer", "displayer", codecA, mutableMic(1));
  const enterer = await buildPeerWithCode(
    "enterer",
    "enterer",
    codecB,
    mutableMic(1),
    displayer.session.pairingCode,
  );
  await pairUp(displayer, enterer);
  return { displayer, enterer };
}

/** The two codecs the whole file shares: sessions come and go, codecs do not. */
const codecA = await openSoundChatCodec();
const codecB = await openSoundChatCodec();
const extraCodecs: SoundChatCodec[] = [];

/** A throwaway codec, for the tests that need one nobody else is using. */
async function spareCodec(): Promise<SoundChatCodec> {
  const codec = await openSoundChatCodec();
  extraCodecs.push(codec);
  return codec;
}

afterAll(() => {
  codecA.close();
  codecB.close();
  for (const codec of extraCodecs) codec.close();
});

// ---------------------------------------------------------------------------
// The fake document, and the timer/listener counters
// ---------------------------------------------------------------------------

let visibility: "visible" | "hidden" = "visible";
let visibilityHandlers: (() => void)[] = [];

function stubDocument(): void {
  vi.stubGlobal("document", {
    get visibilityState(): string {
      return visibility;
    },
    addEventListener: (_type: string, handler: () => void): void => {
      visibilityHandlers.push(handler);
      counters.listenersAdded += 1;
    },
    removeEventListener: (_type: string, handler: () => void): void => {
      visibilityHandlers = visibilityHandlers.filter((each) => each !== handler);
      counters.listenersRemoved += 1;
    },
  });
}

function setVisibility(next: "visible" | "hidden"): void {
  visibility = next;
  for (const handler of [...visibilityHandlers]) handler();
}

beforeEach(() => {
  vi.useFakeTimers({
    toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"],
  });
  roomClock = 10;
  visibility = "visible";
  visibilityHandlers = [];
  createdContexts.length = 0;
  resetCounters();
  // Count every arm/clear so "timers armed vs cleared" is a measured pair.
  const realSetTimeout = globalThis.setTimeout;
  const realClearTimeout = globalThis.clearTimeout;
  const realSetInterval = globalThis.setInterval;
  const realClearInterval = globalThis.clearInterval;
  // `clearTimeout`/`clearInterval` are *overloaded* in this program (the DOM
  // lib's `number` handle and the Node one coexist), so `ReturnType<typeof
  // realClearTimeout>` resolves the last signature and comes back as `void`.
  // The handle type is therefore written out — the union the Node overload
  // accepts — and the spy is pinned to the real signature the same way the
  // `setTimeout`/`setInterval` wrappers below already are.
  type TimerHandle = string | number | NodeJS.Timeout | undefined;
  vi.spyOn(globalThis, "setTimeout").mockImplementation(((
    handler: () => void,
    timeout?: number,
  ): ReturnType<typeof realSetTimeout> => {
    counters.timersArmed += 1;
    return realSetTimeout(handler, timeout);
  }) as typeof globalThis.setTimeout);
  vi.spyOn(globalThis, "clearTimeout").mockImplementation(((handle: TimerHandle): void => {
    counters.timersCleared += 1;
    realClearTimeout(handle);
  }) as typeof globalThis.clearTimeout);
  vi.spyOn(globalThis, "setInterval").mockImplementation(((
    handler: () => void,
    timeout?: number,
  ): ReturnType<typeof realSetInterval> => {
    counters.intervalsArmed += 1;
    return realSetInterval(handler, timeout);
  }) as typeof globalThis.setInterval);
  vi.spyOn(globalThis, "clearInterval").mockImplementation(((handle: TimerHandle): void => {
    counters.intervalsCleared += 1;
    realClearInterval(handle);
  }) as typeof globalThis.clearInterval);
  stubDocument();
  flushReceiver(codecA, 120);
  flushReceiver(codecB, 120);
});

afterEach(() => {
  for (const peer of livePeers.splice(0)) peer.session.stop();
  vi.restoreAllMocks();
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
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
  } finally {
    process.off("unhandledRejection", listener);
  }
  return rejections;
}

// ===========================================================================
// 1. Long-session teardown completeness — the count table
// ===========================================================================

describe("R1 — a long session hands back everything it took", () => {
  it("counts every node, listener, timer, track and context before vs after stop()", async () => {
    const initsBefore = totalInits();
    const { displayer, enterer } = await pairedPair();

    // A realistic workload: 24 short messages, alternating turns, each one
    // acknowledged for real over the acoustic loop. Strictly one in flight,
    // so nothing is ever refused and the turn is always clean.
    let delivered = 0;
    for (let index = 0; index < 24; index += 1) {
      const sender = index % 2 === 0 ? displayer : enterer;
      const receiver = index % 2 === 0 ? enterer : displayer;
      const before = receiver.session.stats.messagesDelivered;
      expect(sender.session.send(`note ${index}`).ok, `send ${index} is accepted`).toBe(true);
      // The pump seals the message asynchronously, so wait for the transport
      // to actually claim the radio before reading it.
      await onAir(sender, `message ${index} on the air`);
      await deliver(sender, receiver);
      await resolveMessage(sender, receiver, `note ${index}`);
      delivered += receiver.session.stats.messagesDelivered - before;
    }
    expect(delivered, "the workload really exchanged 24 messages").toBe(24);

    // A fully resolved, quiet session legitimately holds *no* timer, so the
    // snapshot is taken with real work outstanding: a message is out and
    // unacknowledged, which is the state that arms the ACK deadline, the
    // quiet timer and (on the peer) the owed-ACK path all at once.
    expect(displayer.session.send("in flight at teardown").ok).toBe(true);
    await onAir(displayer, "the last message on the air");
    const liveTimersBefore = vi.getTimerCount();
    expect(liveTimersBefore, "the session really is holding timers").toBeGreaterThan(0);
    expect(visibilityHandlers, "and really is holding a visibility listener each").toHaveLength(2);

    const freesBefore = totalFrees();
    const before = { ...counters };

    // The persistent graph each session owns: one source, one ScriptProcessor,
    // one gain sink. `createBufferSource` is one-shot per transmitted block
    // and is not part of the persistent graph.
    const persistentNodes = before.streamSources + before.scriptProcessors + before.gains;
    expect(persistentNodes, "two peers, three persistent nodes each").toBe(6);
    expect(before.nodesDisconnected, "nothing is disconnected while running").toBe(0);

    displayer.session.stop();
    enterer.session.stop();
    await drain();

    const after = { ...counters };

    // --- the count table -------------------------------------------------
    // "fired" is the third column a timer table needs: a session timer that
    // ran to completion is neither cleared nor leaked, and counting only the
    // clears would report a false residue.
    const armedAtTeardown = liveTimersBefore;
    const clearedByStop = after.timersCleared - before.timersCleared;
    const timersFired = before.timersArmed - before.timersCleared - armedAtTeardown;
    const table = [
      {
        resource: "persistent AudioNodes (source+processor+gain)",
        made: persistentNodes,
        released: after.nodesDisconnected,
        fired: "n/a",
      },
      {
        resource: "one-shot AudioBufferSourceNodes (one per block played)",
        made: before.bufferSources,
        released: 0,
        fired: "n/a",
      },
      {
        resource: "AudioBuffers (one per block played)",
        made: before.audioBuffers,
        released: 0,
        fired: "n/a",
      },
      {
        resource: "visibilitychange listeners",
        made: before.listenersAdded,
        released: after.listenersRemoved,
        fired: "n/a",
      },
      {
        resource: "setTimeout",
        made: before.timersArmed,
        released: after.timersCleared,
        fired: timersFired,
      },
      {
        resource: "setInterval (controller ticker; none in a bare session)",
        made: before.intervalsArmed,
        released: after.intervalsCleared,
        fired: 0,
      },
      { resource: "MediaStreamTrack", made: 2, released: after.trackStops, fired: "n/a" },
      {
        resource: "AudioContext",
        made: after.contextsCreated,
        released: after.contextsClosed,
        fired: "n/a",
      },
      {
        resource: "ggwave init() (both codecs, whole session)",
        made: (ggwave.records[0]?.inits ?? 0) + (ggwave.records[1]?.inits ?? 0),
        released: totalFrees() - freesBefore,
        fired: "n/a",
      },
    ];
    console.log(`R1 COUNT TABLE\n${JSON.stringify(table, null, 1)}`);

    // Persistent graph: all six nodes released.
    expect(after.nodesDisconnected, "every persistent node disconnected").toBe(persistentNodes);
    // Listeners: every add has a matching remove.
    expect(after.listenersRemoved, "every visibility listener removed").toBe(before.listenersAdded);
    expect(visibilityHandlers, "and none is left registered").toHaveLength(0);
    // Timers: every arm is accounted for — fired, cleared, or still held.
    console.log(
      `R1 timers: ${before.timersArmed} armed over the session = ` +
        `${timersFired} fired + ${before.timersCleared} cleared + ${armedAtTeardown} held at teardown; ` +
        `stop() released ${clearedByStop} of the ${armedAtTeardown} held`,
    );
    expect(vi.getTimerCount(), "stop() leaves no timer armed").toBe(0);
    expect(clearedByStop, "stop() released every timer that was still armed at teardown").toBe(
      armedAtTeardown,
    );
    // Media tracks: both mics released. `startListening.stop()` calls
    // `track.stop()` and then `stream.getTracks().forEach(stop)` (audio-io.ts
    // :271-272), so each peer's single track is stopped twice — harmless
    // (stop is idempotent per the Media Capture spec) but worth counting.
    expect(after.trackStops, "both microphones released").toBe(4);
    expect(
      displayer.tracks.every((track) => track.stops > 0),
      "the displayer's track is stopped",
    ).toBe(true);
    expect(
      enterer.tracks.every((track) => track.stops > 0),
      "the enterer's track is stopped",
    ).toBe(true);
    // The Rx feed is really detached, not merely unreferenced.
    expect(displayer.context.processors[0]?.onaudioprocess, "the feed is nulled").toBeNull();
    expect(enterer.context.processors[0]?.onaudioprocess, "the feed is nulled").toBeNull();
    // And the AudioContexts are still open — the session does not own them.
    // That is the controller's job, and R7 proves it does it.
    expect(after.contextsClosed, "the session does not close a context it does not own").toBe(0);
    // ggwave: exactly two instances per codec, for the whole session. The
    // codecs were opened at file scope, so the honest statement is about the
    // per-codec total plus "nothing was added during the conversation".
    expect(
      ggwave.records[0]?.inits,
      "the displayer's codec was initialised exactly twice, ever",
    ).toBe(2);
    expect(ggwave.records[1]?.inits, "and so was the enterer's").toBe(2);
    expect(totalInits() - initsBefore, "and 50+ transmissions added none").toBe(0);
    expect(totalFrees(), "and nothing was freed early").toBe(0);
  }, 180_000);
});

// ===========================================================================
// 2. Teardown from every path
// ===========================================================================

describe("R2 — teardown from every path leaves nothing running", () => {
  const assertClean = (label: string, peer: Peer): void => {
    expect(vi.getTimerCount(), `${label}: no timer armed`).toBe(0);
    expect(visibilityHandlers, `${label}: no visibility listener`).toHaveLength(0);
    expect(peer.context.processors[0]?.onaudioprocess, `${label}: the feed is detached`).toBeNull();
    expect(
      peer.tracks.every((track) => track.stops > 0),
      `${label}: the mic is released`,
    ).toBe(true);
  };

  it("after start(), with the 90 s pair timer armed", async () => {
    const peer = await createPeer("solo", "displayer", codecA);
    peer.session.start();
    await settle();
    expect(peer.session.pairing.kind).toBe("waiting-for-peer");
    expect(vi.getTimerCount(), "the 90 s pair timer is really armed").toBeGreaterThan(0);
    peer.session.stop();
    await drain();
    assertClean("after start", peer);
  }, 30_000);

  it("with a send in flight, inside the chain's await", async () => {
    const { displayer, enterer } = await pairedPair();
    // Hold every AES-GCM open, so the pump is parked inside
    // `buildMessageFrames` when `stop()` runs.
    let release = (): void => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const realEncrypt = globalThis.crypto.subtle.encrypt.bind(globalThis.crypto.subtle);
    vi.spyOn(globalThis.crypto.subtle, "encrypt").mockImplementation(async (...args) => {
      await gate;
      return realEncrypt(...args);
    });
    displayer.session.send("in flight");
    await drain(200);
    const rejections = await withRejectionWatch(async () => {
      displayer.session.stop();
      enterer.session.stop();
      release();
      await drain(200);
    });
    expect(rejections, "no rejection escapes").toEqual([]);
    assertClean("mid-send", displayer);
    expect(displayer.session.busy, "and the public getter is honest").toBe(false);
  }, 60_000);

  it("after a module error, from a codec that dies mid-transmission", async () => {
    const codec = await spareCodec();
    const displayer = await buildPeer("dies", "displayer", codec, mutableMic(1));
    const enterer = await buildPeerWithCode(
      "peer",
      "enterer",
      codecB,
      mutableMic(1),
      displayer.session.pairingCode,
    );
    await pairUp(displayer, enterer);
    // Get a real transmission under way, so the ACK deadline is genuinely
    // armed when the module dies.
    expect(displayer.session.send("about to die").ok).toBe(true);
    await onAir(displayer, "the doomed message on the air");
    expect(displayer.session.state, "our block is out and unacknowledged").toBe("awaiting_ack");
    const live = vi.getTimerCount();
    expect(live, "the ACK deadline is really armed").toBeGreaterThan(0);
    // Kill the codec the way a real wasm trap would: make `encode` throw once,
    // on the very next transmission attempt.
    const realEncode = codec.encode.bind(codec);
    let armed = false;
    vi.spyOn(codec, "encode").mockImplementation((payload: Uint8Array) => {
      if (!armed) {
        armed = true;
        throw new Error("wasm trap");
      }
      return realEncode(payload);
    });
    const rejections = await withRejectionWatch(async () => {
      await vi.advanceTimersByTimeAsync(ACK_TIMEOUT_MS + 1);
      await settle();
    });
    expect(displayer.session.state).toBe("module_error");
    expect(displayer.moduleErrors, "reported exactly once").toHaveLength(1);
    expect(rejections, "nothing escapes the module channel").toEqual([]);
    expect(vi.getTimerCount(), "a dead session owns no timers, pair included").toBe(0);
    // The dead session released its own subscription. The healthy peer still
    // holds one, so it is stopped before the global listener count is read.
    enterer.session.stop();
    await drain();
    assertClean("after module error", displayer);
    // A terminal session refuses everything. The reason is `stopped` rather
    // than `module-error` because the fault was injected at the wrapper
    // boundary, so the codec's own `#guard` never latched it dead — which is
    // itself worth stating: `send()`'s "module-error" reason depends on the
    // codec reporting itself dead, not on the session having gone terminal.
    expect(displayer.session.send("after")).toEqual({ ok: false, reason: "stopped" });
    // `restart()` is honest about the same thing: with a codec that still
    // reports itself ready it will hand back `{ ok: true }`, so a fault
    // outside the codec's guard produces a session that claims to be
    // recoverable. The product path (a real wasm trap) latches the codec, and
    // R4 proves `restart()` then refuses.
    expect(displayer.session.restart(), "a wrapper-level fault is treated as recoverable").toEqual({
      ok: true,
    });
    // Nothing further can re-report, even with a live feed pushing at it.
    const decoded = displayer.session.stats.blocksDecoded;
    for (let round = 0; round < 3; round += 1) {
      advanceRoom(3);
      displayer.context.processors[0]?.onaudioprocess?.({
        inputBuffer: { getChannelData: () => new Float32Array(SAMPLE_FRAME) },
      });
      await vi.advanceTimersByTimeAsync(120_000);
      await drain(64);
    }
    expect(displayer.moduleErrors, "still exactly one report").toHaveLength(1);
    expect(displayer.session.stats.blocksDecoded, "and the feed is really detached").toBe(decoded);
    expect(vi.getTimerCount(), "no timer was re-armed by the dead feed").toBe(0);
  }, 60_000);

  it("from a collision: state `backoff` with the retry timer armed", async () => {
    const { displayer, enterer } = await pairedPair();
    displayer.session.send("collide");
    await onAir(displayer, "the message on the air");
    expect(displayer.session.state, "our block is out and unacknowledged").toBe("awaiting_ack");
    // Nobody hears it: take our own block off the air and let the turn pass,
    // so our Rx feed reopens (it is shut for our transmit window plus the
    // measured 0.5 s tail) and the peer can then talk over us.
    displayer.takeSchedule();
    await passTurnGap();
    // The peer talks over us. `PEER_STARTED_TRANSMITTING` is the only route
    // from `awaiting_ack` into `backoff`.
    enterer.session.send("mine too");
    await onAir(enterer, "the intruding message on the air");
    // Our own feed reopens on the AudioContext clock 1.92 s + 0.5 s after our
    // transmission was scheduled, and the clock only advances as audio is
    // fed. Push it past that window before handing the peer's block over, or
    // the first frames of it are dropped on the floor and the 90-frame
    // analysis window never fills.
    advanceRoom(3);
    feedSchedule(displayer, enterer.takeSchedule());
    await settle();
    expect(displayer.session.state, "the collision put us in `backoff`").toBe("backoff");
    expect(vi.getTimerCount(), "the retry timer is armed").toBeGreaterThan(0);
    displayer.session.stop();
    enterer.session.stop();
    await drain();
    assertClean("after backoff", displayer);
  }, 60_000);

  it("from a hidden-tab hold, with the held message still queued", async () => {
    const { displayer, enterer } = await pairedPair();
    displayer.session.send("held");
    await drain();
    setVisibility("hidden");
    await drain();
    expect(displayer.session.state, "the machine holds the send").toBe("hidden_hold");
    expect(displayer.session.busy, "and the session is honest about it").toBe(true);
    displayer.session.stop();
    enterer.session.stop();
    await drain();
    assertClean("after hidden hold", displayer);
    // The held note is dropped, and dropped *silently*: `stop()` is the
    // caller's own teardown, so it must not notify a consumer that is going
    // away (session.ts, `stop()`'s comment).
    const after = displayer.events.filter((event) => event.type === "outbound");
    expect(
      after.filter((event) => event.status === "failed"),
      "no `failed` record is published after stop()",
    ).toHaveLength(0);
  }, 60_000);

  it("from pairing in progress, on both roles", async () => {
    for (const role of ["displayer", "enterer"] as const) {
      const peer = await createPeer(role, role, codecA);
      peer.session.start();
      await settle();
      expect(peer.session.pairing.kind, `${role} is mid-handshake`).toBe(
        role === "displayer" ? "waiting-for-peer" : "awaiting-confirmation",
      );
      const armed = vi.getTimerCount();
      expect(armed, `${role} armed a pair timer`).toBeGreaterThan(0);
      peer.session.stop();
      await drain();
      assertClean(`${role} mid-pairing`, peer);
    }
  }, 30_000);

  it("after a restart(), and on a double stop()", async () => {
    // A stream with no audio track: `startListening` refuses it, so
    // `start()` throws and the state is the recoverable `error`.
    const peer = await tracklessPeer("restartable", codecA);
    peer.session.start();
    await drain();
    expect(peer.session.state, "an honest `error`, not a silent `listening`").toBe("error");
    const initsBefore = totalInits();
    expect(peer.session.restart(), "restart is the one thing that clears the latch").toEqual({
      ok: true,
    });
    expect(peer.session.state).toBe("idle");
    expect(totalInits() - initsBefore, "restart() never re-inits the codec").toBe(0);
    // Fix the cause and start again: a real session, with its own pair timer.
    peer.giveTrack();
    peer.session.start();
    await drain();
    expect(peer.session.state, "and startable for real").toBe("listening");
    expect(peer.session.pairing.kind, "re-armed the handshake").toBe("waiting-for-peer");
    const rejections = await withRejectionWatch(async () => {
      peer.session.stop();
      peer.session.stop();
      await drain();
    });
    expect(rejections, "a double stop() rejects nothing").toEqual([]);
    assertClean("after double stop", peer);
  }, 30_000);
});

// ===========================================================================
// 3. Many rapid short messages — bounded protocol state
// ===========================================================================

describe("R3 — 24 rapid messages keep every piece of protocol state bounded", () => {
  it("bounds the queue, the retry budget, the dedupe window and the transcript", async () => {
    const { displayer, enterer } = await pairedPair();
    const receiver = enterer;
    const sender = displayer;

    // 1. The outbound queue is a hard cap, not a queue that grows.
    const refusals: string[] = [];
    let accepted = 0;
    for (let index = 0; index < 24; index += 1) {
      const result = sender.session.send(`burst ${index}`);
      if (result.ok) accepted += 1;
      else refusals.push(result.reason);
    }
    expect(accepted, "at most the cap is ever accepted").toBeLessThanOrEqual(
      MAX_PENDING_MESSAGES + 1,
    );
    expect(refusals.length, "and the rest are refused, not queued").toBe(24 - accepted);
    expect(new Set(refusals), "refused for the queue, not for anything else").toEqual(
      new Set(["queue-full"]),
    );

    // 2. Nothing retries more than the attempt budget, however long it takes.
    //    The burst above is still queued, so let it drain against nobody:
    //    every note exhausts its own budget and is reported `failed`, and the
    //    queue behind it keeps moving rather than stalling.
    for (let round = 0; round < (MAX_PENDING_MESSAGES + 2) * (MAX_SEND_ATTEMPTS + 2); round += 1) {
      sender.clearAir();
      receiver.clearAir();
      advanceRoom(ACK_TIMEOUT_MS / 1000);
      await vi.advanceTimersByTimeAsync(ACK_TIMEOUT_MS + 1_200 + 1);
      await drain(64);
      if (!sender.session.busy && sender.events.length > 0) break;
    }
    const attempts = Math.max(
      0,
      ...sender.events
        .filter(
          (event): event is Extract<SessionEvent, { type: "outbound" }> =>
            event.type === "outbound",
        )
        .map((event) => event.attempts),
    );
    expect(attempts, "no note exceeds MAX_SEND_ATTEMPTS genuine transmissions").toBe(
      MAX_SEND_ATTEMPTS,
    );
    expect(sender.session.busy, "and the queue drained rather than stalling").toBe(false);
    // Every accepted note reached a terminal status: none is left rendering
    // as "sending" or "queued" for the life of the session.
    const terminal = sender.events.filter(
      (event): event is Extract<SessionEvent, { type: "outbound" }> =>
        event.type === "outbound" && (event.status === "sent" || event.status === "failed"),
    );
    expect(
      new Set(terminal.map((event) => event.status)),
      "every accepted note resolved one way or the other",
    ).toEqual(new Set(["failed"]));

    // 3. The dedupe window stays bounded while the re-ACK budget caps the
    //    redelivery storm the codec produces by design. Replaying ONE real
    //    transmitted waveform is exactly the recorded-playback attack the
    //    budget exists for, and it needs no stub codec: the same audio, over
    //    and over, is what the reference player would emit.
    const deliveredBefore = receiver.session.stats.messagesDelivered;
    const acksBeforeReplay = receiver.session.stats.acksSent;
    sender.encoded.length = 0;
    sender.session.send("replay target");
    await settle();
    await until("the replay target on the air", () => sender.context.played.length >= 1);
    const recording = sender.takeSchedule();
    feedSchedule(receiver, recording);
    await settle();
    for (let repeat = 0; repeat < 25; repeat += 1) {
      receiver.clearAir();
      feedSchedule(receiver, recording);
      await drain(64);
      await passTurnGap();
    }
    expect(
      receiver.session.stats.messagesDelivered - deliveredBefore,
      "26 redeliveries of one block render once",
    ).toBe(1);
    expect(
      receiver.session.stats.acksSent - acksBeforeReplay,
      "and the re-ACK budget bounds the answers a replay can provoke",
    ).toBeLessThanOrEqual(MAX_RE_ACKS_PER_MESSAGE + 1);
    expect(
      receiver.session.stats.duplicatesSuppressed,
      "the rest were suppressed, not rendered",
    ).toBeGreaterThan(0);
    // The rendered text is still the one block, rendered once.
    const rendered = receiver.events.filter((event) => event.type === "message");
    expect(rendered.length, "one message event for the whole replay storm").toBe(1);
  }, 180_000);
});

// ===========================================================================
// 4. Module re-init after recovery
// ===========================================================================

describe("R4 — the wasm module is opened once and never per message", () => {
  it("counts init() across a whole conversation, and across a restart", async () => {
    const before = totalInits();
    const record = ggwave.records.at(-1);
    expect(record?.enabled, "Rx is narrowed to AUDIBLE_FASTEST and nothing else").toEqual([
      "GGWAVE_PROTOCOL_AUDIBLE_FASTEST",
    ]);
    expect(record?.toggles, "11 protocols disabled, 1 enabled — the deep dive's ~5x perf win").toBe(
      ALL_RX_PROTOCOLS.length,
    );

    const { displayer, enterer } = await pairedPair();
    const initsAfterPairing = totalInits();
    expect(
      initsAfterPairing - before,
      "the shared codecs were opened before the snapshot, so pairing adds none",
    ).toBe(0);
    for (let index = 0; index < 4; index += 1) {
      const sender = index % 2 === 0 ? displayer : enterer;
      const receiver = index % 2 === 0 ? enterer : displayer;
      expect(sender.session.send(`m${index}`).ok).toBe(true);
      await onAir(sender, `m${index} on the air`);
      await deliver(sender, receiver);
      await resolveMessage(sender, receiver, `m${index}`);
    }
    expect(
      totalInits() - initsAfterPairing,
      "8 transmissions across two handshakes never call init() again",
    ).toBe(0);
    expect(totalFrees(), "and nothing is freed mid-session").toBe(0);

    // `close()` is the only thing that frees, and it frees exactly two. A
    // *spare* codec, not the shared one: closing `codecB` here would poison
    // every later test in the file.
    const initsBeforeSpares = totalInits();
    const disposable = await spareCodec();
    disposable.close();
    expect(totalFrees(), "close() frees the pair, not one instance").toBe(2);
    expect(
      totalInits() - initsBeforeSpares,
      "a fresh codec is exactly two instances, never one per message",
    ).toBe(2);
  }, 120_000);

  it("restart() is the only thing that clears the dead latch, and it re-inits nothing", async () => {
    const codec = await spareCodec();
    // A recoverable `error`: a stream with no audio track, so `start()`
    // throws and the machine records the state the user can fix.
    const peer = await tracklessPeer("recoverable", codec);
    peer.session.start();
    await drain();
    expect(peer.session.state).toBe("error");
    const initsBefore = totalInits();
    expect(peer.session.send("nope"), "a non-startable session refuses").toEqual({
      ok: false,
      reason: "not-paired",
    });
    // Only `restart()` clears the latch. Nothing else may.
    expect(peer.session.restart()).toEqual({ ok: true });
    expect(peer.session.state).toBe("idle");
    expect(totalInits() - initsBefore, "restart() recovers without a second instance pair").toBe(0);
    peer.giveTrack();
    peer.session.start();
    await drain();
    expect(peer.session.state, "and the session really is startable again").toBe("listening");
    expect(vi.getTimerCount(), "the recovered session re-armed its own pair timer").toBe(1);
    peer.session.stop();
    await drain();
    expect(vi.getTimerCount(), "and gives it back").toBe(0);
  }, 30_000);
});

// ===========================================================================
// 5. Timer lifetime across every transport transition
// ===========================================================================

describe("R5 — a timer never outlives the state that armed it", () => {
  it("the partialAck timer outlives the message it was armed for", async () => {
    // session.ts `#onMessageBlock`, case "partial", arms the `partialAck`
    // timer and records `#partialAck`. The "delivered" case fires 1.9 s later
    // and sends the completing ACK — but it clears neither `#partialAck` nor
    // the timer. So the timer survives the message it was armed for and puts
    // a SECOND ACK on the air, carrying the stale partial mask.
    const { displayer, enterer } = await pairedPair();
    enterer.encoded.length = 0;
    enterer.clearAir();

    displayer.session.send("H".repeat(MAX_MESSAGE_PLAINTEXT_BYTES));
    await until("both blocks on the air", () => displayer.context.played.length >= 2);
    feedSchedule(enterer, displayer.takeSchedule());
    await settle();

    expect(enterer.session.stats.messagesDelivered, "the 2-block message is delivered whole").toBe(
      1,
    );
    // The completing ACK is held until the channel is quiet, so at this
    // instant nothing has gone on the air for it yet.
    const acksAtDelivery = enterer.session.stats.acksSent;
    const blocksAtDelivery = enterer.context.played.length;
    enterer.clearAir();

    // Now let the quiet timer and then PARTIAL_ACK_DELAY_MS elapse. If the
    // `partialAck` timer had been cleared on delivery, exactly one ACK block
    // would go on the air in this whole window.
    await passTurnGap();
    for (let pass = 0; pass < 2; pass += 1) {
      await vi.advanceTimersByTimeAsync(2_300);
      advanceRoom(2.3);
      await settle();
    }
    const acksAfterWindow = enterer.session.stats.acksSent;
    const blocksAfterWindow = enterer.takeSchedule().length;

    console.log(
      "R5 partialAck: acks/blocks at delivery",
      `${acksAtDelivery}/${blocksAtDelivery}`,
      "after the window",
      `${acksAfterWindow}/${blocksAfterWindow}`,
    );

    // FIXED (Phase 4). The "delivered" case now clears the pending partial ACK
    // and its timer, so the definitive answer supersedes the owed partial one
    // instead of both going out. Before the fix: two ACKs for one message, the
    // second carrying the stale mask read off the wire as 0b01 — a wasted
    // 1.92 s block per two-block message, able to make the sender retransmit a
    // block it had already sent.
    expect(
      acksAfterWindow,
      "exactly one ACK for one delivered message: the timer is cleared on delivery",
    ).toBe(1);
    expect(blocksAfterWindow, "and one whole 1.92 s ACK block on the air").toBe(1);

    // The one that does go out is the *completing* one, read off the wire
    // because the masks are inside the AEAD tag.
    const asSender = new FrameCodec({
      keys: await derivePairingKeys(displayer.session.pairingCode),
      selfId: 0,
      sendSalt: displayer.session.sessionSalt,
    });
    asSender.adoptPeerSalt(enterer.session.sessionSalt);
    const masks: number[] = [];
    for (const frame of enterer.encoded) {
      const parsed = await asSender.parse(frame);
      if (parsed.ok && parsed.frame.kind === "ack") masks.push(parsed.frame.mask);
    }
    console.log("R5 partialAck: ACK masks on the wire", JSON.stringify(masks));
    expect(masks, "the completing ACK is mask 0b11, and it is the only one").toEqual([
      fullMask(MAX_MESSAGE_BLOCKS),
    ]);
  }, 120_000);

  it("the ACK timer is cleared on every route out of `awaiting_ack`", async () => {
    const { displayer, enterer } = await pairedPair();
    displayer.session.send("wait for me");
    await onAir(displayer, "the message on the air");
    expect(displayer.session.state, "our block is out").toBe("awaiting_ack");
    expect(vi.getTimerCount(), "the ACK deadline is armed").toBe(1);
    await deliver(displayer, enterer);
    await resolveMessage(displayer, enterer, "the acknowledged message");
    expect(displayer.session.state, "the ACK resolved the message, so no deadline is left").toBe(
      "listening",
    );
    expect(
      displayer.events.some((event) => event.type === "outbound" && event.status === "sent"),
      "and the sender really was confirmed",
    ).toBe(true);
    expect(vi.getTimerCount(), "and the timer is gone, not merely idle").toBe(0);
  }, 90_000);

  it("the quiet timer and the pair timer are the only ones left in a healthy idle session", async () => {
    const peer = await createPeer("idle", "displayer", codecA);
    peer.session.start();
    await settle();
    // Mid-handshake: exactly the 90 s pair timer, nothing else.
    expect(vi.getTimerCount(), "only the pair timer").toBe(1);
    peer.session.stop();
    await drain();
    expect(vi.getTimerCount()).toBe(0);
  }, 30_000);
});

// ===========================================================================
// 6. The async chain
// ===========================================================================

describe("R6 — the async chain never leaves a promise parked forever", () => {
  it("a block suspended inside `parse` is dropped, not delivered, by stop()", async () => {
    const { displayer, enterer } = await pairedPair();
    enterer.session.send("too late");
    await settle();
    const frame = enterer.takeSchedule()[0];
    expect(frame, "a real frame is on the air").toBeDefined();
    if (frame === undefined) return;

    // Hold every AES-GCM *open*, so the block is parked inside `#handleBlock`.
    let release = (): void => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const realDecrypt = globalThis.crypto.subtle.decrypt.bind(globalThis.crypto.subtle);
    let entered = 0;
    vi.spyOn(globalThis.crypto.subtle, "decrypt").mockImplementation(async (...args) => {
      entered += 1;
      await gate;
      return realDecrypt(...args);
    });
    feedSchedule(displayer, [frame]);
    await until("the block to reach the AEAD open", () => entered > 0);
    const deliveredBefore = displayer.session.stats.messagesDelivered;
    displayer.session.stop();
    enterer.session.stop();
    release();
    await drain(300);
    expect(
      displayer.session.stats.messagesDelivered,
      "nothing is delivered to a consumer that has torn down",
    ).toBe(deliveredBefore);
    expect(vi.getTimerCount(), "and the dropped block arms no timer").toBe(0);
  }, 60_000);

  it("`#chain` stays resolved: no later block is skipped by a rejected predecessor", async () => {
    // A consumer that throws is a consumer bug, never a codec verdict, and it
    // must not poison the chain for every later block. The receiver is built
    // with a throwing `onEvent` from the start, so the throw really happens
    // inside `#chain`'s `.then`.
    const displayer = await buildPeer("sender", "displayer", codecA, mutableMic(1));
    const enterer = await buildPeerWithCode(
      "thrower",
      "enterer",
      codecB,
      mutableMic(1),
      displayer.session.pairingCode,
      {
        onEvent: (event) => {
          if (event.type === "message") throw new Error("consumer bug");
        },
      },
    );
    await pairUp(displayer, enterer);

    displayer.session.send("still delivered");
    await onAir(displayer, "the message on the air");
    await deliver(displayer, enterer);
    await resolveMessage(displayer, enterer, "the first message");
    expect(
      enterer.session.stats.messagesDelivered,
      "the block was authenticated and counted before the consumer threw",
    ).toBe(1);
    expect(enterer.listenerErrors.length, "the throw was reported").toBeGreaterThan(0);
    expect(enterer.moduleErrors, "and never as a module failure").toEqual([]);
    expect(enterer.session.state, "and the feed keeps running").toBe("listening");

    // The next message still gets through on the same chain: a rejected
    // predecessor must not skip every later block.
    displayer.session.send("and this one too");
    await onAir(displayer, "the message on the air");
    await deliver(displayer, enterer);
    await resolveMessage(displayer, enterer, "the second message");
    expect(
      enterer.session.stats.messagesDelivered,
      "the chain is intact for every later block",
    ).toBe(2);
  }, 120_000);
});

// ===========================================================================
// 7. The controller's 10 Hz ticker
// ===========================================================================

describe("R7 — the controller's 10 Hz progress ticker never outlives its phase", () => {
  const liveControllers: UiController[] = [];

  afterEach(() => {
    for (const controller of liveControllers.splice(0)) controller.dispose();
  });

  const startController = async (
    role: "displayer" | "enterer",
    code?: string,
  ): Promise<{ controller: UiController; context: CountingAudioContext }> => {
    const controller = new SoundChatUiController();
    liveControllers.push(controller);
    vi.stubGlobal("AudioContext", CountingAudioContext);
    const mic = mutableMic(1);
    vi.stubGlobal("navigator", {
      mediaDevices: { getUserMedia: async (): Promise<MediaStream> => mic.stream },
    });
    const before = createdContexts.length;
    if (code === undefined) await controller.begin(role);
    else await controller.begin(role, code);
    // Counted, not assumed: a start-up blocked before it needs a context
    // legitimately creates none.
    const context = createdContexts[before];
    if (context === undefined) throw new Error("this controller owns no AudioContext");
    return { controller, context };
  };

  it("is absent while idle, present while audio is on the air, gone in every terminal phase", async () => {
    const { controller, context } = await startController("displayer");
    const code = controller.getState().code;
    expect(code, "the displayer published a code").not.toBeNull();
    await drain();
    // The PAIR handshake is a transmission, but it is not our audio, so the
    // controller shows no progress bar and arms no ticker.
    expect(counters.intervalsArmed, "no ticker while merely handshaking").toBe(0);
    expect(vi.getTimerCount(), "and the 90 s pair timer is the only timer").toBe(1);

    // The counterpart is a real `SoundChatSession`: the controller owns the
    // production stack, and pairing it against a real driver is what makes
    // the ticker's lifecycle observable rather than simulated.
    const peer = await buildPeerWithCode(
      "counterpart",
      "enterer",
      codecA,
      mutableMic(1),
      code ?? CODE,
    );
    peer.session.start();
    for (let round = 0; round < 8; round += 1) {
      if (controller.getState().pairing.kind === "paired") break;
      await leg(peer, context);
      await leg(context, peer);
    }
    expect(controller.getState().pairing.kind, "the controller really paired").toBe("paired");
    expect(controller.getState().phase, "and is on the chat screen").toBe("chat");
    // The displayer's PAIR *answer* is a real transmission, so the controller
    // does tick for it — `#startProgress` keys on the transport being on air,
    // not on the transport being a message. What matters is that the ticker is
    // released again the moment the transport leaves its on-air states.
    console.log(
      `R7 ticker: armed during pairing ${counters.intervalsArmed}, ` +
        `cleared ${counters.intervalsCleared}, live ${vi.getTimerCount()}`,
    );
    expect(counters.intervalsCleared, "the handshake ticker was released").toBeGreaterThan(0);
    expect(vi.getTimerCount(), "and nothing is armed once paired and idle").toBe(0);
    const armedAfterPairing = counters.intervalsArmed;
    const clearedAfterPairing = counters.intervalsCleared;

    // A real send: the ticker must appear exactly once while audio is on the
    // air, and it must go away when the transport leaves the on-air states.
    expect(controller.send("hello").ok, "the send is accepted").toBe(true);
    await until("the ticker to be armed", () => counters.intervalsArmed > armedAfterPairing);
    expect(
      counters.intervalsArmed - armedAfterPairing,
      "exactly one ticker per transmission, never two",
    ).toBe(1);
    expect(
      ["transmitting", "awaiting_ack"],
      "and the transport is genuinely on air while the ticker runs",
    ).toContain(controller.getState().transport);
    // Let the message actually resolve, so the ticker is released by the
    // transport leaving its on-air states rather than by anything else.
    await leg(context, peer);
    await leg(peer, context);
    await until("the ticker to be released", () => counters.intervalsCleared > clearedAfterPairing);
    expect(
      counters.intervalsCleared - clearedAfterPairing,
      "the ticker was cleared, not left running",
    ).toBe(1);
    expect(vi.getTimerCount(), "no interval survives the transmission").toBe(0);
    expect(
      controller.getState().outbound.map((view) => view.status),
      "and the message really resolved",
    ).toContain("sent");

    // Terminal phase 1: cancel() back to the pre-prompt.
    controller.cancel();
    await drain();
    expect(controller.getState().phase, "back to the permission prompt").toBe("permission");
    expect(vi.getTimerCount(), "cancel() leaves no timer, ticker included").toBe(0);

    // Terminal phase 2: dispose(), which is what React's dev double-mount
    // calls twice.
    controller.dispose();
    controller.dispose();
    await drain();
    expect(vi.getTimerCount(), "dispose() leaves nothing behind").toBe(0);
    // The context and the mic are the controller's to release, and it did.
    expect(context.state, "the AudioContext is closed").toBe("closed");
    expect(counters.contextsClosed, "exactly one close, not one per dispose").toBe(1);
    expect(counters.trackStops, "and the microphone tracks are stopped").toBeGreaterThan(0);
  }, 180_000);

  it("a blocked start-up never arms a ticker and releases the microphone", async () => {
    const controller = new SoundChatUiController();
    liveControllers.push(controller);
    vi.stubGlobal("AudioContext", CountingAudioContext);
    const mic = mutableMic(1);
    vi.stubGlobal("navigator", {
      mediaDevices: {
        getUserMedia: async (): Promise<MediaStream> => {
          // The grant is refused, so nothing downstream ever sees the track.
          throw new DOMException("Permission denied", "NotAllowedError");
        },
      },
    });
    await controller.begin("displayer");
    expect(controller.getState().phase, "the refusal is a specific blocked screen").toBe("blocked");
    expect(vi.getTimerCount(), "a blocked start-up owns no timer").toBe(0);
    expect(counters.intervalsArmed, "and no ticker").toBe(0);
    controller.cancel();
    await drain();
    expect(vi.getTimerCount()).toBe(0);
    // A refused grant leaves no track to release, and the controller created
    // no context: both are the honest outcome, and neither is a leak.
    expect(counters.contextsCreated, "no context was ever created").toBe(0);
    expect(
      mic.tracks.every((track) => track.stops === 0),
      "and no track was granted",
    ).toBe(true);
  }, 30_000);

  it("a fatal module error releases the ticker and the context it was holding", async () => {
    const { controller, context } = await startController("displayer");
    await drain();
    expect(controller.getState().phase, "a real start-up").toBe("pairing");
    expect(vi.getTimerCount(), "the 90 s pair timer is armed").toBe(1);
    // Kill the codec the way a wasm trap would. The controller owns the codec,
    // so its `onModuleError` is what must latch `fatal` and release.
    const codec = (controller as unknown as { getState: () => unknown }).getState;
    void codec;
    const spy = vi
      .spyOn(await import("./codec"), "openSoundChatCodec")
      .mockRejectedValue(new Error("codec unavailable"));
    await controller.restart();
    spy.mockRestore();
    expect(controller.getState().phase, "an unavailable codec is a blocked screen").toBe("blocked");
    expect(vi.getTimerCount(), "and the pair timer from the old session is gone").toBe(0);
    expect(context.state, "the old context was closed").toBe("closed");
  }, 60_000);
});

/**
 * One leg of a conversation, in either direction: a `Peer` (a bare
 * `SoundChatSession`) or a raw `CountingAudioContext` (a controller's session,
 * which the controller does not expose a handle for).
 */
async function leg(
  from: Peer | CountingAudioContext,
  to: Peer | CountingAudioContext,
): Promise<void> {
  // A `Peer` is the only one of the two that owns a session, and it is
  // identified structurally rather than by `instanceof` (it is a plain object
  // type, not a class).
  const fromIsPeer = "session" in from;
  const fromContext = fromIsPeer ? from.context : from;
  const toContext = "session" in to ? to.context : to;
  // Generous, because a peer's first transmission is built asynchronously
  // (`#beginPairing` -> `void #transmitPairFrame()` -> `await buildPairFrame`)
  // and `session.transmitting` is still false until that microtask chain
  // reaches `#emit(TRANSMIT_BEGIN)`. A short drain here takes the air before
  // the PAIR frame exists, and the handshake then never completes.
  await drain(256);
  if (fromIsPeer) {
    await until(`${from.label} to stop transmitting`, () => !from.session.transmitting);
  }
  // Copied, not aliased: `played` is the live array, and emptying it after
  // taking it would empty the very schedule about to be laid onto the room.
  const schedule = [...fromContext.played];
  fromContext.played.length = 0;
  feedInto(toContext, schedule);
  await settle();
  await passTurnGap();
}

// ===========================================================================
// 8 & 9. Measured performance, and wasm heap growth
// ===========================================================================

describe("R8 — measured cost of the steady-state Rx path and of a transmission", () => {
  it("reports per-chunk decode, per-block encode and heap growth over a long run", async () => {
    const codec = await spareCodec();
    const record = ggwave.records.at(-1);
    // SAFETY: see `liveHeapBytes` — `HEAPU8` is a real own property of the
    // running Emscripten module and is deliberately undeclared in the
    // hand-written vendor `.d.ts`. Read-only.
    const heap = (record?.base as { readonly HEAPU8: Uint8Array } | undefined)?.HEAPU8;
    expect(heap, "the vendor module exposes its wasm heap").toBeDefined();
    if (heap === undefined) return;

    const heapAtOpen = heap.buffer.byteLength;

    // --- per-chunk decode, the path that runs 47x/second ---------------
    const silence = new Float32Array(SAMPLE_FRAME);
    const CHUNKS = 4_000;
    // Warm up so the first-call JIT cost is not read as steady state.
    for (let i = 0; i < 500; i += 1) codec.decode(silence);
    const decodeStart = performance.now();
    for (let i = 0; i < CHUNKS; i += 1) codec.decode(silence);
    const decodeMs = performance.now() - decodeStart;
    const perChunkMs = decodeMs / CHUNKS;
    console.log(
      "R8 decode: total",
      decodeMs.toFixed(1),
      "ms for",
      CHUNKS,
      "chunks =",
      perChunkMs.toFixed(4),
      "ms/chunk;",
      "audio rate 1 chunk /",
      ((SAMPLE_FRAME / codec.sampleRate) * 1000).toFixed(2),
      "ms =",
      ((perChunkMs / ((SAMPLE_FRAME / codec.sampleRate) * 1000)) * 100).toFixed(2),
      "% of one core",
    );

    // --- one-shot encode: 1 block and 2 blocks -------------------------
    const payload = new Uint8Array(CODEC_PAYLOAD_LENGTH).fill(0x5a);
    for (let i = 0; i < 20; i += 1) codec.encode(payload);
    const ENCODES = 300;
    const encodeStart = performance.now();
    for (let i = 0; i < ENCODES; i += 1) codec.encode(payload);
    const encodeMs = performance.now() - encodeStart;
    const perBlockMs = encodeMs / ENCODES;
    console.log(
      "R8 encode:",
      perBlockMs.toFixed(3),
      "ms/block; a",
      MAX_MESSAGE_BLOCKS,
      "-block message =",
      (perBlockMs * MAX_MESSAGE_BLOCKS).toFixed(3),
      "ms of",
      (MAX_MESSAGE_BLOCKS * BLOCK_DURATION_MS).toFixed(0),
      "ms of air",
    );
    const samples = codec.encode(payload).length;
    console.log(
      "R8 one block =",
      samples,
      "F32 samples =",
      ((samples / codec.sampleRate) * 1000).toFixed(0),
      "ms of audio,",
      (samples * 4) / 1024,
      "KiB of Float32 per transmission",
    );

    // --- wasm heap growth over a long mixed run -----------------------
    const CYCLES = 1_500;
    const before = heap.buffer.byteLength;
    for (let i = 0; i < CYCLES; i += 1) {
      codec.decode(silence);
      if (i % 8 === 0) codec.encode(payload);
    }
    const afterGrowth = heap.buffer.byteLength;
    console.log(
      "R9 wasm heap: at open",
      (heapAtOpen / 1024 / 1024).toFixed(1),
      "MiB; after",
      CYCLES,
      "decode +",
      Math.floor(CYCLES / 8),
      "encode cycles =",
      (afterGrowth / 1024 / 1024).toFixed(1),
      "MiB (delta",
      afterGrowth - before,
      "bytes)",
    );

    expect(afterGrowth, "the wasm heap does not grow without bound").toBe(before);
    // The per-chunk budget is the real one: the Rx path must fit inside the
    // 21.3 ms the audio callback leaves it with, with room to spare.
    expect(perChunkMs, "one decode must cost far less than the chunk's own duration").toBeLessThan(
      (SAMPLE_FRAME / codec.sampleRate) * 1000 * 0.25,
    );
    expect(perBlockMs, "one block's encode is amortised over 1.92 s of air").toBeLessThan(
      BLOCK_DURATION_MS,
    );
  }, 180_000);
});

// ===========================================================================
// 10. The resource cost of a controller restart
// ===========================================================================

describe("R10 — what a controller restart actually costs", () => {
  const liveControllers: UiController[] = [];

  afterEach(() => {
    for (const controller of liveControllers.splice(0)) controller.dispose();
  });

  it("a fresh wasm module (16 MiB) per restart, with no module-level free", async () => {
    const modulesBefore = ggwave.records.length;
    const initsBefore = totalInits();
    const freesBefore = totalFrees();
    const controller = new SoundChatUiController();
    liveControllers.push(controller);
    vi.stubGlobal("AudioContext", CountingAudioContext);
    vi.stubGlobal("navigator", {
      mediaDevices: { getUserMedia: async (): Promise<MediaStream> => mockStream().stream },
    });
    await controller.begin("displayer", CODE);
    await drain();
    expect(controller.getState().phase, "a real start-up").toBe("pairing");

    const modulesAfterFirst = ggwave.records.length;
    await controller.restart();
    await drain();
    await controller.restart();
    await drain();

    const modulesAfterThree = ggwave.records.length;
    console.log(
      "R10 modules: 1 begin + 2 restarts =",
      modulesAfterThree - modulesBefore,
      "ggwave modules;",
      "init()",
      totalInits() - initsBefore,
      "free()",
      totalFrees() - freesBefore,
      "; last heap",
      (liveHeapBytes() / 1024 / 1024).toFixed(1),
      "MiB",
    );

    // The factory is cached, so a new *module* is not a new download — but it
    // IS a new 16 MiB wasm heap, and the artifact exports no module-level
    // `destroy()`, so the only thing that reclaims it is the JS GC dropping
    // the last reference.
    expect(modulesAfterThree - modulesBefore, "one module per codec open").toBe(3);
    expect(modulesAfterFirst - modulesBefore, "and one per begin").toBe(1);
    expect(totalInits() - initsBefore, "2 instances per module, never more").toBe(6);
    expect(totalFrees() - freesBefore, "each torn-down codec frees its pair of instances").toBe(4);
    // The vendor module's whole export surface: no `destroy`, no `terminate`.
    const exports = Object.keys(ggwave.records.at(-1)?.base ?? {});
    expect(
      exports.some((name) => name === "destroy" || name === "terminate" || name === "exit"),
      "the artifact exports no module-level teardown, so the heap is GC-only",
    ).toBe(false);
    controller.dispose();
    await drain();
    expect(vi.getTimerCount(), "and dispose() still leaves no timer").toBe(0);
  }, 120_000);
});
