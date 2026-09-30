/**
 * Phase 2V deep dive — the driver's serialisation chain under a hostile error
 * sink.
 *
 * `session.ts` funnels every decoded block through one promise chain so two
 * blocks that arrive together are handled in order. That chain is also the only
 * thing standing between a bad event consumer and the Rx path, and its own
 * error reporter is the last thing between a bad consumer and a live session.
 *
 * This file asks the question `session.test.ts` never asks: what if the error
 * reporter *itself* throws? It is a real possibility — `onListenerError` is a
 * caller-supplied callback with no contract of its own — and the answer decides
 * whether one bad consumer ends the session or kills the chain for good.
 *
 * Its own file because the failure path produces unhandled promise rejections.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flushReceiver, openSoundChatCodec, type SoundChatCodec } from "./codec";
import { derivePairingKeys } from "./crypto";
import type { PairingRole } from "./pairing";
import { FrameCodec } from "./protocol";
import { SoundChatSession, type SessionEvent } from "./session";

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
  readonly played: Float32Array[] = [];

  get currentTime(): number {
    return roomClock;
  }

  async resume(): Promise<unknown> {
    return this;
  }

  async close(): Promise<void> {
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

/** Wraps a codec so a test can count how many blocks the Rx path produced. */
function countingCodec(real: SoundChatCodec, counter: { blocks: number }): SoundChatCodec {
  return {
    get state(): string {
      return real.state;
    },
    encode: (payload: Uint8Array): Float32Array => real.encode(payload),
    decode(chunk: Float32Array): Uint8Array | null {
      const out = real.decode(chunk);
      if (out !== null) counter.blocks += 1;
      return out;
    },
  } as unknown as SoundChatCodec;
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
  onEvent?: (event: SessionEvent) => void;
  onListenerError?: (error: unknown) => void;
  withListenerError?: boolean;
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
      options.onEvent?.(event);
    },
    onModuleError: (error: unknown): void => {
      moduleErrors.push(error);
    },
    ...(options.withListenerError === false
      ? {}
      : {
          onListenerError: (error: unknown): void => {
            listenerErrors.push(error);
            options.onListenerError?.(error);
          },
        }),
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
      peer.events.length,
      peer.context.played.length,
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

/** A frame this session cannot read, encoded into audio by the real codec. */
async function unreadableWaveform(code: string, peerSalt: Uint8Array): Promise<Float32Array> {
  const keys = await derivePairingKeys(code);
  const impostor = new FrameCodec({
    keys,
    selfId: 0,
    sendSalt: new Uint8Array(16).fill(0x5a),
  });
  const [frame] = await impostor.buildMessageFrames(new TextEncoder().encode("not for you"), 1);
  if (peerSalt.length !== 16) throw new Error("unreachable");
  return codecA.encode(frame as Uint8Array);
}

describe("an error reporter that throws", () => {
  it("does not end the session's ability to hear anything, ever again", async () => {
    const counter = { blocks: 0 };
    const pairCodecA = await openSoundChatCodec();
    const pairCodecB = await openSoundChatCodec();
    extraCodecs.push(pairCodecA, pairCodecB);
    const displayer = await createPeer({
      label: "displayer",
      role: "displayer",
      codec: pairCodecA,
    });
    // A consumer that throws on the event the driver only emits for an
    // unreadable block, and a reporter that throws on the way out.
    const hostileEnterer = await createPeer({
      label: "hostile",
      role: "enterer",
      codec: countingCodec(pairCodecB, counter),
      pairingCode: displayer.session.pairingCode,
      onEvent: (event) => {
        if (event.type === "heard-unreadable") throw new Error("consumer bug");
      },
      onListenerError: () => {
        throw new Error("the error reporter is broken too");
      },
    });
    await pairUp(displayer, hostileEnterer);
    hostileEnterer.takeAir();
    feed(hostileEnterer, new Float32Array(SAMPLE_FRAME * 120));
    await settle();
    counter.blocks = 0;
    const before = hostileEnterer.session.stats.blocksDecoded;

    const waveform = await unreadableWaveform(displayer.session.pairingCode, new Uint8Array(16));
    const rejections: unknown[] = [];
    const onRejection = (reason: unknown): void => {
      rejections.push(reason);
    };
    process.on("unhandledRejection", onRejection);
    try {
      feed(hostileEnterer, waveform);
      // A condition, not a drain: the whole claim of this test is that the chain
      // keeps running, so waiting a fixed number of event-loop turns and then
      // comparing two counters is exactly the load-sensitive shape that made it
      // flaky. Wait for the chain to be quiescent *and* for the count to settle.
      await until("the unreadable block to be handled", () => {
        const handled = hostileEnterer.session.stats.blocksDecoded - before;
        return handled > 0 && handled === counter.blocks;
      });
      await settle();
    } finally {
      process.off("unhandledRejection", onRejection);
    }

    // The codec produced more than one block while the waveform was in its
    // window (it redelivers by design), and the driver handled exactly one.
    expect(counter.blocks).toBeGreaterThan(1);
    // P2V FINDING: expected every decoded block to be handled, received 1.
    expect
      .soft(
        hostileEnterer.session.stats.blocksDecoded - before,
        "a broken error reporter must not stop the chain",
      )
      .toBe(counter.blocks);
    // P2V FINDING: an unhandled rejection for every link the poisoned chain
    // refused to run.
    expect.soft(rejections.length, "the chain must not reject").toBe(0);
    // The session still looks healthy, and still believes it is paired.
    expect.soft(hostileEnterer.session.state).toBe("listening");
    expect.soft(hostileEnterer.session.pairing.kind).toBe("paired");
    expect.soft(hostileEnterer.moduleErrors).toHaveLength(0);
  });

  it("keeps the chain alive when the reporter is the console (the safe default)", async () => {
    const counter = { blocks: 0 };
    const own = await openSoundChatCodec();
    extraCodecs.push(own);
    const displayer = await createPeer({ label: "displayer", role: "displayer", codec: codecA });
    const enterer = await createPeer({
      label: "enterer",
      role: "enterer",
      codec: countingCodec(own, counter),
      pairingCode: displayer.session.pairingCode,
      onEvent: (event) => {
        if (event.type === "heard-unreadable") throw new Error("consumer bug");
      },
      // No `onListenerError` at all: the product's own fallback is used, and
      // `console.error` cannot throw.
      withListenerError: false,
    });
    await pairUp(displayer, enterer);
    enterer.takeAir();
    feed(enterer, new Float32Array(SAMPLE_FRAME * 120));
    await settle();
    counter.blocks = 0;
    const before = enterer.session.stats.blocksDecoded;

    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const waveform = await unreadableWaveform(displayer.session.pairingCode, new Uint8Array(16));
      feed(enterer, waveform);
      await settle();
      expect(counter.blocks).toBeGreaterThan(1);
      // New coverage: with the default reporter, every block is still handled
      // and the failure is reported once per event rather than swallowed.
      expect(enterer.session.stats.blocksDecoded - before).toBe(counter.blocks);
      expect(enterer.session.stats.framesUnreadable).toBeGreaterThanOrEqual(counter.blocks);
      expect(spy).toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  it("does not let a broken reporter turn the public API into a throwing one", async () => {
    const own = await openSoundChatCodec();
    extraCodecs.push(own);
    const alone = await createPeer({
      label: "alone",
      role: "displayer",
      codec: own,
      onEvent: () => {
        throw new Error("consumer bug");
      },
      onListenerError: () => {
        throw new Error("the error reporter is broken too");
      },
    });
    // P2V FINDING: `start()` is documented as a plain call that never throws;
    // with a reporter that throws, the exception comes straight back out of the
    // event dispatch inside it.
    expect(() => alone.session.start()).not.toThrow();
    // ...and the same is true of teardown, which is the call a UI makes while
    // unmounting and has no way to guard.
    expect(() => alone.session.stop()).not.toThrow();
  });
});
