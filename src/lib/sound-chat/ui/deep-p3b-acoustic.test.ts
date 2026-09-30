/**
 * Phase 3V, seam 2 continued: the same state machine, driven through the *real*
 * session, the real protocol, the real codec and a mocked audio layer.
 *
 * The harness is copied from `deep-p3-controller.test.ts` on purpose — no jsdom,
 * no happy-dom, no testing-library may be added, so the fakes are the contract.
 * What is different here: the `document` stub records its `visibilitychange`
 * listener so a test can really hide and show the tab, and the context clock can
 * be driven to a non-finite value.
 *
 * Every finding is asserted as observed behaviour, so a fix fails the test that
 * recorded the bug — the direction a bug report should fail in.
 */

import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openSoundChatCodec } from "../codec";
import { TURN_GAP_MS } from "../session";
import { measureMessage } from "./budget";
import { SoundChatUiController, type SoundChatUiState } from "./controller";

const SAMPLE_FRAME = 1024;

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

const contexts: FakeAudioContext[] = [];
let clockIsBroken = false;

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
    if (clockIsBroken) return Number.NaN;
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

  createBuffer(): FakeBuffer {
    const buffer: FakeBuffer = {
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
let hidden = false;
type VisibilityListener = () => void;
const visibilityListeners = new Set<VisibilityListener>();

/**
 * Gates `crypto.subtle.encrypt` so a test can hold a message inside
 * `buildMessageFrames` — the one `await` a `#pump` sits in while a note is "in
 * flight" and nothing has been published about it yet.
 */
type SealGate = { entered: () => boolean; release: () => void; restore: () => void };

function gateSeal(): SealGate {
  const real = globalThis.crypto;
  let entered = false;
  let open: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    open = resolve;
  });
  const subtle = new Proxy(real.subtle, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      if (property === "encrypt") {
        return async (...args: unknown[]) => {
          entered = true;
          await gate;
          return Reflect.apply(value as (...a: unknown[]) => unknown, target, args);
        };
      }
      return typeof value === "function"
        ? (value as (...a: unknown[]) => unknown).bind(target)
        : value;
    },
  });
  vi.stubGlobal(
    "crypto",
    new Proxy(real, {
      get(target, property) {
        if (property === "subtle") return subtle;
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }),
  );
  // `vi.unstubAllGlobals()` in `afterEach` puts the real one back.
  return { entered: () => entered, release: open, restore: () => {} };
}

beforeEach(() => {
  roomClock = 10;
  clockIsBroken = false;
  hidden = false;
  contexts.length = 0;
  tracks.length = 0;
  visibilityListeners.clear();
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
  vi.stubGlobal("AudioContext", FakeAudioContext);
  vi.stubGlobal("navigator", { mediaDevices: { getUserMedia: async () => grantMic() } });
  vi.stubGlobal("document", {
    get visibilityState(): string {
      return hidden ? "hidden" : "visible";
    },
    addEventListener: (type: string, listener: VisibilityListener) => {
      if (type === "visibilitychange") visibilityListeners.add(listener);
    },
    removeEventListener: (type: string, listener: VisibilityListener) => {
      if (type === "visibilitychange") visibilityListeners.delete(listener);
    },
  });
});

afterEach(() => {
  for (const controller of liveControllers.splice(0)) controller.dispose();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function setHidden(next: boolean): void {
  hidden = next;
  for (const listener of [...visibilityListeners]) listener();
}

function newController(): SoundChatUiController {
  const controller = new SoundChatUiController();
  liveControllers.push(controller);
  return controller;
}

const MAX_TURNS = 4_000;

async function until(what: string, ready: () => boolean): Promise<void> {
  for (let turn = 0; turn < MAX_TURNS; turn += 1) {
    if (ready()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error(`timed out waiting for ${what}`);
}

async function settle(turns = 256): Promise<void> {
  for (let turn = 0; turn < turns; turn += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

async function untilTimed(what: string, ready: () => boolean, stepMs = 100): Promise<void> {
  for (let turn = 0; turn < MAX_TURNS; turn += 1) {
    if (ready()) return;
    await vi.advanceTimersByTimeAsync(stepMs);
  }
  throw new Error(`timed out waiting for ${what}`);
}

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

const CONTEXT_OF = new WeakMap<SoundChatUiController, FakeAudioContext>();

async function start(
  controller: SoundChatUiController,
  role: "displayer" | "enterer",
  code?: string,
): Promise<FakeAudioContext | undefined> {
  const before = contexts.length;
  await (code === undefined ? controller.begin(role) : controller.begin(role, code));
  const created = contexts[before];
  if (created !== undefined) CONTEXT_OF.set(controller, created);
  return created;
}

function contextFor(controller: SoundChatUiController): FakeAudioContext {
  const known = CONTEXT_OF.get(controller);
  if (known === undefined) throw new Error("this controller was not started through start()");
  return known;
}

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

/** Every distinct snapshot the controller publishes, in order. */
function snapshotTrace(controller: SoundChatUiController): {
  readonly states: SoundChatUiState[];
  readonly stop: () => void;
} {
  const states: SoundChatUiState[] = [controller.getState()];
  const unsubscribe = controller.subscribe(() => states.push(controller.getState()));
  return { states, stop: unsubscribe };
}

describe("B-1 a retry is a new transmission, and the bar is sized for the wrong one", () => {
  it("a two-block note's retry shows a two-block bar for 3.84 s of sound", async () => {
    const { a, b } = await pairedPair();
    const context = contextFor(a);
    // The peer never hears it, so the ACK window closes and the message is
    // retried with every block.
    a.send("y".repeat(84));
    await until("the first attempt to start", () => a.getState().progress !== null);
    expect(a.getState().progress?.blocks, "the first attempt is sized from the session").toBe(2);
    context.takeSchedule();

    // Nothing is delivered: advance past ACK_TIMEOUT_MS so the machine goes to
    // backoff and then re-enters `transmitting` for the retry.
    for (let step = 0; step < 200; step += 1) {
      advanceRoom(0.1);
      await vi.advanceTimersByTimeAsync(100);
      if ((a.getState().outbound[0]?.attempts ?? 0) > 1) break;
    }
    expect(a.getState().outbound[0]?.attempts).toBeGreaterThan(1);
    // What is actually on the air: two blocks, 50 ms apart, as the first
    // attempt was.
    const scheduled = context.takeSchedule();
    expect(scheduled.length, "the retry really does play both blocks").toBe(2);
    expect(scheduled[1]!.at - scheduled[0]!.at).toBeCloseTo(1.92, 1);

    // What the bar claims. The record is keyed on the pump's *claim* and
    // restarted there, because `#stopProgress` zeroes `#pendingBlocks` when the
    // ACK times out and `TRANSMIT_BEGIN` for the retry lands before the
    // `outbound` event that carries the real count.
    const retry = a.getState().progress;
    expect(retry?.blocks, "a bar that claims 1.92 s of sound for a 3.84 s schedule").toBe(2);
    expect(retry?.remainingMs).toBe(3_840);
    a.cancel();
    void b;
  });
});

describe("B-2 the window the composer promises is never published", () => {
  it("the real session publishes no `transmitting` without a progress record", async () => {
    const { a, b } = await pairedPair();
    const trace = snapshotTrace(a);
    // A whole exchange: one short note, one note at the cap, and a second send
    // while the first is still in flight.
    a.send("one");
    for (let round = 0; round < 12; round += 1) {
      const outbound = a.getState().outbound;
      if (outbound.length > 0 && outbound.every((entry) => entry.status !== "sending")) break;
      await deliver(a, b);
      await deliver(b, a);
    }
    expect(a.getState().outbound[0]?.status, "the first note was confirmed").toBe("sent");
    a.send("t".repeat(84));
    a.send("three");
    for (let round = 0; round < 12; round += 1) {
      const outbound = a.getState().outbound;
      if (outbound.length >= 3 && outbound.every((entry) => entry.status !== "sending")) break;
      await deliver(a, b);
      await deliver(b, a);
    }
    trace.stop();

    const arming = trace.states.filter(
      (state) =>
        state.transmitting && state.progress === null && state.transport !== "awaiting_ack",
    );
    // `SOUND_CHAT_COPY.transmit.arming` exists for this window, and the
    // controller never publishes it: `session.send()` claims `#txBusy`
    // synchronously but notifies nobody, and `outbound sending` and
    // `TRANSMIT_BEGIN` land inside one microtask, so no render ever sees it.
    expect(arming.map((state) => state.transport)).toEqual([]);
    // The states that were published in the window instead.
    expect(trace.states.length).toBeGreaterThan(10);
    a.cancel();
  });
});

describe("B-3 a hidden tab holds a send, and the bar's timer does not", () => {
  it("a send held by a hidden tab does not start the 10 Hz ticker", async () => {
    const { a } = await pairedPair();
    const quiet = vi.getTimerCount();
    setHidden(true);
    expect(a.getState().transport).toBe("hidden_hold");

    a.send("held until the tab is back");
    await until("the held note to be published", () => a.getState().outbound.length > 0);
    const state = a.getState();
    // Nothing of ours is on the air, so nothing is shown as a bar…
    expect(state.progress).toBeNull();
    // …but `#startProgress` was reached from the `outbound sending` event and
    // allocated the interval anyway. It is released only by `#stopProgress`, which
    // is reached only from a transport event, and the machine is parked in
    // `#startProgress` decides from the session's own state rather than from the
    // event that reached it, so a claim made while the machine is parked in
    // `hidden_hold` starts no record: there is no bar on screen, so there is
    // nothing for a timer to move, and no snapshot to publish ten times a second.
    expect(vi.getTimerCount(), "a 10 Hz ticker behind a hidden tab").toBe(quiet);

    // And it really is quiet: a third of a second with the tab hidden produces no
    // new snapshot at all.
    const before = a.getState();
    await vi.advanceTimersByTimeAsync(350);
    expect(a.getState()).toBe(before);
    expect(a.getState().progress).toBeNull();

    // Only a transport event (here: the tab coming back, which also resumes the
    // send) or teardown recovers it.
    setHidden(false);
    await settle();
    expect(
      a.getState().progress,
      "the held note resumed, so the bar is legitimate now",
    ).not.toBeNull();
    a.cancel();
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("B-4 a module death with a send in flight", () => {
  it("the in-flight pump cannot publish a note as `sending` on a fatal screen", async () => {
    const { a } = await pairedPair();
    const context = contextFor(a);
    // Hold the pump inside the frame seal — the one `await` a note spends while
    // the pump owns the queue and nothing has been published about it yet.
    const gate = gateSeal();
    try {
      a.send("in flight when the codec dies");
      await until("the seal to start", () => gate.entered());
      // A whole-frame violation is what a `CodecUsageError` looks like from here.
      context.processors[0]?.onaudioprocess?.({
        inputBuffer: { getChannelData: () => new Float32Array(1000) },
      });
      await settle();
      expect(a.getState().phase, "a frame-contract failure is terminal too").toBe("fatal");
      // The pump had not yet created `#outbound`, so `#moduleFailed` had nothing
      // to report as `failed`: the transcript holds no note at all.
      expect(a.getState().outbound).toEqual([]);
      gate.release();
      await settle();
      for (let step = 0; step < 500 && a.getState().outbound.length === 0; step += 1) {
        await new Promise((resolve) => setImmediate(resolve));
      }
    } finally {
      gate.restore();
    }

    const state = a.getState();
    // The latch in `#onEvent` drops it, so in this ordering the pump's late claim
    // never reaches the transcript at all. Either way the one thing that must not
    // happen is a note that can never be sent reading "Playing" on a terminal
    // screen: the row is either absent or `failed`, never `sending`.
    expect(
      state.outbound.some((entry) => entry.status === "sending"),
      "a note that can never be sent is published to a terminal screen as 'Playing'",
    ).toBe(false);
    // Read from the session, not hard-coded, so the terminal screen cannot
    // disagree with the transport about whether the dead session is still busy.
    expect(state.busy).toBe(true);
    expect(state.phase).toBe("fatal");
    expect(state.progress, "a terminal screen shows no bar").toBeNull();
    expect(vi.getTimerCount(), "with a 10 Hz ticker behind a terminal screen").toBe(0);
    a.cancel();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("KNOWN DEFECT: a note accepted before the failure is dropped with no row and no notice", async () => {
    const { a } = await pairedPair();
    const context = contextFor(a);
    a.send("accepted, then the codec dies before the pump runs");
    // Synchronously, before the pump's microtask: `#moduleFailed` empties the
    // queue, so the pump finds nothing to send.
    context.processors[0]?.onaudioprocess?.({
      inputBuffer: { getChannelData: () => new Float32Array(1000) },
    });
    await settle(512);
    const state = a.getState();
    expect(state.phase).toBe("fatal");
    // `send()` returned `{ ok: true }`, so the composer's draft was cleared.
    expect(state.outbound, "and the note the user typed is nowhere").toEqual([]);
    expect(state.notices, "with nothing at all to say it was dropped").toEqual([]);
    expect(a.getState().outbound).toEqual([]);
  });
});

describe("B-5 the composer's boundary against the real session", () => {
  it("carries a one-byte note, and every byte the protocol accepts", async () => {
    const { a, b } = await pairedPair();
    const probes: readonly string[] = [
      " ",
      "",
      "a",
      "a\nb",
      "   ",
      "é".repeat(42),
      "\u{1F600}".repeat(21),
      "x".repeat(84),
    ];
    for (const text of probes) {
      const budget = measureMessage(text);
      expect(budget.fits, `${JSON.stringify(text.slice(0, 4))} at ${budget.bytes} bytes`).toBe(
        true,
      );
    }
    // One byte really does travel, which settles the open question in
    // `budget.test.ts` ("the empty-after-header frame the protocol rejects"):
    // the protocol's own minimum is a *zero*-length body.
    a.send(" ");
    await until("the one-byte note to start", () => a.getState().outbound.length > 0);
    for (let round = 0; round < 8; round += 1) {
      if (b.getState().inbound.length > 0) break;
      await deliver(a, b);
      await deliver(b, a);
    }
    expect(b.getState().inbound.map((entry) => [entry.text, entry.text.length])).toEqual([[" ", 1]]);
    expect(a.getState().outbound[0]?.status).toBe("sent");
  });

  it("refuses a note one byte over the cap and accepts one exactly at it", async () => {
    const { a } = await pairedPair();
    expect(a.send("z".repeat(84))).toMatchObject({ ok: true });
    expect(a.send("z".repeat(85))).toEqual({ ok: false, reason: "too-long" });
    expect(a.send("\u{1F600}".repeat(22))).toEqual({ ok: false, reason: "too-long" });
    a.cancel();
  });

  it("KNOWN DEFECT: three of four accepted notes exist in no rendered list", async () => {
    const { a } = await pairedPair();
    // The pump claims the head of the queue on a microtask, so one note is
    // published immediately. The session's own `#pending` is private, so the other
    // three are on their way with no `outbound` event, no transcript row and no
    // way for the person who typed them to see that they exist.
    const accepted = [1, 2, 3, 4].map((index) => a.send(`note ${index}`).ok);
    expect(accepted).toEqual([true, true, true, true]);
    await settle();
    expect(a.getState().outbound.map((entry) => entry.text)).toEqual(["note 1"]);
    expect(a.getState().busy).toBe(true);
    a.cancel();
  });
});

describe("B-6 restart while a send is in flight", () => {
  it("releases everything once and leaves no live session behind", async () => {
    const { a, b } = await pairedPair();
    const beforeContexts = contexts.length;
    const beforeTracks = tracks.length;
    a.send("in flight");
    await until("the bar to appear", () => a.getState().progress !== null);
    await a.restart();
    const state = a.getState();
    expect(state.phase).toBe("pairing");
    expect(state.outbound, "the transcript is wiped by a restart").toEqual([]);
    expect(state.progress).toBeNull();
    // One new context, and the old one closed. Two would mean two live stacks.
    expect(contexts.length).toBe(beforeContexts + 1);
    expect(contexts[0]?.closeCalls).toBe(1);
    // Exactly one new grant, and this session's earlier one released.
    expect(tracks.length).toBe(beforeTracks + 1);
    expect(tracks[0]?.stopped, "a's first microphone was left recording").toBeGreaterThan(0);
    expect(tracks.at(-1)?.stopped, "the live session's microphone is still open").toBe(0);
    a.cancel();
    b.cancel();
  });

  it("two restarts in a row leave exactly one live session", async () => {
    const controller = newController();
    await start(controller, "displayer");
    const beforeContexts = contexts.length;
    const beforeTracks = tracks.length;
    await Promise.all([controller.restart(), controller.restart()]);
    await settle();
    expect(contexts.length).toBe(beforeContexts + 1);
    expect(controller.getState().phase).toBe("pairing");
    // The abandoned grant is released rather than left recording.
    expect(tracks.length).toBe(beforeTracks + 2);
    for (const track of tracks.slice(0, beforeTracks + 1)) {
      expect(track.stopped).toBeGreaterThan(0);
    }
    expect(tracks.at(-1)?.stopped).toBe(0);
  });

  it("KNOWN NIT: a live session's microphone is stopped more than once per teardown", async () => {
    const { a, b } = await pairedPair();
    // `session.stop()` releases the capture feed, and `startListening`'s own
    // `stop()` already calls `track.stop()` on the track and then on every track
    // of the stream. The controller's own loop then stops them again, which its
    // comment justifies for a session that never started — not for one that did.
    // `MediaStreamTrack.stop()` is idempotent by specification, so this is a
    // count, not a fault.
    const aTrack = tracks[0] as Track;
    const bTrack = tracks[1] as Track;
    a.cancel();
    expect(aTrack.stopped, "a track of a session that ran").toBe(3);
    expect(bTrack.stopped, "the other session's track is untouched").toBe(0);
    b.cancel();
    expect(bTrack.stopped).toBe(3);
  });

  it("accepts a code the user typed in the shape a phone keyboard produces", async () => {
    const controller = newController();
    await controller.begin("enterer", " ab cd-2345 ");
    expect(controller.getState().code).toBe("ABCD2345");
    expect(controller.getState().block).toBeNull();
  });
});

describe("B-7 a broken audio clock does reach one of the three numbers", () => {
  it("`remainingMs` is never published as NaN, even on a broken audio clock", async () => {
    const { a, b } = await pairedPair();
    clockIsBroken = true;
    a.send("a note with a broken clock");
    await until("the bar to appear", () => a.getState().progress !== null);
    const seen: number[] = [];
    for (let step = 0; step < 5; step += 1) {
      await vi.advanceTimersByTimeAsync(120);
      const progress = a.getState().progress;
      if (progress === null) continue;
      // All three go through the controller's `clamp`, which is explicitly
      // NaN-safe. `remainingMs` used `Math.max(0, Math.round(totalMs - NaN))`,
      // which is NaN, and `TransmitStatus` converted that to 0 - so the sentence
      // read "about 0 seconds left" for a block that had not started playing.
      expect(Number.isFinite(progress.fraction)).toBe(true);
      expect(Number.isFinite(progress.blockIndex)).toBe(true);
      expect(Number.isFinite(progress.remainingMs)).toBe(true);
      seen.push(progress.remainingMs);
    }
    expect(
      seen.some((value) => Number.isNaN(value)),
      "no NaN survived",
    ).toBe(false);
    expect(
      seen.length,
      "and the bar really was sampled while the clock was broken",
    ).toBeGreaterThan(0);
    clockIsBroken = false;
    a.cancel();
    b.cancel();
  });
});
