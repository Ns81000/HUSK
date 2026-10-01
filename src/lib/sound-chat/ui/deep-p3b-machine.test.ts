/**
 * Phase 3V, seam 2: the UI state machine, driven through its own event channel.
 *
 * WHY a stubbed session here: this file is about which *combinations* the
 * controller can publish, and the real session cannot be made to emit a
 * `pairing: paired` after a module death, a `transmitting` bar during a fatal
 * phase, or twenty notices in a tick. The stub is the same seam
 * `deep-p3-states.test.ts` uses and is on `../session` alone: `begin()` still
 * performs a real 600 000-iteration key derivation, still opens a real context
 * and still loads the real codec, so nothing about the controller's own start-up
 * is faked.
 *
 * Every finding this file records is asserted as *observed behaviour*, not as an
 * aspiration, so the suite stays green and each defect stays machine-readable.
 * A test named `KNOWN DEFECT` is a bug report that fails the moment somebody
 * fixes it — which is the intended direction.
 */

import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openSoundChatCodec } from "../codec";
import { CodecModuleError, CodecUsageError } from "../codec";
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
import { classifyFatalError, SoundChatUiController, type SoundChatUiPhase } from "./controller";

type Handlers = {
  onEvent: (event: SessionEvent) => void;
  onListenerError: (error: unknown) => void;
  onModuleError: (error: unknown) => void;
};

const created: FakeSession[] = [];

class FakeSession {
  state: TransportState = "listening";
  pairing: PairingState = { kind: "idle" };
  transmitting = false;
  busy = false;
  /** Mirrors the real session's submission-id allocator. */
  sendId = 0;
  stopped = 0;
  started = 0;
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

  get pairingFailureMessage(): string | null {
    return this.pairing.kind === "failed" ? describePairingFailure(this.pairing.reason) : null;
  }

  start(): void {
    this.started += 1;
  }

  stop(): void {
    this.stopped += 1;
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
    if (refusal !== null) return { ok: false, reason: refusal };
    // Mirrors the real session: the accepted note is published before `send()`
    // returns, so the transcript row exists in the same tick.
    this.sendId += 1;
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
    if (event.type === "pairing") this.pairing = event.state;
    if (event.type === "transport") this.state = event.state;
    this.#handlers?.onEvent(event);
  }

  /**
   * An event whose state disagrees with this session's own getter. The real
   * driver cannot produce one, which is exactly why the controller's precedence
   * between the two halves is worth pinning down.
   */
  spoof(event: SessionEvent): void {
    this.#handlers?.onEvent(event);
  }

  listenerError(error: unknown): void {
    this.#handlers?.onListenerError(error);
  }

  moduleError(error: unknown): void {
    // The real session's machine is in `module_error` by the time the report
    // leaves, so its getter already says so.
    this.state = "module_error";
    this.#handlers?.onModuleError(error);
  }
}

vi.mock("../session", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../session")>();
  return {
    ...actual,
    SoundChatSession: { create: (options: SoundChatSessionOptions) => FakeSession.create(options) },
  };
});

const codec = await openSoundChatCodec();
afterAll(() => {
  codec.close();
});

const contexts: FakeAudioContext[] = [];
const tracks: { stopped: number }[] = [];

class FakeAudioContext {
  sampleRate = 48_000;
  state = "running";
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
let refuseMic = false;

beforeEach(() => {
  contexts.length = 0;
  tracks.length = 0;
  created.length = 0;
  refuseMic = false;
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
  vi.stubGlobal("AudioContext", FakeAudioContext);
  vi.stubGlobal("navigator", {
    mediaDevices: {
      getUserMedia: async () => {
        if (refuseMic) throw new DOMException("Permission denied", "NotAllowedError");
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

const PAIRED: PairingState = {
  kind: "paired",
  code: "ABCD2345",
  role: "displayer",
  peerSalt: new Uint8Array(16),
};
const FAILED: PairingState = {
  kind: "failed",
  code: "ABCD2345",
  role: "displayer",
  reason: "no-peer" satisfies PairingFailureReason,
};

/** Records every phase the controller publishes, in order. */
function phaseTrace(controller: SoundChatUiController): {
  readonly phases: SoundChatUiPhase[];
  readonly stop: () => void;
} {
  const phases: SoundChatUiPhase[] = [];
  const unsubscribe = controller.subscribe(() => {
    const phase = controller.getState().phase;
    if (phases.at(-1) !== phase) phases.push(phase);
  });
  return { phases, stop: unsubscribe };
}

function edges(phases: readonly SoundChatUiPhase[]): string[] {
  const out: string[] = [];
  for (let index = 1; index < phases.length; index += 1) {
    out.push(`${phases[index - 1]}->${phases[index]}`);
  }
  return out;
}

describe("M-1 the phase table, derived rather than asserted", () => {
  it("publishes exactly the transitions the controller's own code path can produce", async () => {
    const observed = new Set<string>();

    // permission -> preparing -> blocked -> permission
    {
      refuseMic = true;
      const controller = newController();
      const trace = phaseTrace(controller);
      await controller.begin("displayer");
      controller.cancel();
      trace.stop();
      for (const edge of edges(trace.phases)) observed.add(edge);
    }
    // permission -> preparing -> pairing -> chat
    {
      refuseMic = false;
      const controller = newController();
      const trace = phaseTrace(controller);
      await controller.begin("displayer");
      const session = created.at(-1) as FakeSession;
      session.emit({ type: "pairing", state: PAIRED });
      trace.stop();
      for (const edge of edges(trace.phases)) observed.add(edge);
    }
    // permission -> preparing -> pairing -> chat -> fatal -> preparing -> pairing
    {
      refuseMic = false;
      const controller = newController();
      const trace = phaseTrace(controller);
      await controller.begin("displayer");
      const session = created.at(-1) as FakeSession;
      session.emit({ type: "pairing", state: PAIRED });
      session.moduleError(new CodecModuleError("codec gone"));
      await controller.restart();
      trace.stop();
      for (const edge of edges(trace.phases)) observed.add(edge);
    }
    // blocked -> preparing (a displayer retrying a start-up failure)
    {
      refuseMic = true;
      const controller = newController();
      const trace = phaseTrace(controller);
      await controller.begin("displayer");
      refuseMic = false;
      await controller.begin("displayer");
      trace.stop();
      for (const edge of edges(trace.phases)) observed.add(edge);
    }
    // pairing -> permission (the pairing panel's role switch) and pairing -> preparing (retry)
    {
      refuseMic = false;
      const controller = newController();
      const trace = phaseTrace(controller);
      await controller.begin("displayer");
      controller.cancel();
      await controller.begin("enterer", "ABCD2345");
      const session = created.at(-1) as FakeSession;
      session.emit({ type: "pairing", state: FAILED });
      await controller.begin("enterer", "ABCD2345");
      trace.stop();
      for (const edge of edges(trace.phases)) observed.add(edge);
    }
    // preparing -> permission (cancel landing while begin() is awaiting the microphone)
    {
      refuseMic = false;
      const controller = newController();
      const trace = phaseTrace(controller);
      const pending = controller.begin("displayer");
      controller.cancel();
      await pending;
      trace.stop();
      for (const edge of edges(trace.phases)) observed.add(edge);
    }

    // The table derived by reading `controller.ts` and confirmed by the trace.
    // `chat -> permission` is absent: `cancel()` performs it, but the chat screen
    // renders no control wired to it (see the next test).
    expect([...observed].sort()).toEqual([
      "blocked->permission",
      "blocked->preparing",
      "chat->fatal",
      "fatal->preparing",
      "pairing->chat",
      "pairing->permission",
      "pairing->preparing",
      "permission->preparing",
      "preparing->blocked",
      "preparing->pairing",
      "preparing->permission",
    ]);
  });

  // Retitled in Phase 4V. The title read `KNOWN DEFECT: chat has no in-app exit
  // except the terminal one`, which Phase 3V finding 2 fixed. The body had been
  // inverted at the time but the title had not, and by this file's own rule a
  // test named `KNOWN DEFECT` is a bug report that goes red the moment somebody
  // fixes it — so the stale title misreported the state of the code.
  it("chat can end the session in place, and returns to permission", async () => {
    const { controller, session } = await live();
    const trace = phaseTrace(controller);
    session.emit({ type: "pairing", state: PAIRED });
    expect(controller.getState().phase).toBe("chat");
    // The controller *has* `cancel()`, and the hook exposes it, but the chat
    // screen renders neither a cancel nor a role switch: `renderPhase` wires
    // `ui.cancel` only into `BlockedPanel.onBack` and
    // `PairingPanel.onSwitchRole`. So from `chat` the only in-app transition is
    // `chat -> fatal` (codec death) and then `fatal -> preparing`. A user who
    // paired with the wrong device cannot get back to the pre-prompt without a
    // full page load.
    controller.cancel();
    trace.stop();
    expect(edges(trace.phases)).toEqual(["chat->permission"]);
    expect(controller.getState().phase).toBe("permission");
  });
});

describe("M-2 `fatal` is not latched against a late session event", () => {
  it("a late `pairing: paired` event cannot un-stick the fatal screen", async () => {
    const { controller, session } = await live();
    session.moduleError(new CodecModuleError("codec gone"));
    expect(controller.getState().phase).toBe("fatal");

    // A PAIR frame already inside the session's serialised chain when the codec
    // died: `#moduleFailed` does not set `#stopped`, so `#handleBlock` resumes,
    // `#onPairFrame` pairs, and the event reaches the controller — which treats
    // `paired` as "enter chat" with no guard on the phase it is in.
    session.emit({
      type: "pairing",
      state: { ...PAIRED, role: "enterer" },
    });
    expect(
      controller.getState().phase,
      "a dead-codec session put itself back into the live chat screen",
    ).toBe("fatal");
  });

  it("a late `outbound sending` event cannot start a ticker inside `fatal`", async () => {
    const { controller, session } = await live();
    session.emit({ type: "pairing", state: PAIRED });
    session.moduleError(new CodecModuleError("codec gone"));
    expect(controller.getState().phase).toBe("fatal");
    expect(vi.getTimerCount(), "the fatal path stops the ticker").toBe(0);

    // The same in-flight pump: `#moduleFailed` reports the outbound as `failed`
    // and then, one `await` later, the pump re-creates `#outbound` and re-emits
    // `sending`. `#onEvent` starts the progress record for it.
    session.busy = true;
    session.emit({
      type: "outbound",
      msgId: 7,
      sendId: 7,
      status: "sending",
      attempts: 1,
      blocks: 2,
      text: "n",
    });
    expect(vi.getTimerCount(), "a 10 Hz ticker is running on a terminal screen").toBe(0);
    expect(session.busy).toBe(true);
    expect(controller.getState().phase).toBe("fatal");
    // The note cannot be published as `sending` on a terminal screen either, and
    // the record that drove that row went with the ticker.
    expect(controller.getState().outbound).toEqual([]);
    expect(controller.getState().progress).toBeNull();
  });

  it("`#onModuleError` is not a second owner of transmitting/busy", async () => {
    const { controller, session } = await live();
    session.emit({ type: "pairing", state: PAIRED });
    session.busy = true;
    session.moduleError(new CodecModuleError("codec gone"));
    // Read through the session's own getters, like every other snapshot, so the
    // terminal screen reports what the session reports rather than a second,
    // disagreeing answer.
    expect(controller.getState().busy).toBe(true);
    expect(controller.getState().transmitting).toBe(session.transmitting);
    // And because `fatal` is latched, no later event can move the machine or
    // re-derive the pair into a different answer.
    session.emit({ type: "message", msgId: 1, text: "late" });
    expect(controller.getState().phase).toBe("fatal");
    expect(controller.getState().busy).toBe(true);
    expect(controller.getState().transmitting).toBe(session.transmitting);
  });
});

describe("M-3 the session's own facts survive a failed `begin()`", () => {
  it("a blocked start-up drops the dead session's pairing, transport and stats", async () => {
    const controller = newController();
    await controller.begin("displayer");
    const first = created.at(-1) as FakeSession;
    first.emit({ type: "pairing", state: PAIRED });
    first.stats.messagesDelivered = 3;
    first.moduleError(new CodecModuleError("codec gone"));
    expect(controller.getState().phase).toBe("fatal");

    // The honest recovery is refused by the browser, so the restart blocks.
    refuseMic = true;
    await controller.restart();
    const state = controller.getState();
    expect(state.phase).toBe("blocked");
    // Reset in `begin()`'s first patch rather than on the success path, because
    // a `begin()` that ends in `blocked` never reaches the success path.
    // `InfoPanel` is rendered in every phase and calls these "This session", so a
    // blocked screen reading "paired, listening, 3 delivered" would be a lie
    // about a session that no longer exists.
    expect(state.pairing.kind, "a blocked screen over a snapshot that says 'paired'").toBe("idle");
    expect("code" in state.pairing ? state.pairing.code : null).toBeNull();
    expect(state.pairingFailure).toBeNull();
    expect(state.transport, "and one still describing the session that just died").toBe("idle");
    expect(state.stats.messagesDelivered, "the dead session's counters, under a new attempt").toBe(
      0,
    );
    expect(state.transmitting).toBe(false);
    expect(state.busy).toBe(false);
    expect(state.progress).toBeNull();
    expect(state.notices).toEqual([]);
  });

  it("clears the same three fields when the restart succeeds, so only the blocked path leaks them", async () => {
    const controller = newController();
    await controller.begin("displayer");
    const first = created.at(-1) as FakeSession;
    first.emit({ type: "pairing", state: PAIRED });
    first.stats.messagesDelivered = 3;
    first.moduleError(new CodecModuleError("codec gone"));
    await controller.restart();
    const state = controller.getState();
    expect(state.phase).toBe("pairing");
    expect(state.pairing.kind).toBe("idle");
    expect(state.transport).toBe("listening");
    expect(state.stats.messagesDelivered).toBe(0);
  });
});

describe("M-4 render combinations the controller publishes that no screen can reach", () => {
  it("publishes a bar while the phase is `pairing`, for a handshake block", async () => {
    const { controller, session } = await live();
    session.state = "transmitting";
    session.emit({ type: "transport", state: "transmitting" });
    const state = controller.getState();
    expect(state.phase).toBe("pairing");
    expect(state.progress, "a progress record for a PAIR frame").not.toBeNull();
    // `TransmitStatus` is rendered only inside the `chat` branch, so this record
    // is computed, ticked at 10 Hz and never shown.
    expect(vi.getTimerCount()).toBe(1);
    controller.cancel();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("the `arming` sentence is gated on four transport states, none of which a real session publishes it in", async () => {
    // The `arming` line in `TransmitStatus` renders for
    // `transmitting && progress === null && transport !== "awaiting_ack"`. Given
    // the three fields, four transport states show it. The real session reaches
    // `transmitting: true` only via `#txBusy` (a window `send()` never publishes
    // — see `deep-p3b-acoustic.test.ts` B-2) or via the transport event that also
    // starts the progress record. This records the structural set; the real-session
    // file is what proves none of it is published.
    const windows: string[] = [];
    for (const [transport, transmitting] of [
      ["listening", true],
      ["awaiting_turn", true],
      ["backoff", true],
      ["hidden_hold", true],
      ["transmitting", true],
      ["awaiting_ack", true],
      ["transmitting", false],
      ["awaiting_ack", false],
    ] as const) {
      const { controller, session } = await live();
      session.emit({ type: "pairing", state: PAIRED });
      session.state = transport;
      session.transmitting = transmitting;
      session.busy = true;
      // The `transmitting` transport event is the only thing that starts a record.
      session.emit({ type: "transport", state: transport });
      const state = controller.getState();
      expect(state.transport).toBe(transport);
      if (state.transmitting && state.progress === null && state.transport !== "awaiting_ack") {
        windows.push(state.transport);
      }
      controller.cancel();
    }
    expect(windows).toEqual(["listening", "awaiting_turn", "backoff", "hidden_hold"]);
    // `transmitting` itself never qualifies: the event that announces it is the
    // event that starts the record, so the bar is already there.
  });

  it("produces `awaiting_ack` with no bar only through a state a real session cannot be in", async () => {
    // `SOUND_CHAT_COPY.transmit.acking` is rendered only for
    // `transport === "awaiting_ack" && progress === null`. The real machine
    // reaches `awaiting_ack` only by `TRANSMIT_DONE` from `transmitting`, and the
    // `transmitting` transport event is what starts the record — so the pairing is
    // unreachable in production and the sentence is dead.
    const { controller, session } = await live();
    session.state = "awaiting_ack";
    session.spoof({ type: "transport", state: "backoff" });
    expect(controller.getState().transport).toBe("awaiting_ack");
    expect(controller.getState().progress, "only reachable by disagreeing with itself").toBeNull();
  });

  it("a restart does not carry the last note's block count into the handshake bar", async () => {
    const { controller, session } = await live();
    session.emit({ type: "pairing", state: PAIRED });
    // A two-block note in flight when the codec dies. `#stopProgress` (which
    // `#onModuleError` now calls) and `#teardownSession` both reset
    // `#pendingBlocks`, so the dead session's note count cannot survive.
    session.emit({
      type: "outbound",
      msgId: 1,
      sendId: 1,
      status: "sending",
      attempts: 1,
      blocks: 2,
      text: "n",
    });
    session.moduleError(new CodecModuleError("codec gone"));
    expect(controller.getState().progress, "a fatal screen shows no bar").toBeNull();

    await controller.restart();
    expect(created.length, "the restart built a second session").toBe(2);
    const next = created.at(-1) as FakeSession;
    // The new session's own PAIR block is one block. `#startProgress` reads the
    // figure left over from the dead session's two-block note.
    next.state = "transmitting";
    next.emit({ type: "transport", state: "transmitting" });
    expect(
      controller.getState().progress?.blocks,
      "a bar sized for the previous session's note",
    ).toBe(1);
  });
});

describe("M-5 hostile and out-of-order input", () => {
  it("takes a spoofed on-air state from the getter, not the event", async () => {
    const { controller, session } = await live();
    session.state = "listening";
    session.spoof({ type: "transport", state: "transmitting" });
    expect(controller.getState().transport).toBe("listening");
    // `#startProgress` decides from the session's own state, not from the event,
    // so a spoofed on-air event that the getter contradicts starts no ticker at
    // all - there is no bar to move, so there is nothing to tick. The same
    // shape as M-2's, closed the same way.
    expect(vi.getTimerCount()).toBe(0);
    expect(controller.getState().progress).toBeNull();
  });

  it("passes every refusal reason the session can produce straight through", async () => {
    const { controller } = await live();
    const seen: SendRefusal[] = [];
    for (const text of ["stop", "module", "queue", ""]) {
      const result = controller.send(text);
      if (!result.ok) seen.push(result.reason);
    }
    expect(seen).toEqual(["stopped", "module-error", "queue-full", "empty"]);
  });

  it("survives a byte figure no real session can produce", async () => {
    const { controller, session } = await live();
    session.emit({ type: "pairing", state: PAIRED });
    for (const blocks of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 1e9]) {
      session.emit({
        type: "outbound",
        msgId: 9,
        sendId: 9,
        status: "sending",
        attempts: 1,
        blocks,
        text: "x",
      });
      const progress = controller.getState().progress;
      if (progress !== null) {
        expect(Number.isFinite(progress.blocks)).toBe(true);
        expect(Number.isFinite(progress.fraction)).toBe(true);
        expect(Number.isFinite(progress.remainingMs)).toBe(true);
      }
    }
  });

  it("never lets one subscriber's exception reach the session's channel", async () => {
    const muted = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const { controller, session } = await live();
      controller.subscribe(() => {
        throw new Error("a subscriber bug");
      });
      expect(() => {
        session.moduleError(new CodecModuleError("codec gone"));
      }).not.toThrow();
      expect(controller.getState().phase).toBe("fatal");
      expect(muted).toHaveBeenCalled();
    } finally {
      muted.mockRestore();
    }
  });

  it("routes our own frame-contract misuse to a different sentence than a dead module", () => {
    expect(classifyFatalError(new CodecUsageError("bad frame"))).toBe("frame-contract");
    expect(classifyFatalError(new CodecModuleError("gone"))).toBe("codec-died");
  });
});
