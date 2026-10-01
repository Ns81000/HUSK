/**
 * Hostile-input deep dive on `SoundChatUiController`, driven against the real
 * session, the real protocol and the real codec.
 *
 * The harness here is copied from `controller.test.ts` on purpose: no jsdom, no
 * happy-dom, no testing-library may be added, so the fakes are the contract.
 * Two deliberate differences from that file:
 *
 * 1. `setInterval` is faked as well as `setTimeout`. The progress ticker is the
 *    one resource in the controller whose lifetime is not obviously tied to
 *    anything, and `vi.getTimerCount()` is the only honest way to ask whether it
 *    survived a path it should not have.
 * 2. `crypto.subtle.deriveBits` can be gated, so a test can put the controller
 *    inside a specific `await` rather than guessing how many microtask turns it
 *    takes to get there. The 600 000-iteration PBKDF2 is otherwise an
 *    unaddressable delay.
 */

import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openSoundChatCodec } from "../codec";
import { TURN_GAP_MS, type SendRefusal } from "../session";
import { SoundChatUiController } from "./controller";
import { drainAsync } from "../drain";

const CODE = "ABCD2345";
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

/** Gates `crypto.subtle.deriveBits` so a test can sit inside a chosen `await`. */
type DeriveGate = { entered: () => boolean; release: () => void; restore: () => void };

function gateDeriveBits(): DeriveGate {
  const real = globalThis.crypto;
  let entered = false;
  let open: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    open = resolve;
  });
  const subtle = new Proxy(real.subtle, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      if (property === "deriveBits") {
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
        // Bound to the real object: a Node `Crypto` method reached through a
        // proxy would fail its internal-slot check and the *code generation*
        // would fail instead of the derivation the gate is waiting for.
        return typeof value === "function" ? value.bind(target) : value;
      },
    }),
  );
  return {
    entered: () => entered,
    release: open,
    restore: () => {},
  };
}

beforeEach(() => {
  roomClock = 10;
  contexts.length = 0;
  tracks.length = 0;
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
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

/** `until`, but with the fake clock moving: session deadlines are `setTimeout`s. */
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

/** Runs one note all the way to `sent`, leaving the channel quiet afterwards. */
async function sendAndConfirm(
  from: SoundChatUiController,
  to: SoundChatUiController,
  text: string,
): Promise<void> {
  from.send(text);
  // "A row exists" is no longer the same thing as "the note started". The session
  // publishes the accepted note as `queued` synchronously inside `send()`, so the
  // row is there before `send()` returns and this wait used to be satisfied
  // before a single frame had been sealed -- which is the whole shape of the
  // defect this helper was written around. Wait for the status that means audio
  // is on the air.
  await until("the note to start", () =>
    from.getState().outbound.some((entry) => entry.status === "sending"),
  );
  for (let round = 0; round < 12; round += 1) {
    if (from.getState().outbound.every((entry) => entry.status !== "sending")) break;
    await deliver(from, to);
    await deliver(to, from);
  }
}

describe("F-A a superseded start-up leaks the microphone it was granted", () => {
  it("releases the stream of a begin() that lost its generation race", async () => {
    const controller = newController();
    // Two overlapping starts: the UI's own retry paths reach this, and nothing
    // serialises them (the pairing panel is handed `busy={false}` unconditionally).
    const first = controller.begin("displayer");
    const second = controller.begin("displayer");
    await Promise.all([first, second]);

    // Two grants were handed out, so two tracks exist.
    expect(tracks).toHaveLength(2);
    // The second one is the live session's, and it is still running.
    expect(contexts).toHaveLength(1);
    expect(tracks[1]?.stopped).toBe(0);
    // The abandoned grant must not survive: nothing else holds a reference to
    // it, so nothing else can ever stop it and the recording indicator stays on.
    expect(tracks[0]?.stopped).toBeGreaterThan(0);
  });

  it("releases the grant when a cancel lands during the microphone await", async () => {
    const controller = newController();
    const pending = controller.begin("displayer");
    controller.cancel();
    await pending;
    expect(tracks).toHaveLength(1);
    expect(tracks[0]?.stopped).toBeGreaterThan(0);
  });

  it("releases the grant when a dispose lands during the microphone await", async () => {
    const controller = newController();
    const pending = controller.begin("displayer");
    controller.dispose();
    await pending;
    expect(tracks).toHaveLength(1);
    expect(tracks[0]?.stopped).toBeGreaterThan(0);
  });
});

describe("F-B dispose() inside the key derivation strands the whole stack", () => {
  it("closes the context, the codec and the microphone of a disposed begin()", async () => {
    const controller = newController();
    const gate = gateDeriveBits();
    try {
      // Gated on `deriveBits`, which `SoundChatSession.create` reaches only after
      // `begin()` has already parked the context, the codec and the stream on
      // itself — the exact window the staleness check after `create` misses.
      const pending = controller.begin("displayer");
      await until("the key derivation to start", () => gate.entered());
      controller.dispose();
      gate.release();
      await pending;
      await settle();
    } finally {
      gate.restore();
    }

    expect(contexts).toHaveLength(1);
    expect(tracks).toHaveLength(1);
    // A disposed controller never tears down again, so anything it is still
    // holding at the moment of `dispose()` is held for the life of the page.
    expect(contexts[0]?.closeCalls, "the AudioContext was left open").toBe(1);
    expect(tracks[0]?.stopped, "the microphone was left recording").toBeGreaterThan(0);
  });

  it("cancel() inside the same window does release everything", async () => {
    const controller = newController();
    const gate = gateDeriveBits();
    try {
      const pending = controller.begin("displayer");
      await until("the key derivation to start", () => gate.entered());
      controller.cancel();
      gate.release();
      await pending;
      await settle();
    } finally {
      gate.restore();
    }
    // The control that shows the difference is the *ordering* in `begin()`:
    // `cancel()` re-runs the teardown, `dispose()` does not.
    expect(contexts[0]?.closeCalls).toBe(1);
    expect(tracks[0]?.stopped).toBeGreaterThan(0);
  });

  it("restart() inside the same window does release everything", async () => {
    const controller = newController();
    await start(controller, "displayer");
    const gate = gateDeriveBits();
    try {
      const pending = controller.restart();
      await until("the key derivation to start", () => gate.entered());
      gate.release();
      await pending;
      await settle();
    } finally {
      gate.restore();
    }
    expect(tracks[0]?.stopped).toBeGreaterThan(0);
  });
});

describe("F-C a context that will not resume is never closed", () => {
  it("closes the AudioContext when ensureRunning() rejects", async () => {
    class SuspendedContext extends FakeAudioContext {
      override state = "suspended";
      override async resume(): Promise<unknown> {
        throw new DOMException("The AudioContext was not allowed to start.", "NotAllowedError");
      }
    }
    vi.stubGlobal("AudioContext", SuspendedContext);
    const controller = newController();
    await start(controller, "displayer");

    expect(controller.getState().phase).toBe("blocked");
    expect(controller.getState().block?.kind).toBe("audio-unavailable");
    // The microphone is released, so the release path *does* run; the context it
    // created on the way in is simply not on that path.
    expect(tracks[0]?.stopped).toBeGreaterThan(0);
    expect(contexts[0]?.closeCalls, "the AudioContext was left running").toBe(1);
  });
});

describe("F-D one throwing subscriber starves every other subscriber", () => {
  // The controller reports a subscriber's bug on `console.error`, which is the
  // convention the audio and session layers already use. Muted here so a passing
  // run does not print three stacks of an error it deliberately caused.
  let muted: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    muted = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    muted.mockRestore();
  });

  it("delivers a patch to the subscribers after a throwing one", () => {
    const controller = newController();
    let healthy = 0;
    controller.subscribe(() => {
      throw new Error("a subscriber bug");
    });
    controller.subscribe(() => {
      healthy += 1;
    });
    const before = healthy;
    // `cancel()` is a public, non-async call: a subscriber's exception must not
    // escape out of it into React's event handler.
    expect(() => {
      controller.cancel();
    }).not.toThrow();
    expect(healthy).toBeGreaterThan(before);
  });

  it("does not reject begin() when a subscriber throws", async () => {
    const controller = newController();
    controller.subscribe(() => {
      throw new Error("a subscriber bug");
    });
    // The hook calls `void controller.begin(...)`; a rejection here is an
    // unhandled promise rejection with no handler anywhere.
    await expect(controller.begin("displayer")).resolves.toBeUndefined();
    // And it was still reported rather than swallowed.
    expect(muted).toHaveBeenCalled();
  });

  it("does not let a throwing subscriber kill the ticker or the session", async () => {
    const controller = newController();
    controller.subscribe(() => {
      throw new Error("a subscriber bug");
    });
    let healthy = 0;
    controller.subscribe(() => {
      healthy += 1;
    });
    await start(controller, "displayer");
    const seen = healthy;
    controller.send("a note that is refused");
    // The session survives: it catches and reports the consumer, so the only
    // thing the controller could lose is the fan-out.
    expect(controller.getState().phase).toBe("pairing");
    expect(controller.getState().busy).toBe(false);
    expect(seen).toBeGreaterThan(0);
  });
});

describe("F-E the progress ticker is a resource like any other", () => {
  it("runs no ticker while nothing of ours is on the air", async () => {
    const controller = newController();
    expect(vi.getTimerCount()).toBe(0);
    await start(controller, "displayer");
    // A pairing session owns session timers and no ticker: the bar exists only
    // for a transmission of ours.
    const idle = vi.getTimerCount();
    expect(controller.send("nope")).toEqual({ ok: false, reason: "not-paired" });
    expect(controller.getState().busy).toBe(false);
    expect(vi.getTimerCount()).toBe(idle);
  });

  it("leaves no ticker behind after cancel() during a transmission", async () => {
    const { a } = await pairedPair();
    const before = vi.getTimerCount();
    a.send("will not be confirmed");
    await until("the bar to appear", () => a.getState().progress !== null);
    expect(vi.getTimerCount(), "the bar allocated no timer at all").toBeGreaterThan(before);
    a.cancel();
    expect(vi.getTimerCount()).toBeLessThanOrEqual(before);
    expect(a.getState().progress).toBeNull();
  });

  it("leaves no ticker behind after dispose() during a transmission", async () => {
    const { a } = await pairedPair();
    a.send("will not be confirmed");
    await until("the bar to appear", () => a.getState().progress !== null);
    a.dispose();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not stack a second ticker when the bar restarts", async () => {
    const { a, b } = await pairedPair();
    a.send("one");
    await until("the bar to appear", () => a.getState().progress !== null);
    const withTicker = vi.getTimerCount();
    // Bounded: the ACK window for a one-block message is 5 540 ms, then the
    // machine leaves `awaiting_ack` and the bar must be gone.
    await untilTimed("the bar to end", () => a.getState().progress === null);
    await deliver(a, b);
    await deliver(b, a);
    a.send("two");
    await until("the second bar to appear", () => a.getState().progress !== null);
    // One interval, not two: `#startProgress` is reached from three places for
    // one transmission and only the first may allocate a timer.
    expect(vi.getTimerCount()).toBeLessThanOrEqual(withTicker);
  });
});

describe("F-F the bar is sized from the message actually on the air", () => {
  it("reports one block for a short note that followed a two-block note", async () => {
    const { a, b } = await pairedPair();
    await sendAndConfirm(a, b, "x".repeat(84));
    expect(a.getState().outbound[0]?.blocks).toBe(2);
    await until("the first bar to clear", () => a.getState().progress === null);

    a.send("short");
    await until("the second bar to appear", () => a.getState().progress !== null);
    // `#pendingBlocks` is the only honest source, and it is reset when the bar
    // stops. If it were not, the second note would inherit the first one's total
    // and the bar would be twice as long as the sound.
    expect(a.getState().progress?.blocks).toBe(1);
    expect(a.getState().progress?.remainingMs).toBe(1_920);
  });

  it("keeps the bar inside the two-block ceiling while awaiting an ack", async () => {
    const { a, b } = await pairedPair();
    a.send("y".repeat(84));
    await until("the bar to appear", () => a.getState().progress !== null);
    const total = 2 * 1_920;
    // `awaiting_ack` runs for up to ACK_TIMEOUT_MS (5 540 ms for a two-block
    // message), and the speaker has finished long before that. Walk the whole
    // window and record what the bar claims.
    const claims: string[] = [];
    for (let step = 0; step < 30; step += 1) {
      advanceRoom(0.25);
      await vi.advanceTimersByTimeAsync(250);
      const progress = a.getState().progress;
      if (progress === null) break;
      claims.push(`${progress.blockIndex}/${progress.blocks} ${String(progress.remainingMs)}`);
      expect(progress.remainingMs).toBeLessThanOrEqual(total);
      expect(progress.fraction).toBeLessThanOrEqual(1);
    }
    // The speaker's own audio is 3.84 s, so the bar must be finished by then.
    // Anything after that is a stalled bar, not a progress bar.
    const finished = claims.findIndex((claim) => claim.endsWith(" 0"));
    expect(finished, `the bar never finished: ${claims.join(" | ")}`).toBeLessThan(16);
  });
});

describe("F-G what a fatal error leaves behind", () => {
  it("releases the microphone when the codec dies mid-session", async () => {
    const controller = newController();
    const context = await start(controller, "displayer");
    context?.processors[0]?.onaudioprocess?.({
      inputBuffer: { getChannelData: () => new Float32Array(1000) },
    });
    await settle();
    expect(controller.getState().phase).toBe("fatal");
    // The session releases its own feed on a module failure, so the browser's
    // recording indicator does not stay on behind a terminal screen.
    expect(tracks[0]?.stopped).toBeGreaterThan(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps the enterer's own code across a restart", async () => {
    const controller = newController();
    await start(controller, "enterer", CODE);
    expect(controller.getState().code).toBe(CODE);
    await controller.restart();
    expect(controller.getState().code).toBe(CODE);
    expect(controller.getState().phase).toBe("pairing");
  });

  it("does not reuse a code the protocol already refused", async () => {
    const controller = newController();
    await controller.begin("enterer", "TOO-SHORT");
    expect(controller.getState().block?.kind).toBe("bad-code");
    // FIXED. `#code` was set before the attempt and cleared only in the state, so
    // a restart from here retried the code the protocol had just named invalid and
    // produced the same refusal with nothing new to say. It is now dropped, so a
    // restart falls back to a generated code instead of failing identically.
    await controller.restart();
    expect(controller.getState().block).toBeNull();
    expect(controller.getState().phase).toBe("pairing");
    expect(controller.getState().code).not.toBe("TOO-SHORT");
  });
});

describe("F-H refusals and the queue edge", () => {
  it("gives queue-full for the fifth and sixth note, and accepts four", async () => {
    const { a, b } = await pairedPair();
    const seen: SendRefusal[] = [];
    let accepted = 0;
    for (let index = 0; index < 6; index += 1) {
      const result = a.send(`note ${index}`);
      if (result.ok) accepted += 1;
      else seen.push(result.reason);
    }
    // The controller checks the body first, so the queue verdict is the
    // session's — and `queue-full` is one of the six refusals whose copy the UI
    // never shows the user.
    expect(accepted).toBe(4);
    expect(seen).toEqual(["queue-full", "queue-full"]);
  });

  it("refuses a stop after cancel, and after dispose, with the reason that is actionable", async () => {
    const controller = newController();
    await start(controller, "displayer");
    controller.cancel();
    expect(controller.send("hi")).toEqual({ ok: false, reason: "not-paired" });
    controller.dispose();
    expect(controller.send("hi")).toEqual({ ok: false, reason: "stopped" });
  });

  it("carries a note of 84 bytes and refuses 85, from the same measurement", async () => {
    const { a } = await pairedPair();
    expect(a.send("z".repeat(84))).toMatchObject({ ok: true });
    expect(a.send("z".repeat(85))).toEqual({ ok: false, reason: "too-long" });
  });
});

describe("F-I two controllers in one room do not see each other's state", () => {
  it("keeps the transcripts, codes and stats separate", async () => {
    const { a, b } = await pairedPair();
    a.send("only from a");
    await until("a's note to start", () => a.getState().outbound.length > 0);
    for (let round = 0; round < 8; round += 1) {
      if (b.getState().inbound.length > 0) break;
      await deliver(a, b);
      await deliver(b, a);
    }
    expect(b.getState().inbound[0]?.text).toBe("only from a");
    expect(a.getState().inbound).toEqual([]);
    expect(a.getState().outbound[0]?.text).toBe("only from a");
    expect(b.getState().outbound).toEqual([]);
    // Both hold the same pairing code, which is the point, and their stats are
    // their own: one sent, the other received.
    expect(a.getState().code).toBe(b.getState().code);
    expect(a.getState().stats.blocksDecoded).toBeGreaterThan(0);
    expect(a.getState().stats.messagesDelivered).toBe(0);
    expect(b.getState().stats.messagesDelivered).toBe(1);
  });
});
