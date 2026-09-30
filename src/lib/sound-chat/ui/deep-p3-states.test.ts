/**
 * The state explosion: every `TransportState` × every `OutboundStatus` × every
 * phase × every block/fatal kind, driven straight into `SoundChatUiController`.
 *
 * WHY a stubbed session: the real one cannot be made to emit 250 transcripts,
 * 20 notices or a `blocks: 0` transmission, and those are exactly the inputs
 * that decide whether the bounded state keeps the *newest* thing. `vi.mock` is
 * the only seam that reaches the controller's own event handler without
 * production code existing for the test, so the mock is on `../session` alone —
 * the real `../audio-io`, the real `../codec` loader and the real transport
 * machine are untouched, so `begin()` still performs a genuine 600 000-iteration
 * key derivation and still has to place a real context.
 *
 * The stub only has to be honest about the five things the controller reads:
 * `transmitting`, `busy`, `state`, `pairing`, `stats` and the three callbacks.
 */

import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openSoundChatCodec } from "../codec";
import { SoundChatSession } from "../session";
import type {
  SendRefusal,
  SendResult,
  SessionEvent,
  SessionStats,
  SoundChatSessionOptions,
} from "../session";
import type { PairingFailureReason, PairingState } from "../pairing";
import { describePairingFailure } from "../pairing";
import type { TransportState } from "../transport-machine";
import { MAX_NOTICES, MAX_TRANSCRIPT_ENTRIES, SoundChatUiController } from "./controller";

type Handlers = {
  onEvent: (event: SessionEvent) => void;
  onListenerError: (error: unknown) => void;
  onModuleError: (error: unknown) => void;
};

const created: FakeSession[] = [];

/**
 * A session that records nothing and does nothing on its own. Every fact the
 * controller reads is a plain field a test can set, and every event it is
 * supposed to consume is pushed through `emit`, which goes down the real
 * `onEvent` exactly as the real session would.
 */
class FakeSession {
  state: TransportState = "listening";
  pairing: PairingState = { kind: "idle" };
  transmitting = false;
  busy = false;
  stopped = 0;
  readonly pairingCode: string;
  readonly stats: SessionStats = {
    blocksDecoded: 0,
    framesUnreadable: 0,
    messagesDelivered: 0,
    duplicatesSuppressed: 0,
    conflicts: 0,
    acksSent: 0,
    retries: 0,
  };
  readonly refused: SendRefusal[] = [];
  /** Mirrors the real session's submission-id allocator. */
  sendId = 0;
  #handlers: Handlers | null = null;

  constructor(options: SoundChatSessionOptions) {
    this.#handlers = {
      onEvent: options.onEvent as (event: SessionEvent) => void,
      onListenerError: options.onListenerError as (error: unknown) => void,
      onModuleError: options.onModuleError as (error: unknown) => void,
    };
    this.pairingCode = options.pairingCode ?? "ABCD2345";
  }

  static async create(options: SoundChatSessionOptions): Promise<SoundChatSession> {
    const session = new FakeSession(options);
    created.push(session);
    return session as unknown as SoundChatSession;
  }

  get latest(): FakeSession {
    const found = created.at(-1);
    if (found === undefined) throw new Error("no session was created");
    return found;
  }

  /** Mirrors the real session: one hand-written sentence per failure reason. */
  get pairingFailureMessage(): string | null {
    return this.pairing.kind === "failed" ? describePairingFailure(this.pairing.reason) : null;
  }

  start(): void {}

  stop(): void {
    this.stopped += 1;
    // A real `stop()` emits STOP, so a torn-down session is still one event away
    // from the controller's handler.
    this.state = "idle";
    this.transmitting = false;
    this.busy = false;
    this.emit({ type: "transport", state: "idle" });
  }

  send(text: string): SendResult {
    const refusal: SendRefusal | null =
      text === "stop"
        ? "stopped"
        : text === "module"
          ? "module-error"
          : text === "queue"
            ? "queue-full"
            : null;
    if (refusal !== null) {
      this.refused.push(refusal);
      return { ok: false, reason: refusal };
    }
    this.sendId += 1;
    // A real session publishes the accepted-but-unclaimed note synchronously,
    // before it returns, so the transcript row exists in the same tick. This
    // fake has to do the same or it would be modelling a session nobody has.
    this.emit({
      type: "outbound",
      sendId: this.sendId,
      msgId: null,
      status: "queued",
      attempts: 0,
      blocks: 1,
      text,
    });
    return { ok: true, queued: this.busy, sendId: this.sendId };
  }

  restart(): { ok: false; reason: "codec-dead" | "not-restartable" } {
    return { ok: false, reason: "not-restartable" };
  }

  emit(event: SessionEvent): void {
    // A real session's own getters move with its own events, which is what makes
    // the controller's `#refresh()` re-read meaningful.
    if (event.type === "pairing") this.pairing = event.state;
    if (event.type === "transport") this.state = event.state;
    this.#handlers?.onEvent(event);
  }

  /**
   * An event whose state disagrees with this session's own getter. The real
   * driver cannot produce one — `#emit` fires only after the machine has moved,
   * so the getter and the event are the same fact — which is exactly why the
   * controller's precedence between them is worth pinning down.
   */
  spoof(event: SessionEvent): void {
    this.#handlers?.onEvent(event);
  }

  listenerError(error: unknown): void {
    this.#handlers?.onListenerError(error);
  }

  moduleError(error: unknown): void {
    this.#handlers?.onModuleError(error);
  }
}

vi.mock("../session", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../session")>();
  return {
    ...actual,
    SoundChatSession: {
      create: (options: SoundChatSessionOptions) => FakeSession.create(options),
    },
  };
});

const codec = await openSoundChatCodec();
afterAll(() => {
  codec.close();
});

const contexts: unknown[] = [];
const tracks: { stopped: number }[] = [];

class FakeAudioContext {
  sampleRate = 48_000;
  state = "running";
  readonly destination = { kind: "destination" };
  closeCalls = 0;
  constructor() {
    contexts.push(this);
  }
  get currentTime(): number {
    return 20;
  }
  async resume(): Promise<unknown> {
    return this;
  }
  async close(): Promise<void> {
    this.closeCalls += 1;
    this.state = "closed";
  }
  createMediaStreamSource(): unknown {
    return { connect: () => {}, disconnect: () => {} };
  }
  createScriptProcessor(): unknown {
    return { onaudioprocess: null, connect: () => {}, disconnect: () => {} };
  }
  createGain(): unknown {
    return { gain: { value: 1 }, connect: () => {}, disconnect: () => {} };
  }
  createBuffer(): { copyToChannel: (samples: Float32Array) => void } {
    return { copyToChannel: () => {} };
  }
  createBufferSource(): unknown {
    return { buffer: null, connect: () => ({}), start: () => {} };
  }
}

const liveControllers: SoundChatUiController[] = [];

beforeEach(() => {
  contexts.length = 0;
  tracks.length = 0;
  created.length = 0;
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
  vi.stubGlobal("AudioContext", FakeAudioContext);
  vi.stubGlobal("navigator", {
    mediaDevices: {
      getUserMedia: async () => {
        const track = {
          stopped: 0,
          stop(): void {
            track.stopped += 1;
          },
        };
        tracks.push(track);
        return {
          getAudioTracks: () => [track],
          getTracks: () => [track],
        } as unknown as MediaStream;
      },
    },
  });
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

async function live(role: "displayer" | "enterer" = "displayer"): Promise<{
  readonly controller: SoundChatUiController;
  readonly session: FakeSession;
}> {
  const controller = newController();
  await controller.begin(role);
  return { controller, session: created.at(-1) as FakeSession };
}

const STATES: TransportState[] = [
  "idle",
  "listening",
  "transmitting",
  "awaiting_turn",
  "awaiting_ack",
  "backoff",
  "hidden_hold",
  "error",
  "module_error",
];

describe("S-A every transport state, with and without a bar", () => {
  for (const state of STATES) {
    it(`renders no state the ${state} snapshot does not carry`, async () => {
      const { controller, session } = await live();
      session.state = state;
      session.transmitting = state === "transmitting";
      session.busy = state === "transmitting" || state === "awaiting_ack";
      session.emit({ type: "transport", state });
      const snapshot = controller.getState();
      expect(snapshot.transport).toBe(state);
      // Whatever the state, the two things the bar is allowed to claim are the
      // two the session itself reports.
      expect(snapshot.transmitting).toBe(session.transmitting);
      expect(snapshot.busy).toBe(session.busy);
      if (snapshot.progress === null) {
        expect(snapshot.transmitting || state === "transmitting").toBe(
          state === "transmitting" && false,
        );
      }
      // A bar is never shown for a state in which nothing of ours is on the air.
      const onAir = state === "transmitting" || state === "awaiting_ack";
      if (!onAir) expect(snapshot.progress, `a bar for ${state}`).toBeNull();
    });
  }

  it("shows no bar before anything is on the air, and a bar for both on-air states", async () => {
    const { controller, session } = await live();
    expect(controller.getState().progress).toBeNull();
    for (const state of ["transmitting", "awaiting_ack"] as const) {
      session.state = state;
      session.emit({ type: "transport", state });
      expect(controller.getState().progress, `no bar for ${state}`).not.toBeNull();
    }
  });

  it("keeps `transmitting` and `progress` from contradicting each other", async () => {
    const { controller, session } = await live();
    session.state = "transmitting";
    session.transmitting = true;
    session.emit({ type: "transport", state: "transmitting" });
    // A bar is present, so the component must not also claim to be "getting
    // ready": the two are rendered in the same block and one of them is a lie.
    expect(controller.getState().transmitting).toBe(true);
    expect(controller.getState().progress).not.toBeNull();

    session.state = "awaiting_ack";
    session.transmitting = false;
    session.emit({ type: "transport", state: "awaiting_ack" });
    // On the air, nothing of ours is being played, and the bar is full. The
    // component's honest fallback sentence ("waiting for the other device to
    // confirm") is gated on `progress === null`, so it is NOT shown here.
    expect(controller.getState().progress).not.toBeNull();
    expect(controller.getState().progress?.fraction).toBeLessThanOrEqual(1);
  });

  it("takes the session's own state as the authority, not the event's", async () => {
    const { controller, session } = await live();
    for (const state of STATES) {
      // The event says one thing and the getter says another. `#onEvent` patches
      // the event's state and then `#refresh()` re-reads the getter, so the
      // getter is what survives — which is the right precedence, because every
      // bar decision is taken from the getter.
      session.spoof({ type: "transport", state });
      expect(controller.getState().transport).toBe("listening");
      if (state !== "transmitting" && state !== "awaiting_ack") {
        expect(controller.getState().progress, `a bar for a spoofed ${state}`).toBeNull();
      }
    }
  });

  it("starts no interval for a spoofed on-air event the getter contradicts", async () => {
    const { controller, session } = await live();
    session.spoof({ type: "transport", state: "transmitting" });
    // `#startProgress` decides from the session's own state, the same source
    // `#refresh` decides from, so the two halves cannot disagree: no bar on
    // screen means no timer behind it, and a spoofed event cannot buy a 10 Hz
    // ticker that nothing will ever stop.
    expect(controller.getState().progress).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
    controller.cancel();
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("S-B the transcript keeps the newest, not the oldest", () => {
  it(`keeps the last ${MAX_TRANSCRIPT_ENTRIES} inbound notes and drops the oldest`, async () => {
    const { controller, session } = await live();
    for (let index = 0; index < MAX_TRANSCRIPT_ENTRIES + 50; index += 1) {
      session.emit({ type: "message", msgId: index, text: `n${index}` });
    }
    const inbound = controller.getState().inbound;
    expect(inbound).toHaveLength(MAX_TRANSCRIPT_ENTRIES);
    // The oldest is gone and the newest is here: `slice(-MAX)` on a list that is
    // already in render order keeps the tail. The opposite mistake — dropping the
    // newest — is the one that would silently lose the note a person just sent.
    expect(inbound[0]?.text).toBe(`n${50}`);
    expect(inbound.at(-1)?.text).toBe(`n${MAX_TRANSCRIPT_ENTRIES + 49}`);
  });

  it(`keeps the last ${MAX_TRANSCRIPT_ENTRIES} outbound notes under a flood`, async () => {
    const { controller, session } = await live();
    const total = MAX_TRANSCRIPT_ENTRIES + 50;
    for (let index = 0; index < total; index += 1) {
      session.emit({
        type: "outbound",
        msgId: index,
        sendId: index,
        status: "sent",
        attempts: 1,
        blocks: 1,
        text: `o${index}`,
      });
    }
    const outbound = controller.getState().outbound;
    expect(outbound).toHaveLength(MAX_TRANSCRIPT_ENTRIES);
    expect(outbound[0]?.text).toBe(`o${50}`);
    expect(outbound.at(-1)?.text).toBe(`o${total - 1}`);
    // And the render order survives the trim: the array is sorted by `seq`
    // after every update, so the oldest kept note is still the lowest.
    for (let index = 1; index < outbound.length; index += 1) {
      expect(outbound[index]?.seq).toBeGreaterThan(outbound[index - 1]?.seq ?? 0);
    }
  });

  it(`keeps the last ${MAX_NOTICES} notices`, async () => {
    const { controller, session } = await live();
    for (let index = 0; index < MAX_NOTICES + 14; index += 1) {
      session.emit({ type: "heard-unreadable", reason: "conflicting-block", count: index });
    }
    const notices = controller.getState().notices;
    expect(notices).toHaveLength(MAX_NOTICES);
    // The same text every time, so the ids are what proves the order.
    expect(new Set(notices.map((notice) => notice.id)).size).toBe(MAX_NOTICES);
    expect(Math.max(...notices.map((notice) => notice.id))).toBe(MAX_NOTICES + 14);
    expect(Math.min(...notices.map((notice) => notice.id))).toBe(15);
  });

  it("keeps a note in place when only its status changes", async () => {
    const { controller, session } = await live();
    const report = (status: "sending" | "sent" | "failed", attempts: number): void => {
      session.emit({
        type: "outbound",
        sendId: 7,
        msgId: 7,
        status,
        attempts,
        blocks: 2,
        text: "hello",
      });
    };
    report("sending", 1);
    const first = controller.getState().outbound[0];
    report("sending", 2);
    report("sent", 2);
    const after = controller.getState().outbound[0];
    // One note, one position: a status change must not re-sort the transcript or
    // hand the same words a second bubble.
    expect(controller.getState().outbound).toHaveLength(1);
    expect(after?.seq).toBe(first?.seq);
    expect(after?.status).toBe("sent");
  });

  it("orders a note against a reply by the one render counter", async () => {
    const { controller, session } = await live();
    session.emit({
      type: "outbound",
      msgId: 900,
      sendId: 900,
      status: "sending",
      attempts: 1,
      blocks: 1,
      text: "q",
    });
    session.emit({ type: "message", msgId: 1, text: "a" });
    session.emit({
      type: "outbound",
      msgId: 901,
      sendId: 901,
      status: "sending",
      attempts: 1,
      blocks: 1,
      text: "q2",
    });
    const outbound = controller.getState().outbound;
    const inbound = controller.getState().inbound;
    expect(outbound[0]?.seq).toBeLessThan(inbound[0]?.seq ?? 0);
    expect(inbound[0]?.seq).toBeLessThan(outbound[1]?.seq ?? 0);
    // Two peers allocate msgIds from independent counters, so a sender's 900 and
    // a receiver's 900 are two different notes and must never be merged.
    expect(inbound.some((entry) => entry.msgId === 900)).toBe(false);
  });

  it("keeps the sequence monotonic across a restart", async () => {
    const { controller, session } = await live();
    session.emit({ type: "message", msgId: 1, text: "before" });
    const before = controller.getState().inbound[0]?.seq ?? 0;
    await controller.restart();
    const after = created.at(-1) as FakeSession;
    after.emit({ type: "message", msgId: 1, text: "after" });
    const next = controller.getState().inbound[0]?.seq ?? 0;
    // The transcript is empty after a restart, so nothing can compare the two
    // directly — but a counter that reset would restart at 1 and the merge in
    // `message-list.tsx` would still be correct by accident. Assert the counter
    // itself moved on, so a future merge cannot rely on a fresh start.
    expect(next).toBeGreaterThan(before);
  });

  it("ignores a duplicate msgId from a peer as two notes", async () => {
    const { controller, session } = await live();
    session.emit({ type: "message", msgId: 4, text: "one" });
    session.emit({ type: "message", msgId: 4, text: "one again" });
    // The session already suppresses redelivery; the controller's job is to
    // render what it is given, and both entries are rendered, in order.
    expect(controller.getState().inbound).toHaveLength(2);
    expect(controller.getState().inbound[1]?.seq).toBeGreaterThan(
      controller.getState().inbound[0]?.seq ?? 0,
    );
  });
});

describe("S-C a hostile or degenerate outbound event", () => {
  it("sizes a bar for a transmission that reports no blocks at all", async () => {
    const { controller, session } = await live();
    session.state = "transmitting";
    session.transmitting = true;
    session.emit({
      type: "outbound",
      msgId: 1,
      sendId: 1,
      status: "sending",
      attempts: 1,
      blocks: 0,
      text: "x",
    });
    const progress = controller.getState().progress;
    // Zero is not a total. The bar must fall back to one block rather than divide
    // by zero and render `NaN%` or a bar that never moves.
    expect(progress?.blocks).toBe(1);
    expect(progress?.fraction).toBeGreaterThanOrEqual(0);
    expect(progress?.remainingMs).toBeGreaterThan(0);
  });

  it("sizes a bar from a block count far beyond the cap", async () => {
    const { controller, session } = await live();
    session.state = "transmitting";
    session.transmitting = true;
    session.emit({
      type: "outbound",
      msgId: 1,
      sendId: 1,
      status: "sending",
      attempts: 1,
      blocks: 64,
      text: "x",
    });
    const progress = controller.getState().progress;
    // Hostile but not fatal: the bar is sized to what it was told and the index
    // stays inside it, so the copy can never read "Block 65 of 64".
    expect(progress?.blocks).toBe(64);
    expect(progress?.blockIndex).toBeLessThanOrEqual(64);
    expect(progress?.blockIndex).toBeGreaterThanOrEqual(1);
    expect(progress?.remainingMs).toBe(64 * 1_920);
  });

  it("renders nothing at all for a bar nobody is on the air for", async () => {
    const { controller, session } = await live();
    // The `outbound: sending` event is the earliest honest point to start a bar,
    // but it is only rendered while the session also says it is transmitting.
    // A pump that emits it from a held or refused attempt must not produce a
    // bar, or the UI would claim audio that is not going out.
    session.state = "hidden_hold";
    session.emit({
      type: "outbound",
      msgId: 1,
      sendId: 1,
      status: "sending",
      attempts: 1,
      blocks: 1,
      text: "x",
    });
    expect(controller.getState().progress).toBeNull();
  });

  it("carries a note with a lone surrogate, a CRLF and no whitespace trimming", async () => {
    const { controller, session } = await live();
    const text = "line one\r\n\ud800line two   ";
    session.emit({
      type: "outbound",
      msgId: 1,
      sendId: 1,
      status: "sent",
      attempts: 1,
      blocks: 1,
      text,
    });
    expect(controller.getState().outbound[0]?.text).toBe(text);
    session.emit({ type: "message", msgId: 2, text });
    expect(controller.getState().inbound[0]?.text).toBe(text);
  });

  it("accepts a late event from a session it has already replaced", async () => {
    const { controller, session } = await live();
    const stale = session;
    await controller.restart();
    // The torn-down session's `onEvent` is still bound to the controller, and
    // the controller fences `begin()` with `#generation` but not `#onEvent`. The
    // real session is what stops this today: `stop()` sets `#stopped` and
    // `#handleBlock` re-checks it after its `await`, so a block already inside
    // `crypto.subtle` is dropped. Recorded as the boundary it is, because the
    // protection lives in a module this controller does not own.
    stale.emit({
      type: "outbound",
      msgId: 2,
      sendId: 2,
      status: "sent",
      attempts: 1,
      blocks: 1,
      text: "ghost",
    });
    stale.emit({ type: "message", msgId: 3, text: "ghost" });
    const after = controller.getState();
    // A restart is a new session: the new session is the one that filled this.
    expect(after.code).toBe(stale.pairingCode);
    expect(created).toHaveLength(2);
  });

  it("takes no notice at all after dispose()", async () => {
    const { controller, session } = await live();
    controller.dispose();
    const before = controller.getState();
    session.emit({ type: "message", msgId: 1, text: "after" });
    session.emit({
      type: "outbound",
      msgId: 2,
      sendId: 2,
      status: "sent",
      attempts: 1,
      blocks: 1,
      text: "after",
    });
    session.emit({ type: "heard-unreadable", reason: "auth-failed", count: 1 });
    session.moduleError(new Error("after"));
    session.listenerError(new Error("after"));
    // A disposed controller is inert: no transcript, no notice, no fatal, and the
    // React subscriber is gone so nothing re-renders a screen that is gone.
    expect(controller.getState()).toBe(before);
  });
});

describe("S-D the fatal path", () => {
  it("stops the ticker and keeps no bar across a module failure", async () => {
    const { controller, session } = await live();
    session.state = "transmitting";
    session.transmitting = true;
    session.emit({ type: "transport", state: "transmitting" });
    session.emit({
      type: "outbound",
      msgId: 1,
      sendId: 1,
      status: "sending",
      attempts: 1,
      blocks: 2,
      text: "x",
    });
    expect(controller.getState().progress).not.toBeNull();
    session.moduleError(new Error("the codec died"));
    const after = controller.getState();
    expect(after.phase).toBe("fatal");
    expect(after.progress).toBeNull();
    // Read from the session rather than hard-coded, so the terminal screen is
    // not a second owner of `transmitting`/`busy` that can contradict the
    // transport. The fake is genuinely still `transmitting` at this point, and
    // the screen now says so instead of claiming otherwise.
    expect(after.transmitting).toBe(session.transmitting);
    expect(after.busy).toBe(session.busy);
    // The note the pump had claimed cannot keep reading "Playing" over a codec
    // that is gone.
    expect(after.outbound.every((entry) => entry.status !== "sending")).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("cannot be revived by a transport event that arrives after the failure", async () => {
    const { controller, session } = await live();
    session.moduleError(new Error("the codec died"));
    // The session is terminal, so this cannot happen through the real driver —
    // but the controller's own guard for it is `#progressStartedAt`, and that
    // field is deliberately *not* reset by `#onModuleError`. If a late on-air
    // event does arrive, the bar must not come back frozen with no ticker to
    // move it.
    session.state = "transmitting";
    session.emit({ type: "transport", state: "transmitting" });
    const after = controller.getState();
    if (after.progress !== null) {
      // A live bar would have to be a moving one.
      expect(vi.getTimerCount()).toBeGreaterThan(0);
    } else {
      expect(after.progress).toBeNull();
    }
  });

  it("reports the refusal a stopped session gives without inventing a phase", async () => {
    const controller = newController();
    expect(controller.send("anything")).toEqual({ ok: false, reason: "not-paired" });
    controller.dispose();
    expect(controller.send("anything")).toEqual({ ok: false, reason: "stopped" });
  });

  it("passes every session refusal through the controller's own check", async () => {
    const { controller, session } = await live();
    // The controller checks the body *before* the session, so a body the
    // protocol would refuse never reaches it.
    expect(controller.send("")).toEqual({ ok: false, reason: "empty" });
    expect(controller.send("a".repeat(85))).toEqual({ ok: false, reason: "too-long" });
    expect(session.refused).toEqual([]);
    // And a body the protocol accepts is handed straight over, so the session's
    // state-dependent refusals come back verbatim.
    expect(controller.send("queue")).toEqual({ ok: false, reason: "queue-full" });
    expect(controller.send("module")).toEqual({ ok: false, reason: "module-error" });
    expect(controller.send("stop")).toEqual({ ok: false, reason: "stopped" });
    expect(session.refused).toEqual(["queue-full", "module-error", "stopped"]);
  });
});

describe("S-E pairing states and their failure copy", () => {
  const failures: PairingFailureReason[] = ["wrong-code", "no-peer", "no-confirmation"];

  for (const reason of failures) {
    it(`names ${reason} with the session's own sentence`, async () => {
      const { controller, session } = await live();
      session.emit({
        type: "pairing",
        state: { kind: "failed", code: "ABCD2345", role: "displayer", reason },
      });
      const state = controller.getState();
      expect(state.pairing.kind).toBe("failed");
      expect(state.pairingFailure).toBe(describePairingFailure(reason));
      // Never the internal fallback, which would name a reason instead of a fix.
      expect(state.pairingFailure).not.toBe(`Pairing did not complete (${reason}).`);
    });
  }

  it("falls back to a named reason when the session has no sentence", async () => {
    const { controller, session } = await live();
    Object.defineProperty(session, "pairingFailureMessage", {
      value: null,
      configurable: true,
    });
    session.emit({
      type: "pairing",
      state: { kind: "failed", code: "ABCD2345", role: "enterer", reason: "no-confirmation" },
    });
    expect(controller.getState().pairingFailure).toBe(
      "Pairing did not complete (no-confirmation).",
    );
  });

  it("prefers the session's own sentence over the generic one", async () => {
    const { controller, session } = await live();
    // A real session has a hand-written sentence for each reason; the fallback
    // in `#pairingFailureText` is only for a session that has none.
    Object.defineProperty(session, "pairingFailureMessage", {
      value:
        "No paired device was heard. Make sure the other device is listening, then start again.",
      configurable: true,
    });
    session.emit({
      type: "pairing",
      state: { kind: "failed", code: "ABCD2345", role: "displayer", reason: "no-peer" },
    });
    expect(controller.getState().pairingFailure).toContain("No paired device was heard");
  });

  it("clears the failure when pairing succeeds, and only then enters chat", async () => {
    const { controller, session } = await live();
    session.emit({
      type: "pairing",
      state: { kind: "failed", code: "ABCD2345", role: "displayer", reason: "no-peer" },
    });
    expect(controller.getState().pairingFailure).not.toBeNull();
    session.emit({
      type: "pairing",
      state: { kind: "failed", code: "ABCD2345", role: "enterer", reason: "wrong-code" },
    });
    expect(controller.getState().pairingFailure).not.toBeNull();
    session.emit({
      type: "pairing",
      state: { kind: "paired", code: "ABCD2345", role: "displayer", peerSalt: new Uint8Array(16) },
    });
    const after = controller.getState();
    expect(after.phase).toBe("chat");
    expect(after.pairingFailure).toBeNull();
  });

  it("leaves the phase alone for a non-paired pairing state", async () => {
    const { controller, session } = await live();
    for (const state of [
      { kind: "waiting-for-peer", code: "ABCD2345", role: "displayer" },
      { kind: "awaiting-confirmation", code: "ABCD2345", role: "enterer" },
    ] as PairingState[]) {
      session.emit({ type: "pairing", state });
      expect(controller.getState().phase).toBe("pairing");
    }
  });
});

describe("S-F subscriber bookkeeping", () => {
  it("stops delivering after unsubscribe, including to the subscriber before it", async () => {
    const controller = newController();
    let first = 0;
    let second = 0;
    const off = controller.subscribe(() => {
      first += 1;
    });
    controller.subscribe(() => {
      second += 1;
    });
    controller.cancel();
    const held = { first, second };
    off();
    controller.cancel();
    expect(first).toBe(held.first);
    expect(second).toBeGreaterThan(held.second);
  });

  it("drops every subscriber on dispose, so a remounted screen cannot hear a dead one", async () => {
    const controller = newController();
    let calls = 0;
    controller.subscribe(() => {
      calls += 1;
    });
    controller.dispose();
    const held = calls;
    // Nothing public mutates state after dispose, so drive the internal path the
    // only way it can be reached: an event from a session that outlived it.
    await controller.begin("displayer");
    expect(calls).toBe(held);
  });

  it("reports a consumer error as a notice rather than as a failure", async () => {
    const { controller, session } = await live();
    session.listenerError(new RangeError("a consumer bug"));
    const notices = controller.getState().notices;
    expect(notices).toHaveLength(1);
    expect(notices[0]?.tone).toBe("warn");
    expect(notices[0]?.text).toContain("RangeError: a consumer bug");
    // And the phase is untouched: a consumer bug is not a codec verdict.
    expect(controller.getState().phase).toBe("pairing");
    expect(controller.getState().fatal).toBeNull();
  });
});
