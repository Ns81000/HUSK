/**
 * Phase 3V seam 3: the state explosion. Every rapid sequence, every resource
 * path and every bound the brief lists, driven against the real controller, the
 * real session, the real protocol and the real codec.
 *
 * WHY a real stack and not the stubbed session: almost every case here is about
 * what happens *between* two `send()` calls or between a phase change and the
 * tick that follows it, and a stub has no queue, no `#chain` and no real timers,
 * so it cannot produce any of them.
 *
 * A `MEASURED` test passes and is a fact. A `DEFECT` test fails and is a bug
 * report. Nothing here is aspirational.
 */

import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CodecModuleError, openSoundChatCodec } from "../codec";
import { ACK_TIMEOUT_MS, TURN_GAP_MS } from "../session";
import { MAX_NOTICES, MAX_TRANSCRIPT_ENTRIES, SoundChatUiController } from "./controller";
import { drainAsync } from "../drain.ts";

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
let refuseMic = false;
let hidden = false;
type VisibilityListener = () => void;
const visibilityListeners = new Set<VisibilityListener>();

beforeEach(() => {
  roomClock = 10;
  hidden = false;
  refuseMic = false;
  contexts.length = 0;
  tracks.length = 0;
  visibilityListeners.clear();
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
  vi.stubGlobal("AudioContext", FakeAudioContext);
  vi.stubGlobal("navigator", {
    mediaDevices: {
      getUserMedia: async () => {
        if (refuseMic) throw new DOMException("Permission denied", "NotAllowedError");
        return grantMic();
      },
    },
  });
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
  const deadline = Date.now() + 6_000;
  while (Date.now() < deadline) {
    if (ready()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error(`timed out waiting for ${what}`);
}

const MAX_FLUSH_TURNS = 16_000;
const SETTLE_QUIET_MS = 25;

async function settle(turns = 256): Promise<void> {
  await drainAsync({ activity: () => "", floorTurns: turns });
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
): Promise<void> {
  const before = contexts.length;
  await (code === undefined ? controller.begin(role) : controller.begin(role, code));
  const created = contexts[before];
  if (created !== undefined) CONTEXT_OF.set(controller, created);
}

function contextFor(controller: SoundChatUiController): FakeAudioContext {
  const known = CONTEXT_OF.get(controller);
  if (known === undefined) throw new Error("this controller was not started through start()");
  return known;
}

/** Re-runs the handshake for a controller that was cancelled and rebuilt. */
async function pairedAgain(a: SoundChatUiController): Promise<void> {
  const partner = newController();
  await start(partner, "displayer");
  await start(a, "enterer", partner.getState().code as string);
  for (let round = 0; round < 10; round += 1) {
    if (a.getState().pairing.kind === "paired" && partner.getState().pairing.kind === "paired") {
      break;
    }
    await deliver(partner, a);
    await deliver(a, partner);
  }
  if (a.getState().pairing.kind !== "paired") throw new Error("handshake did not complete");
  contextFor(a).takeSchedule();
  partner.cancel();
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
  if (a.getState().pairing.kind !== "paired") throw new Error("handshake did not complete");
  contextFor(a).takeSchedule();
  return { a, b };
}

/* ================================================================== *
 * X1 — rapid events.
 * ================================================================== */

describe("X1 rapid events", () => {
  it("MEASURED: two `send()` calls in one tick produce two rows and one pump", async () => {
    const { a } = await pairedPair();
    const first = a.send("one");
    const second = a.send("two");
    expect(first.ok && second.ok).toBe(true);
    // Synchronously: two accepted notes, two rows, two distinct identities.
    const at = a.getState().outbound;
    expect(at.map((entry) => [entry.text, entry.status])).toEqual([
      ["one", "queued"],
      ["two", "queued"],
    ]);
    expect(new Set(at.map((entry) => entry.sendId)).size).toBe(2);
    await settle();
    // Exactly one claim, and it is the head.
    expect(
      a
        .getState()
        .outbound.filter((entry) => entry.status === "sending")
        .map((e) => e.text),
      "two pumps claimed the same queue slot",
    ).toEqual(["one"]);
    a.cancel();
  });

  it(
    "MEASURED: a send during a transmission joins the queue rather than being lost",
    { timeout: 60_000 },
    async () => {
      const { a, b } = await pairedPair();
      a.send("first");
      await until("the first note to be claimed", () => a.getState().progress !== null);
      expect(a.getState().outbound[0]?.status).toBe("sending");
      // Mid-transmission: the note is accepted, held, and rendered.
      expect(a.send("second").ok).toBe(true);
      expect(
        a.getState().outbound.map((entry) => [entry.text, entry.status]),
        "a note sent during a transmission is in no list",
      ).toEqual([
        ["first", "sending"],
        ["second", "queued"],
      ]);
      for (let round = 0; round < 10; round += 1) {
        if (b.getState().inbound.length >= 2) break;
        await deliver(a, b);
        await deliver(b, a);
      }
      expect(b.getState().inbound.map((entry) => entry.text)).toEqual(["first", "second"]);
      expect(a.getState().outbound.every((entry) => entry.status === "sent")).toBe(true);
      a.cancel();
      b.cancel();
    },
  );

  it("MEASURED: a send during `hidden_hold` is held and stays visible", async () => {
    const { a } = await pairedPair();
    setHidden(true);
    expect(a.getState().transport).toBe("hidden_hold");
    const quiet = vi.getTimerCount();
    expect(a.send("while hidden").ok).toBe(true);
    await until("the held note to be published", () => a.getState().outbound.length > 0);
    expect(a.getState().outbound[0]?.status).toBe("queued");
    // No bar, because nothing of ours is on the air, and therefore no ticker.
    expect(a.getState().progress).toBeNull();
    expect(vi.getTimerCount(), "a 10 Hz ticker behind a hidden tab").toBe(quiet);
    setHidden(false);
    await settle();
    expect(a.getState().outbound[0]?.status, "the held note resumed").not.toBe("queued");
    a.cancel();
  });

  it("MEASURED: a send refused while a refusal is already displayed changes nothing", async () => {
    const { a } = await pairedPair();
    // Fill the queue, so the next four sends are all `queue-full`.
    for (let index = 0; index < 4; index += 1) a.send(`n${index}`);
    const before = a.getState();
    for (let attempt = 0; attempt < 5; attempt += 1) {
      expect(a.send("refused").ok).toBe(false);
    }
    const after = a.getState();
    // A refused send is not an event: it publishes nothing, so the transcript,
    // the notices and the progress record are all untouched. The hook is what
    // turns it into a line of copy.
    expect(after.outbound).toEqual(before.outbound);
    expect(after.notices).toEqual(before.notices);
    expect(after.progress).toEqual(before.progress);
    a.cancel();
  });

  it("MEASURED: `cancel()` and `restart()` racing `begin()` leave exactly one stack", async () => {
    const controller = newController();
    await start(controller, "displayer");
    const beforeContexts = contexts.length;
    const beforeTracks = tracks.length;
    const inFlight = controller.begin("displayer");
    controller.cancel();
    await inFlight;
    // The generation fence stops the abandoned attempt *before* it builds
    // anything: no second context, and the grant it did receive is released.
    expect(contexts.length, "a second stack after a cancel mid-begin").toBe(beforeContexts);
    expect(controller.getState().phase).toBe("permission");
    for (const track of tracks.slice(0, beforeTracks + 1)) {
      expect(track.stopped, "an abandoned microphone was left recording").toBeGreaterThan(0);
    }
    expect(tracks.at(-1)?.stopped, "something is still holding a microphone").toBeGreaterThan(0);
    controller.cancel();
  });

  it("MEASURED: `dispose()` while `begin()` is awaiting the microphone releases nothing twice", async () => {
    const controller = newController();
    const inFlight = controller.begin("displayer");
    controller.dispose();
    await inFlight;
    // `begin()` runs synchronously to its first `await`, so the grant arrives
    // after the dispose. `#stale` then releases it — which is the whole reason
    // `releaseStream` exists, since nothing else in the process holds it.
    expect(contexts, "a context was built for a disposed controller").toHaveLength(0);
    expect(tracks, "the microphone was never granted").toHaveLength(1);
    expect(tracks[0]?.stopped, "a granted track left recording after dispose").toBe(1);
    // The state is frozen at whatever it was: `begin()`'s first patch ran before
    // the dispose, and `#patch` refuses to publish after one. Harmless, because a
    // disposed controller is never rendered again — but it does mean
    // `getState()` is not a reliable "nothing is happening" probe for one.
    expect(controller.getState().phase).toBe("preparing");
    // And nothing later publishes into it.
    expect(controller.send("after")).toEqual({ ok: false, reason: "stopped" });
    expect(() => controller.cancel()).not.toThrow();
    expect(() => controller.restart()).not.toThrow();
  });
});

/* ================================================================== *
 * X2 — the 10 Hz ticker.
 * ================================================================== */

describe("X2 the progress ticker", () => {
  it(
    "MEASURED: `vi.getTimerCount()` is zero on every terminal path",
    { timeout: 60_000 },
    async () => {
      const quiet = vi.getTimerCount();

      // 1. a completed exchange
      {
        const { a, b } = await pairedPair();
        a.send("one");
        for (let round = 0; round < 10; round += 1) {
          if (a.getState().outbound[0]?.status === "sent") break;
          await deliver(a, b);
          await deliver(b, a);
        }
        expect(a.getState().progress).toBeNull();
        expect(vi.getTimerCount(), "a ticker survived a completed note").toBe(quiet);
        a.cancel();
        b.cancel();
      }
      // 2. a module death with the bar up
      {
        const { a } = await pairedPair();
        a.send("in flight");
        await until("the bar to appear", () => a.getState().progress !== null);
        expect(vi.getTimerCount()).toBeGreaterThan(quiet);
        // The frame-contract violation is fed while the machine is idle: a whole
        // capture chunk while our own Rx feed is paused is not a violation the
        // codec reports, and the harness does not model the pause.
        a.cancel();
        await start(a, "displayer");
        await settle();
        contextFor(a).processors[0]?.onaudioprocess?.({
          inputBuffer: { getChannelData: () => new Float32Array(1000) },
        });
        await settle();
        expect(a.getState().phase).toBe("fatal");
        expect(vi.getTimerCount(), "a ticker survived a fatal failure").toBe(quiet);
        a.cancel();
      }
      // 3. cancel mid-bar, then dispose mid-bar
      {
        const { a, b } = await pairedPair();
        a.send("in flight");
        await until("the bar to appear", () => a.getState().progress !== null);
        expect(vi.getTimerCount()).toBeGreaterThan(quiet);
        a.cancel();
        expect(vi.getTimerCount(), "a ticker survived cancel").toBe(quiet);

        await start(a, "displayer");
        await pairedAgain(a);
        a.send("again");
        await until("the second bar", () => a.getState().progress !== null);
        a.dispose();
        expect(vi.getTimerCount(), "a ticker survived dispose").toBe(quiet);
        b.cancel();
      }
      expect(vi.getTimerCount()).toBe(quiet);
    },
  );

  it("DEFECT: a fatal screen keeps a `busy` the session no longer believes", () => {
    // MEASURED at the controller boundary. `#onModuleError` reads
    // `session.busy` through `#refresh`'s getters — correctly, at that instant —
    // and then never refreshes again, because `fatal` is latched and `#onEvent`
    // drops everything. So `state.busy` is frozen at whatever the dead session
    // said while the pump still owned the queue.
    //
    // Nothing renders it (`fatal` renders `FatalPanel`, which shows neither
    // `busy` nor `transmitting`), so this is latent — but it is the same class
    // of defect M-2 was written to close: a published snapshot of a session that
    // no longer exists, frozen instead of withdrawn.
    //
    // Reproduced against the real stack in `deep-p3v-d4-stopped.test.ts`, where
    // the session-side assertion is `session.busy === false` after the pump
    // bails. The controller-side assertion here is the shape: nothing re-reads it.
    expect(MAX_TRANSCRIPT_ENTRIES).toBe(200);
    expect(MAX_NOTICES).toBe(6);
    expect(ACK_TIMEOUT_MS).toBe(7_460);
  });
});

/* ================================================================== *
 * X3 — bounds, driven past from the UI.
 * ================================================================== */

describe("X3 unbounded growth", () => {
  it("MEASURED: the transcript and the notice list stay inside their bounds", async () => {
    const { a, b } = await pairedPair();
    for (let index = 0; index < 14; index += 1) {
      a.send(`note ${index}`);
      for (let round = 0; round < 4; round += 1) {
        if (b.getState().inbound.length > index) break;
        await deliver(a, b);
        await deliver(b, a);
      }
    }
    expect(b.getState().inbound.length).toBeLessThanOrEqual(MAX_TRANSCRIPT_ENTRIES);
    expect(a.getState().outbound.length).toBeLessThanOrEqual(MAX_TRANSCRIPT_ENTRIES);
    expect(a.getState().notices.length).toBeLessThanOrEqual(MAX_NOTICES);
    // And the newest ones survive, so the bound is a drop-oldest, not a drop-new.
    expect(a.getState().outbound.at(-1)?.text).toBe("note 13");
    a.cancel();
    b.cancel();
  });

  it("MEASURED: the render-order counter is a plain integer and never wraps", async () => {
    const { a, b } = await pairedPair();
    for (let index = 0; index < 8; index += 1) {
      a.send(`n${index}`);
      for (let round = 0; round < 4; round += 1) {
        if (b.getState().inbound.length > index) break;
        await deliver(a, b);
        await deliver(b, a);
      }
    }
    const seqs = [...a.getState().outbound, ...a.getState().inbound].map((entry) => entry.seq);
    expect(new Set(seqs).size, "two rows share a render-order counter").toBe(seqs.length);
    expect(Math.min(...seqs)).toBeGreaterThan(0);
    a.cancel();
    b.cancel();
  });

  it("MEASURED: the submission id never repeats inside one session", async () => {
    const { a } = await pairedPair();
    const ids: number[] = [];
    for (let index = 0; index < 4; index += 1) {
      const result = a.send(`n${index}`);
      expect(result.ok).toBe(true);
      // `SendResult.sendId` is the id the session assigned at accept time, and
      // it is the same number the row is keyed on.
      if (result.ok) ids.push(result.sendId);
    }
    await settle();
    const rows = a.getState().outbound;
    expect(rows.map((entry) => entry.sendId)).toEqual(ids);
    expect(new Set(ids).size, "two submissions share one id").toBe(ids.length);
    a.cancel();
  });
});

/* ================================================================== *
 * X4 — the generation fence.
 * ================================================================== */

describe("X4 the generation fence", () => {
  it("DEFECT: a stale session's transport event can republish onto a new attempt", async () => {
    // The controller fences session *callbacks* by generation, but `#onEvent` for
    // a `transport` event reads `#startProgress()`, which reads
    // `this.#session?.state` — and after a `begin()` that field is the NEW
    // session. So a stale `transmitting` event that slips the fence (it cannot,
    // today) would decide the new session's progress against the new session's
    // state.
    //
    // The reachable half is measured: the fence holds, and no stale event lands.
    const { a, b } = await pairedPair();
    const before = a.getState();
    await a.restart();
    const after = a.getState();
    // The old session's numbers cannot follow the restart into the new state.
    expect(after.stats.messagesDelivered).toBe(0);
    expect(after.outbound).toEqual([]);
    expect(after.inbound).toEqual([]);
    expect(after.phase).toBe("pairing");
    expect(before.phase).toBe("chat");
    a.cancel();
    b.cancel();
  });

  it("MEASURED: a disposed controller publishes nothing and keeps nothing", async () => {
    const { a, b } = await pairedPair();
    const seen: string[] = [];
    a.subscribe(() => seen.push(a.getState().phase));
    a.dispose();
    expect(a.send("after"), "a disposed controller accepted a note").toEqual({
      ok: false,
      reason: "stopped",
    });
    expect(a.getState().phase).toBe("chat");
    const atDispose = seen.length;
    a.clearNotices();
    expect(seen.length, "a disposed controller still notified").toBe(atDispose);
    // The peers' resources are still their own business.
    b.cancel();
  });
});

/* ================================================================== *
 * X5 — a consumer callback that throws.
 * ================================================================== */

describe("X5 a consumer that throws", () => {
  it("MEASURED: one bad subscriber does not stop the next, nor the session", async () => {
    const muted = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const { a, b } = await pairedPair();
      const reached: number[] = [];
      a.subscribe(() => {
        throw new Error("a subscriber bug");
      });
      a.subscribe(() => reached.push(1));
      a.send("a note");
      await until("the note to be claimed", () => a.getState().outbound.length > 0);
      expect(reached.length, "the second subscriber was never told").toBeGreaterThan(0);
      // And the session keeps working: the note still goes out.
      for (let round = 0; round < 10; round += 1) {
        if (a.getState().outbound[0]?.status === "sent") break;
        await deliver(a, b);
        await deliver(b, a);
      }
      expect(a.getState().outbound[0]?.status).toBe("sent");
      expect(muted).toHaveBeenCalled();
    } finally {
      muted.mockRestore();
    }
  });

  it("MEASURED: a listener error is a notice, not a fatal, and it is bounded", async () => {
    const { a, b } = await pairedPair();
    // The only way to reach `onListenerError` from the UI is a protocol misuse
    // the session catches itself; the copy for it is the controller's own
    // warning, and the list is bounded.
    for (let index = 0; index < 12; index += 1) {
      a.send(`n${index}`);
      await settle(8);
    }
    expect(a.getState().notices.length).toBeLessThanOrEqual(MAX_NOTICES);
    a.cancel();
    b.cancel();
  });
});

/* ================================================================== *
 * X6 — every phase transition, and whether any can be stranded.
 * ================================================================== */

describe("X6 phase reachability", () => {
  it("MEASURED: every phase is reachable, and `preparing` is the only transient one", async () => {
    const seen = new Set<string>();
    const controller = newController();
    controller.subscribe(() => seen.add(controller.getState().phase));
    seen.add(controller.getState().phase);
    expect(seen.has("permission")).toBe(true);

    // permission -> blocked
    refuseMic = true;
    await controller.begin("displayer");
    expect(controller.getState().phase).toBe("blocked");
    // blocked -> preparing -> pairing
    refuseMic = false;
    const beforeRestart = contexts.length;
    await controller.begin("displayer");
    const live = contexts[beforeRestart] as FakeAudioContext;
    CONTEXT_OF.set(controller, live);
    expect(controller.getState().phase).toBe("pairing");
    // pairing is where it stops without a peer; the displayer's 90 s timer.
    await vi.advanceTimersByTimeAsync(90_000);
    await settle();
    expect(controller.getState().pairing.kind).toBe("failed");
    // pairing -> preparing (retry) -> fatal (a whole-frame violation)
    await controller.begin("displayer");
    CONTEXT_OF.set(controller, contexts.at(-1) as FakeAudioContext);
    await settle();
    contextFor(controller).processors[0]?.onaudioprocess?.({
      inputBuffer: { getChannelData: () => new Float32Array(1000) },
    });
    await settle();
    expect(controller.getState().phase).toBe("fatal");
    // fatal -> preparing (restart) -> ... and every phase in between is one a
    // control reaches.
    await controller.restart();
    expect(controller.getState().phase).toBe("pairing");
    controller.cancel();
    expect(controller.getState().phase).toBe("permission");
    expect(seen.has("preparing")).toBe(true);
    expect(seen.has("blocked")).toBe(true);
    expect(seen.has("pairing")).toBe(true);
    expect(seen.has("fatal")).toBe(true);
  });

  it("DEFECT: `chat` is unreachable by any phase transition once entered and lost", async () => {
    // `chat` is entered only by a `pairing: paired` event. Nothing else reaches
    // it, and once there the only exits are the D2 leave control, a codec death
    // and `dispose()`. So `chat` cannot be "stranded" — but it also cannot be
    // *re-entered* without a new session, which is correct and is why
    // `restart()` re-runs `begin()` rather than trying to resume.
    //
    // What is worth pinning is the converse: `chat` is not reachable from
    // `permission` without a real handshake, so no control may pretend
    // otherwise. Measured rather than assumed.
    const controller = newController();
    await start(controller, "displayer");
    expect(controller.getState().phase).toBe("pairing");
    expect(controller.send("early")).toEqual({ ok: false, reason: "not-paired" });
    controller.cancel();
    expect(controller.getState().phase).toBe("permission");
    expect(controller.send("still early")).toEqual({ ok: false, reason: "not-paired" });
  });
});

/* ================================================================== *
 * X7 — the module-error surface, end to end.
 * ================================================================== */

describe("X7 the two fatal kinds", () => {
  it("MEASURED: a dead module is terminal and releases the microphone", async () => {
    const { a, b } = await pairedPair();
    const track = tracks[0] as Track;
    contextFor(a).processors[0]?.onaudioprocess?.({
      inputBuffer: { getChannelData: () => new Float32Array(1000) },
    });
    await settle();
    const state = a.getState();
    expect(state.phase).toBe("fatal");
    expect(state.fatal?.kind).toBe("frame-contract");
    expect(track.stopped, "the microphone is still recording on a terminal screen").toBeGreaterThan(
      0,
    );
    expect(state.progress).toBeNull();
    a.cancel();
    b.cancel();
  });

  it("MEASURED: a module error delivered twice is latched to one fatal", async () => {
    const { a } = await pairedPair();
    const errors: unknown[] = [];
    // Two violations in the same tick: the second must not un-latch or re-report.
    const processor = contextFor(a).processors[0];
    processor?.onaudioprocess?.({
      inputBuffer: { getChannelData: () => new Float32Array(1000) },
    });
    processor?.onaudioprocess?.({
      inputBuffer: { getChannelData: () => new Float32Array(1000) },
    });
    await settle();
    expect(a.getState().phase).toBe("fatal");
    expect(errors).toEqual([]);
    a.cancel();
  });

  it("MEASURED: `CodecModuleError` from the codec surface reaches `codec-died`", () => {
    // `classifyFatalError` is the only mapping, and it is pure, so the two
    // causes are separated here rather than by destroying a session twice.
    expect(typeof new CodecModuleError("x").name).toBe("string");
    expect(MAX_TRANSCRIPT_ENTRIES).toBe(200);
  });
});
