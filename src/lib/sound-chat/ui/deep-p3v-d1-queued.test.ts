/**
 * Phase 3V residual D1 — "rapidly-accepted notes exist in no rendered list".
 *
 * WHY a real session and a real codec here: the defect is a *timing* fact about
 * `session.send()` and the pump's deferred claim, so a stubbed session (the seam
 * `deep-p3b-machine.test.ts` uses) cannot produce it at all — the stub never has
 * a `#pending` queue. This file drives the real `SoundChatUiController`, the real
 * `SoundChatSession`, the real protocol and the real ggwave codec, and simulates
 * the acoustic path exactly as `controller.test.ts` does.
 *
 * Every test is named for what it *measures*. A `MEASURED` test passes today and
 * is a fact about the shipped behaviour. A `PIN` test fails today and pins the
 * fixed behaviour; do not invert it.
 */

import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openSoundChatCodec } from "../codec";
import { TURN_GAP_MS } from "../session";
import { MAX_TRANSCRIPT_ENTRIES, SoundChatUiController } from "./controller";
import { drainAsync } from "../drain";

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
  if (a.getState().pairing.kind !== "paired") throw new Error("handshake did not complete");
  return { a, b };
}

/* ================================================================== *
 * D1.1 — MEASUREMENT. What the screen can actually show after three
 * accepted sends in one tick.
 * ================================================================== */

describe("D1.1 REPRODUCTION (was): three accepted notes, no rendered rows", () => {
  it("MEASURED: the screen is now NOT identical to an idle chat at accept", async () => {
    const { a } = await pairedPair();
    contextFor(a).takeSchedule();
    const idle = a.getState();

    // Three sends in one tick. Each returns synchronously, so the composer's
    // draft is cleared three times and the person believes three notes are in
    // the system.
    const accepted = ["one", "two", "three"].map((text) => a.send(text).ok);
    expect(accepted, "the session accepted all three").toEqual([true, true, true]);

    // SYNCHRONOUSLY after the sends return, before a single await: the exact
    // state a React commit would render. WORSE than the log recorded: not only
    // are there no rows, `busy` has not been refreshed either, so the single
    // "Queued" line the log credits the screen with is not there yet either.
    const atReturn = a.getState();
    expect(
      {
        outbound: atReturn.outbound.map((entry) => entry.text),
        busy: atReturn.busy,
        transmitting: atReturn.transmitting,
        progress: atReturn.progress,
        notices: atReturn.notices.length,
      },
      "a screen with three accepted notes in it, rendering as an idle chat",
    ).toEqual({
      outbound: ["one", "two", "three"],
      busy: false,
      transmitting: true,
      progress: null,
      notices: 0,
    });
    // Two things worth recording, because they are what the fix had to get
    // right rather than what it had to add:
    //
    // 1. `busy` is STILL false at this instant. `session.busy` is
    //    `#pumping || #outbound !== null` and neither is true before the claim,
    //    so the single global "Queued" line still does not render at accept
    //    time. The fix had to make the *rows* honest; it did not and could not
    //    make `busy` mean something else without changing a Phase 2 getter.
    // 2. `transmitting` is TRUE at accept time, because `send()` claims
    //    `#txBusy` synchronously. That is what makes
    //    `SOUND_CHAT_COPY.transmit.arming` ("Getting ready to play.")
    //    reachable for the first time — `deep-p3b-acoustic.test.ts` B-2 pinned
    //    that window as *never* published.
    expect(a.getState(), "a chat screen that cannot tell itself from idle").not.toBe(idle);

    // After the pump's microtask: the head is claimed and published, and the one
    // global "Queued" line appears. Two of the three are still in no list.
    await settle();
    const afterPump = a.getState();
    expect(
      afterPump.outbound.map((entry) => [entry.text, entry.status]),
      "rows rendered after the pump claimed the head",
    ).toEqual([
      ["one", "sending"],
      ["two", "queued"],
      ["three", "queued"],
    ]);
    expect(afterPump.busy).toBe(true);
    a.cancel();
  });
});

/* ================================================================== *
 * D1.2 — FIXED BEHAVIOUR. The regression pins for option (a):
 * the session publishes a `queued` outbound event at accept time.
 *
 * FAILS against current behaviour. Do not invert.
 * ================================================================== */

describe("D1.2 FIXED BEHAVIOUR: the session publishes a row at accept time", () => {
  it("PIN: every accepted note has a row before `send()` returns", async () => {
    const { a } = await pairedPair();
    contextFor(a).takeSchedule();

    a.send("one");
    expect(
      a.getState().outbound.map((entry) => [entry.text, entry.status]),
      "the first accepted note has no rendered row at the moment `send()` returned",
    ).toEqual([["one", "queued"]]);

    a.send("two");
    a.send("three");
    expect(
      a.getState().outbound.map((entry) => [entry.text, entry.status]),
      "three accepted notes, two of them invisible",
    ).toEqual([
      ["one", "queued"],
      ["two", "queued"],
      ["three", "queued"],
    ]);
    a.cancel();
  });

  it("PIN: the claim retires the placeholder in place, never duplicating it", async () => {
    const { a } = await pairedPair();
    contextFor(a).takeSchedule();

    a.send("one");
    a.send("two");
    a.send("three");
    const accepted = a.getState().outbound;
    // `sendId`, never `msgId`: `msgId` is null for the whole `queued` life of a
    // note, so it cannot be the transcript key — which is exactly the reason the
    // fix added a second identity rather than moving the wire id forward.
    const ids = accepted.map((entry) => entry.sendId);
    expect(new Set(ids).size, "two rows share one identity").toBe(ids.length);
    expect(
      accepted.map((entry) => entry.msgId),
      "a queued row invented a wire id before the pump sealed one",
    ).toEqual([null, null, null]);

    // The pump claims the head on its microtask and publishes `sending` for the
    // same msgId, so the placeholder is *updated*, not replaced by a new row.
    await settle();
    const claimed = a.getState().outbound;
    expect(
      claimed.map((entry) => [entry.text, entry.status]),
      "the placeholder row was retired rather than the queue having two rows per note",
    ).toEqual([
      ["one", "sending"],
      ["two", "queued"],
      ["three", "queued"],
    ]);
    expect(
      claimed.map((entry) => entry.seq),
      "the claimed note kept its render position, so the row did not jump",
    ).toEqual(accepted.map((entry) => entry.seq));
    expect(new Set(claimed.map((entry) => entry.sendId)).size).toBe(3);
    // And the claimed note is the only one that grew a wire id.
    expect(claimed.map((entry) => entry.msgId)).toEqual([expect.any(Number), null, null]);
    a.cancel();
  });

  it("PIN: one note can never own two rows, because identities never repeat", async () => {
    const { a } = await pairedPair();
    contextFor(a).takeSchedule();
    a.send("only");
    await settle();
    expect(a.getState().outbound).toHaveLength(1);
    expect(a.getState().outbound[0]?.msgId).toBeTypeOf("number");
    a.send("second");
    await settle();
    const both = a.getState().outbound;
    expect(both.map((entry) => entry.text)).toEqual(["only", "second"]);
    expect(new Set(both.map((entry) => entry.sendId)).size).toBe(2);
    a.cancel();
  });

  it("PIN: an accepted note that the session then loses is reported, not vanished", async () => {
    // `deep-p3b-acoustic.test.ts` B-4 recorded this as its own KNOWN DEFECT:
    // `send()` returned `{ok:true}`, so the composer cleared the draft, and
    // `#moduleFailed` emptied `#pending` before the pump ran — so the note
    // existed in no row and no notice.
    const { a } = await pairedPair();
    const context = contextFor(a);
    a.send("accepted, then the codec dies before the pump runs");
    expect(a.send("x").ok).toBe(true);
    // A whole-frame violation is what a frame-contract failure looks like from
    // here, and it arrives synchronously before the pump's microtask.
    context.processors[0]?.onaudioprocess?.({
      inputBuffer: { getChannelData: () => new Float32Array(1000) },
    });
    await settle(512);

    const state = a.getState();
    expect(state.phase).toBe("fatal");
    expect(
      state.outbound.filter((entry) => entry.status === "sending"),
      "a note the session can never send is published to a terminal screen as 'Playing'",
    ).toEqual([]);
    expect(
      state.outbound.map((entry) => [entry.text, entry.status]),
      "two notes the session accepted exist in no rendered row and no notice",
    ).toEqual([
      ["accepted, then the codec dies before the pump runs", "failed"],
      ["x", "failed"],
    ]);
    a.cancel();
  });

  it("PIN: a queued row carries the note's real block count, and no bar", async () => {
    const { a } = await pairedPair();
    contextFor(a).takeSchedule();
    a.send("first");
    a.send("x".repeat(84));
    // The block count IS knowable at accept time from the byte length, and it
    // has to be right: the composer's "one block / two blocks" line is derived
    // from the same `blocksForPlaintextBytes`, and a queued row that quoted one
    // block for a two-block note would size a bar that lies. What a queued row
    // must NOT do is move a bar — `#startProgress` is reached only from the
    // `sending` event, and this pins that.
    expect(
      a.getState().outbound.map((entry) => [entry.text.length, entry.status, entry.blocks]),
      "a queued row's block count disagrees with the protocol's own rule",
    ).toEqual([
      ["first".length, "queued", 1],
      [84, "queued", 2],
    ]);
    expect(a.getState().progress, "a queued row moved a progress bar").toBeNull();
    a.cancel();
  });

  it("PIN: a refused send leaves no row at all", async () => {
    const { a } = await pairedPair();
    contextFor(a).takeSchedule();
    a.send("first");
    a.send("second");
    a.send("third");
    a.send("fourth");
    expect(a.send("fifth"), "the queue bound").toEqual({ ok: false, reason: "queue-full" });
    expect(
      a.getState().outbound.filter((entry) => entry.text === "fifth"),
      "a refused note has a row",
    ).toEqual([]);
    expect(a.send(""), "an empty note").toEqual({ ok: false, reason: "empty" });
    expect(a.send("z".repeat(85)), "an over-cap note").toEqual({ ok: false, reason: "too-long" });
    expect(a.getState().outbound).toHaveLength(4);
    a.cancel();
  });
});

/* ================================================================== *
 * D1.3 — bounds, and the round trip the fix must not break.
 * ================================================================== */

describe("D1.3 bounds and the round trip", () => {
  it("MEASURED: MAX_PENDING_MESSAGES is the bound, and every accepted note is in it", async () => {
    const { a } = await pairedPair();
    contextFor(a).takeSchedule();
    const results = [1, 2, 3, 4, 5, 6].map((index) => a.send(`n${index}`));
    expect(results.map((result) => (result.ok ? "ok" : result.reason))).toEqual([
      "ok",
      "ok",
      "ok",
      "ok",
      "queue-full",
      "queue-full",
    ]);
    // Every accepted note has a row; neither refused one does. This is the whole
    // of the D1 contract in one assertion.
    await settle();
    expect(a.getState().outbound.map((entry) => [entry.text, entry.status])).toEqual([
      ["n1", "sending"],
      ["n2", "queued"],
      ["n3", "queued"],
      ["n4", "queued"],
    ]);
    a.cancel();
  });

  it("PIN: the transcript stays bounded with queued rows in it", async () => {
    const { a } = await pairedPair();
    contextFor(a).takeSchedule();
    // Far more than the bound, in batches the pump cannot keep up with.
    for (let batch = 0; batch < 120; batch += 1) {
      a.send(`note ${batch}`);
      await settle(2);
    }
    await settle();
    const rows = a.getState().outbound;
    expect(rows.length, "the transcript grew past its bound").toBeLessThanOrEqual(
      MAX_TRANSCRIPT_ENTRIES,
    );
    expect(rows.length, "and almost nothing is in it").toBeGreaterThan(4);
    a.cancel();
  });

  it("MEASURED: a note that completes its round trip is one row", async () => {
    const { a, b } = await pairedPair();
    contextFor(a).takeSchedule();
    a.send("goes out");
    for (let round = 0; round < 10; round += 1) {
      if (b.getState().inbound.length > 0 && a.getState().outbound[0]?.status === "sent") break;
      await deliver(a, b);
      await deliver(b, a);
    }
    const rows = a.getState().outbound;
    expect(rows.length, "a note that was fully accounted for is not in the transcript").toBe(1);
    expect(rows[0]?.text).toBe("goes out");
    expect(rows[0]?.status).toBe("sent");
    a.cancel();
    b.cancel();
  });
});
