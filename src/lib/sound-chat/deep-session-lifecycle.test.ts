/**
 * Phase 2V deep dive — lifecycle, teardown and resource ownership.
 *
 * Master plan Section 10.1 classes 5 (lifecycle/idempotency) and 6 (unreleased
 * resources): every timer, listener, AudioNode, media track and wasm instance
 * must have an owner and a release point. `session.test.ts` proves `stop()`
 * twice is safe on a happy path; this file counts what is actually released on
 * *each* teardown path, and checks the one thing the happy path cannot see: a
 * block that is already inside the driver's async chain when `stop()` runs.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flushReceiver, openSoundChatCodec, type SoundChatCodec } from "./codec";
import type { PairingRole } from "./pairing";
import { SoundChatSession, type SessionEvent } from "./session";
import { drainAsync } from "./drain.ts";

const SAMPLE_FRAME = 1024;
let roomClock = 10;

const codecA = await openSoundChatCodec();
const codecB = await openSoundChatCodec();
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

type FakeBuffer = { copied: Float32Array[]; copyToChannel: (samples: Float32Array) => void };

class FakeAudioContext {
  readonly sampleRate = 48_000;
  state = "running";
  readonly destination = { kind: "destination" };
  readonly processors: FakeProcessor[] = [];
  readonly sources: { disconnect: () => void }[] = [];
  readonly gains: { disconnect: () => void }[] = [];
  readonly played: Float32Array[] = [];
  closeCalls = 0;
  nodesCreated = 0;

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
    this.nodesCreated += 1;
    const node = { connect: (): void => {}, disconnect: (): void => {} };
    this.sources.push(node);
    return node;
  }

  createScriptProcessor(size: number, input: number, output: number): FakeProcessor {
    if (size !== SAMPLE_FRAME || input !== 1 || output !== 1) {
      throw new Error(`unexpected processor shape ${size}/${input}/${output}`);
    }
    this.nodesCreated += 1;
    const processor: FakeProcessor = {
      onaudioprocess: null,
      connect: (): void => {},
      disconnect: (): void => {},
    };
    this.processors.push(processor);
    return processor;
  }

  createGain(): { gain: { value: number }; connect: () => void; disconnect: () => void } {
    this.nodesCreated += 1;
    const node = { gain: { value: 1 }, connect: (): void => {}, disconnect: (): void => {} };
    this.gains.push(node);
    return node;
  }

  createBuffer(_channels: number, length: number): FakeBuffer {
    const buffer: FakeBuffer = { copied: [], copyToChannel: (): void => {} };
    buffer.copyToChannel = (samples: Float32Array): void => {
      buffer.copied.push(Float32Array.from(samples));
    };
    return buffer;
  }

  createBufferSource = (): unknown => {
    const source = {
      buffer: null as FakeBuffer | null,
      connect: () => source,
      start: () => {
        const samples = source.buffer?.copied[0];
        if (samples !== undefined) this.played.push(samples);
      },
    };
    return source;
  };
}

type MockTrack = { stopCalls: number; label: string; stop: () => void };

function mockStream(): { stream: MediaStream; tracks: MockTrack[] } {
  const track: MockTrack = {
    stopCalls: 0,
    label: "fake-mic",
    stop(): void {
      this.stopCalls += 1;
    },
  };
  const tracks: MockTrack[] = [track];
  return {
    stream: {
      getAudioTracks: () => tracks,
      getTracks: () => tracks,
    } as unknown as MediaStream,
    tracks,
  };
}

type Peer = {
  readonly label: string;
  readonly context: FakeAudioContext;
  readonly session: SoundChatSession;
  readonly events: SessionEvent[];
  readonly tracks: MockTrack[];
  pendingAir: () => number;
  takeAir: () => Float32Array[];
  texts: () => string[];
};

type PeerOptions = {
  label: string;
  role: PairingRole;
  codec: SoundChatCodec;
  pairingCode?: string;
  /** A stream with no audio track, so `startListening` throws. */
  stream?: MediaStream;
};

const createdPeers: Peer[] = [];
let visibilityHandlers: (() => void)[] = [];

async function createPeer(options: PeerOptions): Promise<Peer> {
  const context = new FakeAudioContext();
  const events: SessionEvent[] = [];
  const { stream, tracks } = mockStream();
  const base = {
    codec: options.codec,
    context: context as unknown as AudioContext,
    stream: options.stream ?? stream,
    role: options.role,
    onEvent: (event: SessionEvent): void => {
      events.push(event);
    },
    onModuleError: (): void => {},
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
    tracks,
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
      peer.session.stats.messagesDelivered,
      peer.session.stats.acksSent,
      peer.events.length,
      peer.context.played.length,
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

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  roomClock = 10;
  visibilityHandlers = [];
  vi.stubGlobal("document", {
    get visibilityState() {
      return "visible";
    },
    addEventListener: (_type: string, handler: () => void) => {
      visibilityHandlers.push(handler);
    },
    removeEventListener: (): void => {
      visibilityHandlers = [];
    },
  });
  flushReceiver(codecA, 120);
  flushReceiver(codecB, 120);
});

afterEach(() => {
  for (const peer of createdPeers.splice(0)) peer.session.stop();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

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

describe("stop() and the async chain", () => {
  it("delivers nothing and leaves no timer once it has run", async () => {
    const { displayer, enterer } = await pairedPair();
    expect(enterer.session.send("in flight").ok).toBe(true);
    await transmitted(enterer);
    const waveform = enterer.takeAir()[0];
    if (waveform === undefined) throw new Error("expected a transmission");

    // Every frame of the block is delivered synchronously, so the driver's
    // chain has the block queued but has not looked at it yet — this is the
    // window `stop()` has to close.
    feed(displayer, waveform);
    displayer.session.stop();
    // The enterer is stopped too: `vi.getTimerCount()` is global, and it still
    // holds an ACK deadline from the send above, which has nothing to do with
    // the displayer's teardown.
    enterer.session.stop();
    await settle();

    // A block the chain picked up before `stop()` is abandoned, so a consumer
    // that has already torn down is never called and no fresh timer is armed.
    expect(displayer.texts()).toEqual([]);
    expect(vi.getTimerCount(), "stop() must clear every timer it can reach").toBe(0);
    // The capture is genuinely detached, and no further block is ever seen.
    const before = displayer.session.stats.blocksDecoded;
    roomClock += 3;
    feed(displayer, waveform);
    await settle();
    expect(displayer.session.stats.blocksDecoded).toBe(before);
  });
});

describe("what each teardown path actually releases", () => {
  it("releases every timer, listener, node and track on a busy session", async () => {
    const { displayer, enterer } = await pairedPair();
    // A session with all three of its timers armed at once: our own ACK
    // deadline, a collision backoff, and the quiet timer that owes the peer an
    // acknowledgement.
    expect(displayer.session.send("mine").ok).toBe(true);
    await settle();
    expect(enterer.session.send("yours").ok).toBe(true);
    await settle();
    // The displayer's own Rx feed is shut for its block plus the tail, so the
    // room clock has to move on before its microphone is listening again.
    roomClock += 2.5;
    await deliver(enterer, displayer);
    expect(displayer.texts()).toEqual(["yours"]);
    const armed = vi.getTimerCount();
    expect(armed, "this test is only meaningful with timers armed").toBeGreaterThanOrEqual(2);

    // The peer has its own ACK deadline; stopping it first is what makes the
    // count below attributable to this session alone.
    enterer.session.stop();
    const afterPeer = vi.getTimerCount();
    expect(afterPeer).toBeLessThan(armed);
    displayer.session.stop();
    expect(vi.getTimerCount()).toBe(0);
    expect(displayer.context.processors[0]?.onaudioprocess).toBeNull();
    expect(displayer.tracks.every((track) => track.stopCalls > 0)).toBe(true);
    expect(visibilityHandlers).toHaveLength(0);
    expect(displayer.session.state).toBe("idle");
    expect(displayer.session.send("after").ok).toBe(false);
  });

  it("releases nothing twice, and never twice for one teardown", async () => {
    const { displayer } = await pairedPair();
    const processor = displayer.context.processors[0];
    const nodes = displayer.context.nodesCreated;
    displayer.session.stop();
    displayer.session.stop();
    displayer.session.stop();
    expect(vi.getTimerCount()).toBe(0);
    expect(processor?.onaudioprocess).toBeNull();
    // One listen handle means one source, one processor, one gain — never two.
    expect(displayer.context.nodesCreated).toBe(nodes);
    expect(displayer.context.processors).toHaveLength(1);
    expect(displayer.context.sources).toHaveLength(1);
    expect(displayer.context.gains).toHaveLength(1);
  });

  it("releases everything when it is stopped mid-transmit", async () => {
    const { displayer } = await pairedPair();
    // `send` returns before the frames are sealed, so this is genuinely
    // "stopped while a transmission is being prepared".
    expect(displayer.session.send("cut off").ok).toBe(true);
    displayer.session.stop();
    await settle();
    await vi.advanceTimersByTimeAsync(60_000);
    await settle();
    expect(displayer.takeAir()).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(0);
    expect(displayer.session.state).toBe("idle");
  });

  it("releases everything when it is stopped after a module error", async () => {
    // A dedicated real codec, not the shared `codecA`: this test's dying wrapper
    // counts encodes, and a shared instance's Rx state is left behind by
    // whichever test ran before, which made the outcome order-dependent.
    const own = await openSoundChatCodec();
    extraCodecs.push(own);
    const flaky = dyingCodec(own, 1);
    const displayer = await createPeer({ label: "displayer", role: "displayer", codec: flaky });
    const enterer = await createPeer({
      label: "enterer",
      role: "enterer",
      codec: codecB,
      pairingCode: displayer.session.pairingCode,
    });
    await pairUp(displayer, enterer);
    expect(displayer.session.send("boom").ok).toBe(true);
    await settle();
    expect(displayer.session.state).toBe("module_error");
    displayer.session.stop();
    expect(vi.getTimerCount()).toBe(0);
    expect(displayer.context.processors[0]?.onaudioprocess).toBeNull();
    expect(displayer.tracks.every((track) => track.stopCalls > 0)).toBe(true);
    // The machine deliberately keeps `module_error` through a STOP, so the UI is
    // the only thing that can clear it — documented, and asserted here so the
    // contract cannot change silently.
    expect(displayer.session.state).toBe("module_error");
    expect(displayer.session.restart()).toEqual({ ok: false, reason: "codec-dead" });
  });

  it("leaves the AudioContext to its owner, and says so", async () => {
    // The contract Phase 3 builds on: `stop()` releases the *feed* (nodes,
    // processor, media tracks) but the AudioContext belongs to whoever created
    // it, and only `teardownAudio` closes it. Pinned here so the UI's teardown
    // cannot quietly skip it.
    const { displayer } = await pairedPair();
    displayer.session.stop();
    expect(displayer.context.closeCalls).toBe(0);
    expect(displayer.context.state).toBe("running");
    expect(displayer.tracks.every((track) => track.stopCalls > 0)).toBe(true);
  });
});

describe("restart()", () => {
  it("refuses on a healthy session rather than reporting a no-op as success", async () => {
    const { displayer } = await pairedPair();
    // The machine is already startable, and this driver performs no teardown, so
    // there is nothing to restart. Saying `ok` would be a lie the UI would turn
    // into "restarted" (P2V finding 13).
    expect(displayer.session.restart()).toEqual({ ok: false, reason: "not-restartable" });
    expect(displayer.session.state).toBe("listening");
    // ...and the session is untouched and still usable.
    expect(displayer.session.send("still works").ok).toBe(true);
    await settle();
  });

  it("refuses on a stopped session, which cannot be restarted into life", async () => {
    const { displayer } = await pairedPair();
    displayer.session.stop();
    // A stopped session is terminal: `start()` is a no-op after it, so a
    // successful `restart()` would promise something the API cannot deliver.
    expect(displayer.session.restart()).toEqual({ ok: false, reason: "not-restartable" });
    displayer.session.start();
    expect(displayer.session.state).toBe("idle");
    // The feed is detached, not merely ignored: the processor's callback is gone.
    expect(displayer.context.processors[0]?.onaudioprocess).toBeNull();
  });

  it("refuses with `codec-dead` when the codec is dead, whatever the transport state says", async () => {
    // A dead codec is terminal for the page session, and that is the one answer
    // Phase 3 turns into "reload". The previous version of this test never killed
    // a codec and asserted the *state* reason, while its name claimed the codec
    // one — a test that passed without testing anything it said.
    const own = await openSoundChatCodec();
    extraCodecs.push(own);
    const dying = dyingCodec(own, 1);
    const displayer = await createPeer({ label: "dying", role: "displayer", codec: dying });
    const enterer = await createPeer({
      label: "enterer",
      role: "enterer",
      codec: await openSoundChatCodec().then((codec) => (extraCodecs.push(codec), codec)),
      pairingCode: displayer.session.pairingCode,
    });
    await pairUp(displayer, enterer);
    expect(displayer.session.state).toBe("listening");
    expect(displayer.session.send("boom").ok).toBe(true);
    await settle();
    expect(displayer.session.state).toBe("module_error");
    expect(dying.state).toBe("dead");
    // The codec verdict outranks the state check, and it is the honest one.
    expect(displayer.session.restart()).toEqual({ ok: false, reason: "codec-dead" });
  });

  it("reaches the recoverable `error` state when start() cannot succeed", async () => {
    // A stream with no audio track: `startListening` throws. The session used to
    // stay `listening` with no feed at all, making every retry a silent no-op,
    // and `error` (and with it `restart()`) was unreachable (P2V finding 8).
    const own = await openSoundChatCodec();
    extraCodecs.push(own);
    const broken = { getAudioTracks: () => [], getTracks: () => [] } as unknown as MediaStream;
    const alone = await createPeer({
      label: "no-track",
      role: "displayer",
      codec: own,
      stream: broken,
    });
    alone.session.start();
    await settle();
    expect(alone.session.state).toBe("error");
    // No feed was ever attached, and the failure was reported rather than
    // swallowed.
    expect(alone.context.processors).toHaveLength(0);
    // ...and from `error` the honest recovery is available: restart, then start.
    expect(alone.session.restart()).toEqual({ ok: true });
    expect(alone.session.state).toBe("idle");
  });

  it("keeps every transport event the driver emitted honest", async () => {
    const own = await openSoundChatCodec();
    extraCodecs.push(own);
    const alone = await createPeer({ label: "alone", role: "displayer", codec: own });
    alone.session.start();
    await settle();
    expect(alone.session.state).toBe("listening");
    // Every transport event the driver emitted, across the whole run.
    const states = alone.events
      .filter(
        (event): event is Extract<SessionEvent, { type: "transport" }> =>
          event.type === "transport",
      )
      .map((event) => event.state);
    expect(new Set(states)).toEqual(new Set(["listening"]));
    expect(states).not.toContain("error");
  });
});
