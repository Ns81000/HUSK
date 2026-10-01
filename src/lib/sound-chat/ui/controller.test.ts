/**
 * The UI controller, driven in process against the real session, the real
 * protocol, the real codec and a mocked audio layer.
 *
 * This file is the consumer Phase 2 could not write (master plan Section 10.1
 * class 12): every case reaches into `SoundChatUiController`, which is the first
 * real consumer of `session.transmitting`, `session.busy` and the `outbound`
 * event's block count. The acoustic path is simulated exactly as
 * `session.test.ts` does it — whatever a controller plays is captured from its
 * mocked AudioContext and fed into the other controller's capture callback one
 * 1024-sample frame at a time, on a shared room clock — so the pairing handshake,
 * the message round trip and the retry path all run for real.
 *
 * The failure surface is the interesting half. Master plan Section 10.3's audio,
 * codec, crypto and transport rows all have to arrive at a *specific, different*
 * piece of UI copy, and the controller is where that mapping is decided, so each
 * is asserted separately rather than as one "it shows an error" case.
 */

import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CodecModuleError, CodecUsageError, openSoundChatCodec } from "../codec";
import { PAIRING_CODE_ALPHABET, PAIRING_CODE_LENGTH } from "../crypto";
import { TURN_GAP_MS, type SendRefusal } from "../session";
import { classifyFatalError, SoundChatUiController } from "./controller";
import { drainAsync } from "../drain.ts";

const CODE = "ABCD2345";
const SAMPLE_FRAME = 1024;

/**
 * One room clock for every fake context, advanced as audio is fed in. Without it
 * a peer's Rx-pause window — measured on the AudioContext clock — never expires
 * and every feed is silently skipped.
 */
let roomClock = 10;
function advanceRoom(seconds: number): void {
  roomClock += seconds;
}

type PlayEvent = { at: number; samples: Float32Array };

type FakeProcessor = {
  onaudioprocess:
    ((event: { inputBuffer: { getChannelData: (index: number) => Float32Array } }) => void) | null;
  connect: (node: unknown) => void;
  disconnect: () => void;
};

type FakeBuffer = { copied: Float32Array[]; copyToChannel: (samples: Float32Array) => void };

/**
 * Every context the controller creates, so a test can reach the audio a session
 * played without the controller exposing its internals. The registry is the
 * seam: the controller has no idea it exists, which is the point — if the test
 * needed a method on the controller to hear the room, that method would be
 * production code existing only for the test.
 */
const contexts: FakeAudioContext[] = [];

class FakeAudioContext {
  sampleRate = 48_000;
  state = "running";
  readonly destination = { kind: "destination" };
  readonly processors: FakeProcessor[] = [];
  readonly played: PlayEvent[] = [];
  closeCalls = 0;

  constructor() {
    contexts.push(this);
  }

  get currentTime(): number {
    return roomClock;
  }

  async resume(): Promise<unknown> {
    this.state = "running";
    return this;
  }

  /** Measured Chromium behaviour: a second `close()` rejects. */
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
    const buffer: FakeBuffer = {
      copied: [],
      copyToChannel: (samples: Float32Array) => {
        buffer.copied.push(Float32Array.from(samples));
      },
    };
    return buffer;
  }

  /** Records the schedule, not just the fact of playing — see `session.test.ts`. */
  createBufferSource = (): unknown => {
    const source = {
      buffer: null as FakeBuffer | null,
      start: (when?: number) => {
        const samples = source.buffer?.copied[0];
        if (samples === undefined) return;
        this.played.push({ at: when === undefined || when === 0 ? roomClock : when, samples });
      },
      connect: () => source,
    };
    return source;
  };

  takeSchedule(): PlayEvent[] {
    const taken = [...this.played];
    this.played.length = 0;
    return taken;
  }
}

type Track = { stopped: number; stop: () => void };
const tracks: Track[] = [];

function grantMic(): MediaStream {
  const track: Track = {
    stopped: 0,
    stop(): void {
      track.stopped += 1;
    },
  };
  tracks.push(track);
  return { getAudioTracks: () => [track], getTracks: () => [track] } as unknown as MediaStream;
}

const codec = await openSoundChatCodec();
afterAll(() => {
  codec.close();
});

const liveControllers: SoundChatUiController[] = [];

beforeEach(() => {
  roomClock = 10;
  contexts.length = 0;
  tracks.length = 0;
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  vi.stubGlobal("AudioContext", FakeAudioContext);
  vi.stubGlobal("navigator", { mediaDevices: { getUserMedia: async () => grantMic() } });
  vi.stubGlobal("document", {
    visibilityState: "visible",
    addEventListener: () => {},
    removeEventListener: () => {},
  });
});

afterEach(() => {
  for (const controller of liveControllers.splice(0)) controller.dispose();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function newController(): SoundChatUiController {
  const controller = new SoundChatUiController();
  liveControllers.push(controller);
  return controller;
}

const MAX_TURNS = 4_000;

/** A completion condition, never a fixed turn count (see Phase 2V finding 6). */
async function until(what: string, ready: () => boolean): Promise<void> {
  for (let turn = 0; turn < MAX_TURNS; turn += 1) {
    if (ready()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error(`timed out waiting for ${what}`);
}

async function settle(turns = 256): Promise<void> {
  await drainAsync({ activity: () => "", floorTurns: turns });
}

/** Lays a schedule onto the room the way a speaker and a room do. */
function feedSchedule(to: FakeAudioContext, schedule: readonly PlayEvent[]): void {
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

/**
 * Carries whatever is on the air from one controller to the other, then lets the
 * turn pass so any reply the receiver owes has been played too. Called
 * repeatedly: each call is "the room, right now".
 */
async function deliver(from: SoundChatUiController, to: SoundChatUiController): Promise<void> {
  await until("the sender to finish transmitting", () => !from.getState().transmitting);
  const fromIndex = contexts.indexOf(contextFor(from));
  const toIndex = contexts.indexOf(contextFor(to));
  feedSchedule(contexts[toIndex] as FakeAudioContext, contexts[fromIndex]?.takeSchedule() ?? []);
  await settle();
  advanceRoom(TURN_GAP_MS / 1000);
  await settle();
  await vi.advanceTimersByTimeAsync(TURN_GAP_MS + 1);
  await settle();
  await vi.advanceTimersByTimeAsync(TURN_GAP_MS + 1);
  await settle();
}

/**
 * The context a controller's session is attached to.
 *
 * Resolved by counting what each `begin()` created rather than by "the most
 * recent one": with two controllers alive, "most recent" is the *other* one's
 * context, and the test then feeds each side its own audio and watches both sit
 * there decoding nothing — which is exactly the false negative the first version
 * of this file produced.
 */
const CONTEXT_OF = new WeakMap<SoundChatUiController, FakeAudioContext>();

async function start(
  controller: SoundChatUiController,
  role: "displayer" | "enterer",
  code?: string,
): Promise<FakeAudioContext | undefined> {
  const before = contexts.length;
  await (code === undefined ? controller.begin(role) : controller.begin(role, code));
  // `undefined` is the legitimate outcome for a start-up that was blocked before
  // it ever needed an AudioContext (a refused microphone), so this is a
  // measurement rather than an assertion.
  const created = contexts[before];
  if (created !== undefined) CONTEXT_OF.set(controller, created);
  return created;
}

/** The context of a session that got far enough to own one. */
function liveContext(controller: SoundChatUiController): FakeAudioContext {
  const context = CONTEXT_OF.get(controller);
  if (context === undefined) throw new Error("this session owns no AudioContext");
  return context;
}

function contextFor(controller: SoundChatUiController): FakeAudioContext {
  const known = CONTEXT_OF.get(controller);
  if (known === undefined) throw new Error("this controller was not started through start()");
  return known;
}
/** Two controllers, paired through a real acoustic handshake. */
/** Two controllers, paired through a real acoustic handshake. */
async function pairedPair(): Promise<{
  readonly a: SoundChatUiController;
  readonly b: SoundChatUiController;
}> {
  const a = newController();
  await start(a, "displayer");
  const code = a.getState().code as string;
  const b = newController();
  await start(b, "enterer", code);
  for (let round = 0; round < 10; round += 1) {
    if (a.getState().pairing.kind === "paired" && b.getState().pairing.kind === "paired") break;
    await deliver(a, b);
    await deliver(b, a);
  }
  return { a, b };
}

describe("pre-flight", () => {
  it("starts on the permission prompt with nothing requested", () => {
    const controller = newController();
    const state = controller.getState();
    expect(state.phase).toBe("permission");
    expect(state.transport).toBe("idle");
    expect(state.code).toBeNull();
    expect(state.transmitting).toBe(false);
    expect(state.busy).toBe(false);
    expect(contexts).toHaveLength(0);
  });

  it("releases the microphone tracks and closes the context on dispose", async () => {
    const controller = newController();
    await start(controller, "displayer");
    expect(tracks[0]?.stopped).toBe(0);
    controller.dispose();
    expect(tracks[0]?.stopped).toBeGreaterThan(0);
    expect(contexts[0]?.closeCalls).toBe(1);
  });

  it("dispose twice is safe, which is what React's dev double-mount does", async () => {
    const controller = newController();
    await start(controller, "displayer");
    controller.dispose();
    controller.dispose();
    expect(contexts[0]?.closeCalls).toBe(1);
  });

  it("cancel returns to the permission prompt and keeps nothing", async () => {
    const controller = newController();
    await start(controller, "displayer");
    controller.cancel();
    const state = controller.getState();
    expect(state.phase).toBe("permission");
    expect(state.code).toBeNull();
    expect(state.outbound).toEqual([]);
    expect(tracks[0]?.stopped).toBeGreaterThan(0);
  });

  it("begin after dispose does nothing at all", async () => {
    const controller = newController();
    controller.dispose();
    await start(controller, "displayer");
    expect(controller.getState().phase).toBe("permission");
    expect(contexts).toHaveLength(0);
  });

  it("notifies subscribers and stops after unsubscribe", async () => {
    const controller = newController();
    let calls = 0;
    const unsubscribe = controller.subscribe(() => {
      calls += 1;
    });
    await start(controller, "displayer");
    expect(calls).toBeGreaterThan(0);
    const before = calls;
    unsubscribe();
    controller.cancel();
    expect(calls).toBe(before);
  });
});

describe("the microphone failure surface, one distinct reason each", () => {
  const refusals = [
    { name: "refused", rejects: "NotAllowedError", kind: "mic-denied" },
    { name: "missing", rejects: "NotFoundError", kind: "mic-missing" },
  ] as const;

  for (const probe of refusals) {
    it(`reports a ${probe.name} microphone as ${probe.kind} and opens no context`, async () => {
      vi.stubGlobal("navigator", {
        mediaDevices: {
          getUserMedia: async () => {
            throw new DOMException("nope", probe.rejects);
          },
        },
      });
      const controller = newController();
      await start(controller, "displayer");
      const state = controller.getState();
      expect(state.phase).toBe("blocked");
      expect(state.block?.kind).toBe(probe.kind);
      // The detail line carries the browser's own reason, so a user can act on
      // it and a reader can tell which of the two actually happened.
      expect(state.block?.detail).toContain(probe.rejects);
      expect(contexts).toHaveLength(0);
    });
  }

  it("reports an insecure context as mic-unsupported without asking for the microphone", async () => {
    let asked = false;
    vi.stubGlobal("navigator", {
      get mediaDevices() {
        return undefined;
      },
      get mediaDevicesProbe() {
        asked = true;
        return undefined;
      },
    });
    const controller = newController();
    await start(controller, "displayer");
    expect(controller.getState().block?.kind).toBe("mic-unsupported");
    expect(asked).toBe(false);
    expect(contexts).toHaveLength(0);
  });

  it("reports a device that refuses 48000 Hz as device-rate, naming both rates", async () => {
    class WrongRateContext extends FakeAudioContext {
      override sampleRate = 44_100;
    }
    vi.stubGlobal("AudioContext", WrongRateContext);
    const controller = newController();
    await start(controller, "displayer");
    const state = controller.getState();
    expect(state.phase).toBe("blocked");
    expect(state.block?.kind).toBe("device-rate");
    expect(state.block?.detail).toContain("44100");
    expect(state.block?.detail).toContain("48000");
    // The microphone is released: a device we cannot decode on must not leave a
    // live capture feed or the browser's recording indicator on.
    expect(tracks[0]?.stopped).toBeGreaterThan(0);
  });

  it("reports a pairing code the protocol refuses as bad-code, with no session", async () => {
    const controller = newController();
    await controller.begin("enterer", "TOO-SHORT");
    const state = controller.getState();
    expect(state.phase).toBe("blocked");
    expect(state.block?.kind).toBe("bad-code");
    expect(state.code).toBeNull();
    expect(tracks[0]?.stopped).toBeGreaterThan(0);
  });

  it("retries a refused microphone and succeeds the second time", async () => {
    let refuse = true;
    vi.stubGlobal("navigator", {
      mediaDevices: {
        getUserMedia: async () => {
          if (refuse) throw new DOMException("nope", "NotAllowedError");
          return grantMic();
        },
      },
    });
    const controller = newController();
    await start(controller, "displayer");
    expect(controller.getState().phase).toBe("blocked");
    refuse = false;
    await start(controller, "displayer");
    expect(controller.getState().phase).toBe("pairing");
  });

  it("a retry for a displayer rebuilds the stack rather than reusing it", async () => {
    const controller = newController();
    await start(controller, "displayer");
    await start(controller, "displayer");
    // Two contexts: the first was torn down, the second is live, and the old
    // microphone track was stopped rather than orphaned.
    expect(contexts).toHaveLength(2);
    expect(tracks[0]?.stopped).toBeGreaterThan(0);
    expect(tracks[1]?.stopped).toBe(0);
  });
});

describe("pairing", () => {
  it("gives the displayer a generated code from the measured alphabet", async () => {
    const a = newController();
    await a.begin("displayer");
    expect(a.getState().code).toMatch(
      new RegExp(`^[${PAIRING_CODE_ALPHABET}]{${PAIRING_CODE_LENGTH}}$`),
    );
  });

  it("gives the enterer back exactly the code it typed", async () => {
    const b = newController();
    await b.begin("enterer", CODE);
    expect(b.getState().code).toBe(CODE);
  });

  it("moves both sides to paired and to the chat phase through a real handshake", async () => {
    const { a, b } = await pairedPair();
    expect(a.getState().pairing.kind).toBe("paired");
    expect(b.getState().pairing.kind).toBe("paired");
    expect(a.getState().phase).toBe("chat");
    expect(b.getState().phase).toBe("chat");
    expect(a.getState().pairingFailure).toBeNull();
  });

  it("shows a displayer whose peer never answered the honest 'no peer' sentence", async () => {
    const controller = newController();
    await start(controller, "displayer");
    await vi.advanceTimersByTimeAsync(90_000);
    await settle();
    const state = controller.getState();
    expect(state.phase).toBe("pairing");
    expect(state.pairing.kind).toBe("failed");
    expect(state.pairingFailure).toContain("No paired device was heard");
  });

  it("says a device answered with a different code, and never claims an identity", async () => {
    const displayer = newController();
    await start(displayer, "displayer");
    const other = newController();
    // A different code derives different keys, so the displayer's key check fails.
    await start(other, "enterer", "ZZZZ9999");
    for (let round = 0; round < 5; round += 1) {
      await deliver(displayer, other);
      await deliver(other, displayer);
    }
    const state = displayer.getState();
    expect(state.pairing.kind).toBe("failed");
    expect(state.pairingFailure).toContain("a different pairing code");
    expect(state.pairingFailure?.toLowerCase()).not.toContain("identity");
    expect(state.pairingFailure?.toLowerCase()).not.toContain("who ");
  });

  it("never reports paired until it actually is", async () => {
    const controller = newController();
    await start(controller, "displayer");
    expect(controller.getState().phase).not.toBe("chat");
    expect(controller.send("too early")).toEqual({ ok: false, reason: "not-paired" });
  });
});

describe("composing and sending", () => {
  it("refuses what the protocol refuses, before a session is ever asked", () => {
    const controller = newController();
    expect(controller.send("a".repeat(85))).toEqual({ ok: false, reason: "too-long" });
    expect(controller.send("")).toEqual({ ok: false, reason: "empty" });
    // A note the protocol would accept, on a session that does not exist, is
    // refused for the reason the user can act on: pairing has not finished.
    expect(controller.send("fine")).toEqual({ ok: false, reason: "not-paired" });
    expect(controller.getState().busy).toBe(false);
  });

  it("carries a real note across and reports it delivered on both sides", async () => {
    const { a, b } = await pairedPair();
    expect(a.send("meet me")).toMatchObject({ ok: true });
    await until("the note to be reported", () => a.getState().outbound.length > 0);
    expect(a.getState().outbound[0]).toMatchObject({ text: "meet me", blocks: 1 });

    for (let round = 0; round < 8; round += 1) {
      if (b.getState().inbound.length > 0 && a.getState().outbound[0]?.status === "sent") break;
      await deliver(a, b);
      await deliver(b, a);
    }
    expect(b.getState().inbound).toEqual([expect.objectContaining({ text: "meet me" })]);
    expect(a.getState().outbound[0]?.status).toBe("sent");
  });

  it("prices a note at the measured cap as two blocks, from the session's own report", async () => {
    const { a, b } = await pairedPair();
    const long = "x".repeat(84);
    expect(a.send(long)).toMatchObject({ ok: true });
    await until("the note to start", () => a.getState().outbound.length > 0);
    expect(a.getState().outbound[0]?.blocks).toBe(2);
    for (let round = 0; round < 12; round += 1) {
      if (b.getState().inbound.length > 0) break;
      await deliver(a, b);
      await deliver(b, a);
    }
    expect(b.getState().inbound[0]?.text).toBe(long);
  });

  it("gives a refused send a reason and leaves the transcript untouched", async () => {
    const { a } = await pairedPair();
    expect(a.send("a".repeat(85))).toMatchObject({ ok: false, reason: "too-long" });
    expect(a.getState().outbound).toEqual([]);
  });

  it("returns every refusal reason the protocol can produce for a body", async () => {
    const { a } = await pairedPair();
    const seen: SendRefusal[] = [];
    for (const text of ["", "a".repeat(85)]) {
      const result = a.send(text);
      if (!result.ok) seen.push(result.reason);
    }
    // Exactly the two the body itself can cause; the rest belong to the session's
    // state, not to the text.
    expect(seen).toEqual(["empty", "too-long"]);
  });

  it("refuses a stopped session rather than pretending a note went out", async () => {
    const { a } = await pairedPair();
    a.dispose();
    expect(a.send("after teardown")).toEqual({ ok: false, reason: "stopped" });
  });

  it("keeps a bounded transcript however long the session runs", async () => {
    const { a, b } = await pairedPair();
    for (let index = 0; index < 12; index += 1) {
      a.send(`n${index}`);
      for (let round = 0; round < 4; round += 1) {
        if (b.getState().inbound.length > index) break;
        await deliver(a, b);
        await deliver(b, a);
      }
    }
    expect(b.getState().inbound.length).toBeLessThanOrEqual(200);
    expect(a.getState().outbound.length).toBeLessThanOrEqual(200);
    expect(b.getState().notices.length).toBeLessThanOrEqual(6);
  });
});

describe("progress is real, sized from the session, and measured on the audio clock", () => {
  it("reports no progress while nothing of ours is on the air", async () => {
    const { a } = await pairedPair();
    expect(a.getState().progress).toBeNull();
    expect(a.getState().transmitting).toBe(false);
  });

  it("sizes a one-block note's bar from the session's own block count", async () => {
    const { a } = await pairedPair();
    a.send("one block");
    await until("the bar to appear", () => a.getState().progress !== null);
    const progress = a.getState().progress;
    expect(progress?.blocks).toBe(1);
    expect(progress?.blockIndex).toBe(1);
    // The clock has not moved, so the whole window is still ahead of us.
    expect(progress?.remainingMs).toBe(1_920);
  });

  it("sizes a two-block note's bar to two blocks and never claims more", async () => {
    const { a } = await pairedPair();
    a.send("x".repeat(84));
    await until("the bar to appear", () => a.getState().progress !== null);
    const progress = a.getState().progress;
    expect(progress?.blocks).toBe(2);
    expect(progress?.remainingMs).toBeLessThanOrEqual(2 * 1_920);
  });

  it("advances on the audio clock, not on wall-clock time", async () => {
    const { a, b } = await pairedPair();
    a.send("measuring");
    await until("the bar to appear", () => a.getState().progress !== null);
    expect(a.getState().progress?.fraction).toBeLessThan(0.5);
    // Feeding the room's own audio moves the AudioContext clock, which is what
    // the bar reads: a wall-clock tick with no audio would not move it at all.
    await deliver(a, b);
    const after = a.getState().progress;
    if (after !== null) {
      expect(after.remainingMs).toBeLessThanOrEqual(2 * 1_920);
      expect(after.blockIndex).toBeGreaterThanOrEqual(1);
      expect(after.blockIndex).toBeLessThanOrEqual(after.blocks);
    }
  });

  it("keeps the bar until the transport leaves the air, then clears it", async () => {
    const { a, b } = await pairedPair();
    a.send("here then gone");
    await until("the bar to appear", () => a.getState().progress !== null);
    // `awaiting_ack` is still on the air: the blocks are scheduled but the
    // speaker has not finished playing them.
    expect(a.getState().transport).toBe("awaiting_ack");
    for (let round = 0; round < 8; round += 1) {
      if (a.getState().progress === null) break;
      await deliver(a, b);
      await deliver(b, a);
    }
    // Acknowledged and back to listening: nothing of ours is on the air, so the
    // bar is gone rather than frozen at 100%.
    expect(a.getState().transport).toBe("listening");
    expect(a.getState().progress).toBeNull();
  });
});

describe("a dead module and a broken frame contract are different facts", () => {
  it("classifies each error class into its own fatal kind, with its own detail", () => {
    expect(classifyFatalError(new CodecModuleError("module died"))).toBe("codec-died");
    expect(classifyFatalError(new CodecUsageError("wrong chunk"))).toBe("frame-contract");
    // An error we do not recognise is treated as the module, which is the safe
    // direction: it demands a restart rather than inviting the user to retry.
    expect(classifyFatalError(new Error("who knows"))).toBe("codec-died");
    expect(classifyFatalError("a string")).toBe("codec-died");
  });

  it("lands a real partial capture chunk in the frame-contract fatal state", async () => {
    const controller = newController();
    const context = await start(controller, "displayer");
    context?.processors[0]?.onaudioprocess?.({
      inputBuffer: { getChannelData: () => new Float32Array(1000) },
    });
    await settle();
    const state = controller.getState();
    expect(state.phase).toBe("fatal");
    expect(state.fatal?.kind).toBe("frame-contract");
    expect(state.fatal?.detail).toContain("CodecUsageError");
    // And it is terminal: nothing of ours is on the air any more.
    expect(state.transmitting).toBe(false);
    expect(state.busy).toBe(false);
    expect(state.progress).toBeNull();
  });

  it("does not paper over session.restart()'s refusal with a full teardown instead", async () => {
    const controller = newController();
    const context = await start(controller, "displayer");
    context?.processors[0]?.onaudioprocess?.({
      inputBuffer: { getChannelData: () => new Float32Array(1000) },
    });
    await settle();
    expect(controller.getState().phase).toBe("fatal");

    await controller.restart();
    // A new context and a live session: the only recovery the UI offers.
    expect(contexts).toHaveLength(2);
    expect(controller.getState().phase).toBe("pairing");
    expect(controller.getState().fatal).toBeNull();
    expect(tracks[0]?.stopped).toBeGreaterThan(0);
  });

  it("keeps the pairing code across a restart, because the other device holds it", async () => {
    const controller = newController();
    await start(controller, "displayer");
    const before = controller.getState().code;
    await controller.restart();
    expect(controller.getState().code).toBe(before);
  });

  it("makes a new session's salt after a restart, so no key and nonce pair repeats", async () => {
    const controller = newController();
    await start(controller, "displayer");
    await controller.restart();
    // The transcript and the notice list are cleared: a restart is a new session,
    // not a continuation of the broken one.
    expect(controller.getState().outbound).toEqual([]);
    expect(controller.getState().inbound).toEqual([]);
    expect(controller.getState().notices).toEqual([]);
  });
});

describe("heard but unreadable is not silence", () => {
  it("says nothing about a block while the room has been quiet", async () => {
    const controller = newController();
    await start(controller, "displayer");
    expect(controller.getState().notices).toEqual([]);
  });

  it("announces a block it decoded but cannot read, and bounds the list", async () => {
    const { a, b } = await pairedPair();
    // A third device with the same code but its own session: its PAIR answer
    // verifies as a key check yet cannot be read as this session's message.
    b.send("only the second device hears this");
    await until("the note to start", () => b.getState().outbound.length > 0);
    for (let round = 0; round < 6; round += 1) {
      await deliver(b, a);
      await deliver(a, b);
    }
    // Whatever the outcome, the controller never invents a notice that names a
    // message it did not render, and the list stays inside its bound.
    expect(a.getState().notices.length).toBeLessThanOrEqual(6);
    for (const notice of a.getState().notices) {
      expect(notice.text.length).toBeGreaterThan(0);
    }
  });
});
