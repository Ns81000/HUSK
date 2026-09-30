/**
 * The React-free owner of a Sound Chat session, and the single source of truth
 * for everything the UI renders.
 *
 * Why this is not a hook: master plan Section 10.1 class 12. Phases 1 and 2
 * handed forward a session with two public getters (`transmitting`, `busy`) and
 * an event union that nothing consumed, so their real failure modes were
 * structurally untestable. This file is that consumer, and it is deliberately
 * plain TypeScript over the real `SoundChatSession` so it can be driven in
 * process by `controller.test.ts` with the same hostile mocks the session suite
 * already uses — no DOM, no test renderer, no new dependency.
 *
 * What it owns, and why each of these is here rather than in a component:
 * - **Lifecycle.** Microphone permission, the 48000 Hz context, the codec, key
 *   derivation and `session.start()` happen in one place, in one order, so a
 *   failure always has exactly one reason attached to it.
 * - **Teardown.** `dispose()` releases the feed, both media-stream tracks, both
 *   codec instances and the AudioContext, and is safe to call twice (React's dev
 *   double-mount makes that routine). Every path out of the feature goes through
 *   it, so nothing can leak a mic indicator.
 * - **Restart.** `restart()` tears the session down and builds a new one with
 *   the same role and pairing code. It deliberately does *not* call
 *   `session.restart()`: that method refuses (`not-restartable` on a healthy
 *   session, `codec-dead` when the codec is gone) rather than reporting a
 *   success it cannot deliver, and papering over that refusal would be a lie.
 * - **Bounded state.** The transcript keeps at most `MAX_TRANSCRIPT_ENTRIES`
 *   entries and the notice list at most `MAX_NOTICES`, because a long session on
 *   a shared room channel must not grow without limit (Section 10.2 P12).
 * - **Progress.** A real progress bar needs a total, and the total comes from the
 *   session's own `blocks` field on the `outbound` event rather than from the UI
 *   guessing. The clock is ours, so every string it produces says "about".
 */

import {
  createAudioContext,
  ensureRunning,
  requestMicrophoneAccess,
  teardownAudio,
} from "../audio-io";
import { AudioContextRateError, type MicrophoneAccess } from "../audio-io";
import { CodecUsageError, openSoundChatCodec, type SoundChatCodec } from "../codec";
import { CryptoUnavailableError, PairingCodeError } from "../crypto";
import { MessageTooLongError, ProtocolUsageError, type OutboundStatus } from "../protocol";
import type { PairingFailureReason, PairingRole, PairingState } from "../pairing";
import {
  SoundChatSession,
  MAX_PENDING_MESSAGES,
  type SendResult,
  type SessionEvent,
  type SessionStats,
} from "../session";
import type { TransportState } from "../transport-machine";
import { BLOCK_DURATION_MS, measureMessage } from "./budget";
import { SOUND_CHAT_COPY } from "./copy";

export { MAX_PENDING_MESSAGES };
export type { SessionStats };

/** Kept so the transcript is bounded no matter how long the session runs. */
export const MAX_TRANSCRIPT_ENTRIES = 200;
/** Notices are diagnostics, not a log; the newest few are all that is useful. */
export const MAX_NOTICES = 6;

export type SoundChatUiPhase =
  /** Nothing has been requested yet: the microphone pre-prompt is showing. */
  | "permission"
  /** A role was chosen and the stack is being brought up. */
  | "preparing"
  /** The session is live and the handshake has not completed. */
  | "pairing"
  /** Paired: notes can be composed and sent. */
  | "chat"
  /** Start-up failed for a reason the user can fix and retry. */
  | "blocked"
  /** Terminal for this session: only a restart builds a new one. */
  | "fatal";

export type SoundChatBlockKind =
  | "mic-denied"
  | "mic-missing"
  | "mic-unsupported"
  | "device-rate"
  | "bad-code"
  | "crypto-unavailable"
  | "codec-unavailable"
  | "audio-unavailable";

export type SoundChatFatalKind = "codec-died" | "frame-contract";

export type SoundChatBlock = { readonly kind: SoundChatBlockKind; readonly detail: string };
export type SoundChatFatal = { readonly kind: SoundChatFatalKind; readonly detail: string };

/**
 * `seq` is the controller's own render order. The two peers allocate message ids
 * from independent counters seeded by their own session salts, so a sender's
 * `msgId` and a receiver's `msgId` are not comparable and cannot be merged on.
 * One local counter gives the transcript a single honest ordering.
 */
export type OutboundView = {
  readonly seq: number;
  readonly msgId: number;
  readonly text: string;
  readonly status: OutboundStatus;
  readonly attempts: number;
  readonly blocks: number;
};

export type InboundView = { readonly seq: number; readonly msgId: number; readonly text: string };

export type TranscriptEntry =
  | { readonly kind: "outbound"; readonly seq: number; readonly view: OutboundView }
  | { readonly kind: "inbound"; readonly seq: number; readonly view: InboundView };

export type SoundChatNotice = {
  readonly id: number;
  readonly tone: "info" | "warn" | "danger";
  readonly text: string;
};

/** What the progress bar shows. `null` whenever nothing of ours is on the air. */
export type TransmitProgress = {
  readonly blocks: number;
  readonly blockIndex: number;
  readonly fraction: number;
  readonly remainingMs: number;
};

export type SoundChatUiState = {
  readonly phase: SoundChatUiPhase;
  readonly role: PairingRole | null;
  readonly block: SoundChatBlock | null;
  readonly fatal: SoundChatFatal | null;
  readonly transport: TransportState;
  readonly pairing: PairingState;
  /** The displayer's generated code, and the enterer's own, for the readout. */
  readonly code: string | null;
  readonly outbound: readonly OutboundView[];
  readonly inbound: readonly InboundView[];
  readonly notices: readonly SoundChatNotice[];
  /** True while a transmission of ours is starting or on the air. */
  readonly transmitting: boolean;
  /** True while a message of ours is anywhere in the system. */
  readonly busy: boolean;
  readonly progress: TransmitProgress | null;
  readonly stats: SessionStats;
  readonly pairingFailure: string | null;
};

const EMPTY_STATS: SessionStats = {
  blocksDecoded: 0,
  framesUnreadable: 0,
  messagesDelivered: 0,
  duplicatesSuppressed: 0,
  acksSent: 0,
  retries: 0,
  conflicts: 0,
};

const IDLE_PAIRING: PairingState = { kind: "idle" };

/**
 * The three ways the microphone can be unavailable, each with its own sentence.
 * `satisfies` rather than a cast: a new refusal kind the audio layer grows would
 * fail to type here instead of falling through to a wrong copy.
 */
const MIC_BLOCK_KIND = {
  denied: "mic-denied",
  missing: "mic-missing",
  unsupported: "mic-unsupported",
} as const satisfies Record<Exclude<MicrophoneAccess["kind"], "granted">, SoundChatBlockKind>;

function describe(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  return String(error);
}

function clamp(value: number, low: number, high: number): number {
  // NaN-safe on purpose: every comparison against NaN is false, so a plain
  // `min`/`max` pair lets a NaN straight through and it would reach
  // `aria-valuenow="NaN"`. A progress figure that is not a number has no honest
  // rendering, so it is treated as "not started yet".
  if (!Number.isFinite(value)) return low;
  if (value < low) return low;
  if (value > high) return high;
  return value;
}

/**
 * Stops every track of a capture stream.
 *
 * The only reference to a granted `MediaStream` is whoever was handed it, so every
 * path that abandons one has to release it itself. `session.stop()` releases the
 * tracks of a session that started, but a start-up that is superseded, cancelled
 * or disposed *between the grant and `session.start()`* has no feed to stop them
 * through — and nothing else in the process holds the stream at all.
 */
function releaseStream(stream: MediaStream): void {
  for (const track of stream.getTracks()) track.stop();
}

/**
 * The locked 48 kHz context, already running, or the failure that stopped it
 * with everything it created released.
 *
 * Both steps can fail and the second is a real browser refusal — `resume()`
 * rejects with `NotAllowedError` when the autoplay policy will not unmute a
 * context outside a user gesture — and the context that refusal came from is a
 * live device holding an audio graph, so it is closed here rather than being
 * left for a caller that never received a reference to it.
 */
async function openRunningContext(): Promise<AudioContext> {
  const context = createAudioContext();
  try {
    await ensureRunning(context);
  } catch (error) {
    // Rejection-handled: a wrong-rate context is already closed by
    // `createAudioContext`, and Chromium rejects a second `close()`.
    teardownAudio(undefined, context);
    throw error;
  }
  return context;
}

/**
 * The two transport states in which our own audio is genuinely on the air.
 *
 * `transmitting` is when the blocks are being played and `awaiting_ack` is the
 * window after they were scheduled — which is the window the speaker is still
 * playing them in, because the session emits `TRANSMIT_DONE` on *scheduling*, not
 * on completion. `satisfies Record<TransportState, boolean>` rather than a
 * two-value test, so a state the machine grows cannot be silently left out of the
 * rule that decides whether a progress bar is showing.
 */
const ON_AIR = {
  idle: false,
  listening: false,
  transmitting: true,
  awaiting_turn: false,
  awaiting_ack: true,
  backoff: false,
  hidden_hold: false,
  error: false,
  module_error: false,
} as const satisfies Record<TransportState, boolean>;

function isOnAir(state: TransportState): boolean {
  return ON_AIR[state];
}

/**
 * A codec throw and our own broken frame contract both arrive on the session's
 * module channel, and they are different facts with different causes, so they
 * get different copy.
 *
 * `CodecModuleError` is the module itself: unusable for the rest of the page
 * session, by policy. `CodecUsageError` and the protocol's own usage errors are
 * a frame we built or read wrongly — the codec module is fine, but the Rx
 * instance is now permanently de-synchronised, so the session is just as terminal
 * and the *reason* is ours rather than the library's.
 *
 * Exported, and pure, so the mapping is testable without having to destroy a
 * session to produce each error. An error we do not recognise is treated as the
 * module: that is the safe direction, because it demands a restart instead of
 * inviting a retry that cannot work.
 */
export function classifyFatalError(error: unknown): SoundChatFatalKind {
  if (
    error instanceof CodecUsageError ||
    error instanceof ProtocolUsageError ||
    error instanceof MessageTooLongError
  ) {
    return "frame-contract";
  }
  // `CodecModuleError` — and anything unrecognised, because the channel is
  // `unknown`: the safe direction, demanding a restart rather than inviting a
  // retry that cannot work.
  return "codec-died";
}

export class SoundChatUiController {
  #state: SoundChatUiState;
  #listeners = new Set<() => void>();
  #session: SoundChatSession | null = null;
  #codec: SoundChatCodec | null = null;
  #context: AudioContext | null = null;
  /**
   * The granted microphone, held so teardown can release it even when the
   * session never started. `session.stop()` stops the tracks through the capture
   * feed it owns — but a failure *between* the grant and `session.start()`
   * (a refused pairing code, a codec that would not allocate) leaves no feed to
   * stop them through, and the browser's recording indicator would stay lit with
   * no way to clear it. Measured by `controller.test.ts`.
   */
  #stream: MediaStream | null = null;
  #role: PairingRole | null = null;
  /** Kept across a restart so the other device's typed code still matches. */
  #code: string | null = null;
  #disposed = false;
  #noticeId = 0;
  /** One render-order counter for both directions; see `InboundView.seq`. */
  #sequence = 0;
  #progressStartedAt: number | null = null;
  #progressBlocks = 0;
  /**
   * The block count of the message about to be played, taken from the session's
   * own `outbound` event. A one-block note is 1.92 s of sound and a two-block
   * note is 3.84 s, so guessing this is a progress bar that lies; the value the
   * UI cannot know for itself is the one the protocol already reports.
   */
  #pendingBlocks = 0;
  #ticker: ReturnType<typeof setInterval> | null = null;
  /** A generation counter so a slow `begin()` from an abandoned attempt lands
   *  nowhere: two overlapping starts must not leave two sessions alive. */
  #generation = 0;

  constructor() {
    this.#state = {
      phase: "permission",
      role: null,
      block: null,
      fatal: null,
      transport: "idle",
      pairing: IDLE_PAIRING,
      code: null,
      outbound: [],
      inbound: [],
      notices: [],
      transmitting: false,
      busy: false,
      progress: null,
      stats: EMPTY_STATS,
      pairingFailure: null,
    };
  }

  getState = (): SoundChatUiState => this.#state;

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  };

  /**
   * Brings the whole stack up for a role, in the only order that can work: the
   * microphone first (its own prompt is the browser's), then the 48000 Hz
   * context (the platform will not unmute one created outside a user gesture),
   * then the codec, then the session. Every step has its own typed failure, and
   * each becomes a specific reason rather than one generic error.
   */
  async begin(role: PairingRole, code?: string): Promise<void> {
    if (this.#disposed) return;
    const generation = this.#generation + 1;
    this.#generation = generation;
    this.#teardownSession();
    this.#role = role;
    this.#code = code ?? null;
    // Every field a later failure could leave stale is reset here, not on the
    // success path. A `begin()` that ends in `blocked` still runs this line, so
    // resetting only after the session is created would publish the *dead*
    // session's pairing, transport and stats next to the new failure \u2014 a
    // blocked screen reading "This session: paired, listening, 3 delivered".
    this.#patch({
      phase: "preparing",
      role,
      block: null,
      fatal: null,
      code: code ?? null,
      pairing: IDLE_PAIRING,
      pairingFailure: null,
      transport: "idle",
      stats: EMPTY_STATS,
      transmitting: false,
      busy: false,
      progress: null,
    });

    const access = await requestMicrophoneAccess();
    if (this.#stale(generation)) {
      // A grant that arrives after this attempt was superseded is still a live
      // capture track, and this `access` local is the last reference to it in the
      // whole process. Nothing below will ever see it, so nothing below would
      // ever stop it, and the browser's recording indicator would stay lit for the
      // life of the page behind a session that is not there.
      if (access.kind === "granted") releaseStream(access.stream);
      return;
    }
    if (access.kind !== "granted") {
      this.#patch({
        phase: "blocked",
        block: {
          kind: MIC_BLOCK_KIND[access.kind],
          detail: access.cause,
        },
        code: null,
      });
      return;
    }

    let context: AudioContext;
    try {
      context = await openRunningContext();
    } catch (error) {
      releaseStream(access.stream);
      if (this.#stale(generation)) return;
      this.#patch({
        phase: "blocked",
        block: {
          kind: error instanceof AudioContextRateError ? "device-rate" : "audio-unavailable",
          detail: describe(error),
        },
        code: null,
      });
      return;
    }

    let codec: SoundChatCodec;
    try {
      codec = await openSoundChatCodec({
        sampleRateInp: context.sampleRate,
        sampleRateOut: context.sampleRate,
      });
    } catch (error) {
      teardownAudio(undefined, context);
      releaseStream(access.stream);
      if (this.#stale(generation)) return;
      this.#patch({
        phase: "blocked",
        block: { kind: "codec-unavailable", detail: describe(error) },
        code: null,
      });
      return;
    }
    if (this.#stale(generation)) {
      codec.close();
      teardownAudio(undefined, context);
      releaseStream(access.stream);
      return;
    }

    this.#context = context;
    this.#codec = codec;
    this.#stream = access.stream;

    let session: SoundChatSession;
    try {
      // The enterer's code is passed only when there is one, so a displayer's
      // options object has no `pairingCode` key at all — which is how the session
      // knows to generate its own. Built as two statements rather than a
      // conditional spread, so an omitted key cannot hide behind an empty object.
      const sessionOptions = {
        codec,
        context,
        stream: access.stream,
        role,
        onEvent: (event: SessionEvent) => this.#fromSession(generation, event),
        onListenerError: (error: unknown) =>
          this.#sessionChannel(generation, () =>
            this.#notice(
              "warn",
              `Sound Chat recovered from an internal error (${describe(error)}).`,
            ),
          ),
        onModuleError: (error: unknown) =>
          this.#sessionChannel(generation, () => this.#onModuleError(error)),
      };
      session =
        code === undefined
          ? await SoundChatSession.create(sessionOptions)
          : await SoundChatSession.create({ ...sessionOptions, pairingCode: code });
    } catch (error) {
      this.#teardownSession();
      if (this.#stale(generation)) return;
      this.#patch({
        phase: "blocked",
        block: {
          kind:
            error instanceof PairingCodeError
              ? "bad-code"
              : error instanceof CryptoUnavailableError
                ? "crypto-unavailable"
                : "codec-unavailable",
          detail: describe(error),
        },
        code: null,
      });
      // A code the protocol already named invalid is not kept for a retry: it
      // would fail the same way again and tell the user nothing new.
      if (error instanceof PairingCodeError) this.#code = null;
      return;
    }
    if (this.#stale(generation)) {
      session.stop();
      return;
    }

    this.#session = session;
    this.#code = session.pairingCode;
    this.#patch({
      phase: "pairing",
      pairing: session.pairing,
      code: session.pairingCode,
      pairingFailure: session.pairingFailureMessage,
      transport: session.state,
      outbound: [],
      inbound: [],
      notices: [],
    });
    session.start();
    this.#refresh();
  }

  /**
   * The real "restart Sound Chat" affordance: a full teardown followed by a new
   * session. The pairing code survives it on purpose — it is the shared secret
   * the other device is holding, so silently changing it would strand them —
   * while everything else is new, including the session salt (Section 10.2 P2:
   * no key+nonce reuse across sessions).
   */
  async restart(): Promise<void> {
    if (this.#disposed) return;
    const role = this.#role ?? "displayer";
    const code = this.#code ?? undefined;
    await this.begin(role, code);
  }

  /** Back to the pre-prompt: everything released, nothing kept. */
  cancel(): void {
    if (this.#disposed) return;
    this.#generation += 1;
    this.#role = null;
    this.#code = null;
    this.#teardownSession();
    this.#patch({
      phase: "permission",
      role: null,
      code: null,
      block: null,
      fatal: null,
      transport: "idle",
      pairing: IDLE_PAIRING,
      pairingFailure: null,
      outbound: [],
      inbound: [],
      notices: [],
      transmitting: false,
      busy: false,
      progress: null,
      stats: EMPTY_STATS,
    });
  }

  /** Releases everything. Idempotent: React's dev double-mount calls it twice. */
  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#generation += 1;
    this.#role = null;
    this.#code = null;
    this.#teardownSession();
    this.#listeners.clear();
  }

  /**
   * The budget is checked before the session, so an over-long note reports the
   * reason that is a property of the note rather than a property of the session's
   * state. And a session that is not there reports *why* it is not there: a
   * disposed controller says `stopped`, an unstarted one says `not-paired` —
   * which is the sentence the composer already shows for "pairing has to finish
   * first", rather than an internal-sounding `stopped` the user cannot act on.
   */
  send(text: string): SendResult {
    const budget = measureMessage(text);
    if (budget.bytes === 0) return { ok: false, reason: "empty" };
    if (!budget.fits) return { ok: false, reason: "too-long" };
    const session = this.#session;
    if (session === null) return { ok: false, reason: this.#disposed ? "stopped" : "not-paired" };
    return session.send(text);
  }

  clearNotices(): void {
    if (this.#state.notices.length === 0) return;
    this.#patch({ notices: [] });
  }

  #stale(generation: number): boolean {
    return this.#disposed || generation !== this.#generation;
  }

  #nextSeq(): number {
    this.#sequence += 1;
    return this.#sequence;
  }

  #notice(tone: SoundChatNotice["tone"], text: string): void {
    this.#noticeId += 1;
    const notice: SoundChatNotice = { id: this.#noticeId, tone, text };
    const notices = [...this.#state.notices, notice].slice(-MAX_NOTICES);
    this.#patch({ notices });
  }

  #teardownSession(): void {
    this.#stopTicker();
    this.#progressStartedAt = null;
    this.#progressBlocks = 0;
    // The dead session's note count must not survive into the next attempt's
    // handshake block, or a fresh 1-block PAIR opens a 2-block bar.
    this.#pendingBlocks = 0;
    // Order matters: the session releases the capture feed and stops the media
    // tracks, then the codec frees its two instances, then the context closes.
    // Each step is individually safe with partial state.
    try {
      this.#session?.stop();
    } catch {
      // A teardown that throws must not strand the resources after it.
    }
    this.#session = null;
    try {
      this.#codec?.close();
    } catch {
      // Freeing a trapped instance is best-effort by definition.
    }
    this.#codec = null;
    teardownAudio(undefined, this.#context ?? undefined);
    this.#context = null;
    // The tracks are stopped unconditionally, and after the session, because a
    // session that never started has no feed of its own to release them through.
    for (const track of this.#stream?.getTracks() ?? []) track.stop();
    this.#stream = null;
  }

  /**
   * The single publish point for every piece of state.
   *
   * A subscriber is notified inside a `try` because it is called from three very
   * different places — a React event handler, the 100 ms ticker, and the audio
   * callback and `setTimeout`s the session runs — and a subscriber's own bug
   * escaping out of any of them would be a bug in *this* feature: an exception
   * out of `cancel()` lands in a click handler, and an exception out of
   * `begin()`'s first patch is a rejection of a promise the hook fired with
   * `void`. It would also stop every subscriber after it from ever being told.
   */
  #patch(partial: Partial<SoundChatUiState>): void {
    if (this.#disposed) return;
    this.#state = { ...this.#state, ...partial };
    for (const listener of this.#listeners) {
      try {
        listener();
      } catch (error) {
        console.error("Sound Chat: a Sound Chat UI subscriber threw", error);
      }
    }
  }

  #stopTicker(): void {
    if (this.#ticker === null) return;
    clearInterval(this.#ticker);
    this.#ticker = null;
  }

  /**
   * A session callback that is fenced by the generation that created the session.
   *
   * `session.stop()` already drops every block still inside its async chain, so a
   * torn-down session should emit nothing. This is the second half of that
   * guarantee, because the session's own guards live in a module this file does
   * not own: without the fence, a session superseded by a restart could still
   * put a note into the *new* transcript or a warning on the new screen.
   */
  #fromSession(generation: number, event: SessionEvent): void {
    if (this.#stale(generation)) return;
    this.#onEvent(event);
  }

  #sessionChannel(generation: number, report: () => void): void {
    if (this.#stale(generation)) return;
    report();
  }

  #onEvent(event: SessionEvent): void {
    if (this.#disposed) return;
    // Latched. A PAIR frame already inside the session's chain when the codec
    // died still arrives, and `case "pairing"` below would swap the terminal
    // panel for a live-looking chat screen over a codec that is gone. A terminal
    // phase is answered by its own controls and nothing else, so no event can
    // move the machine out of one.
    if (this.#state.phase === "fatal") return;
    switch (event.type) {
      case "transport":
        // The bar lives from the moment a transmission is claimed until the
        // transport leaves the two states in which our audio is on the air.
        // `awaiting_ack` is one of them: the blocks are scheduled but the speaker
        // is still playing them, and the sentence that takes over when the window
        // closes is "waiting for the other device to confirm".
        if (isOnAir(event.state)) this.#startProgress();
        else this.#stopProgress();
        this.#patch({ transport: event.state });
        break;
      case "pairing": {
        const pairingFailure =
          event.state.kind === "failed" ? this.#pairingFailureText(event.state.reason) : null;
        this.#patch({
          pairing: event.state,
          pairingFailure,
          phase: event.state.kind === "paired" ? "chat" : this.#state.phase,
        });
        break;
      }
      case "message":
        this.#patch({
          inbound: [
            ...this.#state.inbound,
            { seq: this.#nextSeq(), msgId: event.msgId, text: event.text },
          ].slice(-MAX_TRANSCRIPT_ENTRIES),
        });
        break;
      case "outbound": {
        if (event.status === "sending") {
          this.#pendingBlocks = event.blocks;
          // The earliest honest point to start the bar: the pump has claimed this
          // message and the block count is now known, which is the one figure the
          // UI cannot work out for itself.
          //
          // Restarted rather than made idempotent, because a *retry* is a second
          // audible transmission from the top: the blocks really are scheduled
          // again, `blocks x 1.92 s` again, and a bar left running from the
          // abandoned attempt stands still for the whole retry. `TRANSMIT_BEGIN`
          // for the retry lands first and finds the clock already set, which is
          // why the record is keyed on the claim and not on the transport.
          this.#startProgress(true);
        }
        const rest = this.#state.outbound.filter((entry) => entry.msgId !== event.msgId);
        // The event is self-describing, so a status change only updates the
        // fields that changed and keeps the transcript position it already had.
        const existing = this.#state.outbound.find((entry) => entry.msgId === event.msgId);
        const next: OutboundView = {
          seq: existing?.seq ?? this.#nextSeq(),
          msgId: event.msgId,
          text: event.text,
          status: event.status,
          attempts: event.attempts,
          blocks: event.blocks,
        };
        this.#patch({
          outbound: [...rest, next]
            .sort((left, right) => left.seq - right.seq)
            .slice(-MAX_TRANSCRIPT_ENTRIES),
        });
        break;
      }
      case "heard-unreadable":
        // P6: the codec produced a block and this pairing cannot read it. That
        // is a different fact from silence, and the copy says so.
        this.#notice("warn", SOUND_CHAT_COPY.transmit.unreadable);
        break;
      default:
        break;
    }
    this.#refresh();
  }

  #pairingFailureText(reason: PairingFailureReason): string {
    return this.#session?.pairingFailureMessage ?? `Pairing did not complete (${reason}).`;
  }

  /**
   * A codec throw and our own broken frame contract both land here, and they
   * are different facts with different causes, so they get different copy.
   * `CodecModuleError` is the module itself (unusable for the page session, by
   * policy); `CodecUsageError` and the protocol's own usage errors are a frame
   * we built or read wrongly, which leaves the Rx instance permanently
   * de-synchronised even though the module is fine.
   */
  #onModuleError(error: unknown): void {
    if (this.#disposed) return;
    const kind = classifyFatalError(error);
    this.#patch({
      phase: "fatal",
      fatal: { kind, detail: describe(error) },
      // Not hard-coded: these three are the session's, read through `#refresh`'s
      // getters like every other snapshot, so a second owner cannot disagree
      // with the first about whether we are still talking.
      transmitting: this.#session?.transmitting ?? false,
      busy: this.#session?.busy ?? false,
    });
    // A note the pump had claimed but that never went on the air cannot keep
    // reading "Playing" on a terminal screen, and the record that drives that
    // row has to go with it. `failed` is the honest status: the attempt ended
    // without the other device acknowledging anything.
    if (this.#state.outbound.some((entry) => entry.status === "sending")) {
      this.#patch({
        outbound: this.#state.outbound.map((entry) =>
          entry.status === "sending" ? { ...entry, status: "failed" as const } : entry,
        ),
      });
    }
    this.#stopProgress();
  }

  /**
   * Re-reads the two public getters the session exposes for exactly this
   * purpose. Everything the UI shows about "are we talking" comes from here, so
   * no component ever has to infer it from a boolean of its own.
   */
  #refresh(): void {
    if (this.#disposed) return;
    const session = this.#session;
    const transmitting = session?.transmitting ?? false;
    const busy = session?.busy ?? false;
    const stats = session?.stats ?? EMPTY_STATS;
    const transport = session?.state ?? "idle";
    const pairing = session?.pairing ?? IDLE_PAIRING;
    this.#patch({
      transmitting,
      busy,
      stats,
      transport,
      pairing,
      progress: this.#progress(isOnAir(transport)),
    });
  }

  #startProgress(restart = false): void {
    if (this.#disposed) return;
    // A claim while our audio is *not* on the air \u2014 the tab is hidden, so the
    // session is holding the transmission rather than playing it \u2014 starts no
    // record and no ticker: there is no bar to move, and `#stopProgress` is not
    // reachable until the tab is shown again. The `VISIBLE` event that follows
    // is an on-air transport event, so it starts the record then, with the
    // pending block count still set.
    if (!isOnAir(this.#session?.state ?? "idle")) return;
    // Idempotent unless explicitly restarted: the `outbound` event starts the
    // record and the `transmitting` transport event that follows must not restart
    // its clock.
    if (this.#progressStartedAt !== null && !restart) return;
    const blocks = this.#pendingBlocks > 0 ? this.#pendingBlocks : 1;
    this.#progressBlocks = blocks;
    this.#progressStartedAt = this.#context?.currentTime ?? 0;
    if (this.#ticker !== null) return;
    // Ticking only while something of ours is on the air: a timer that ran for the
    // life of the page would be a resource leak for no benefit.
    this.#ticker = setInterval(() => this.#refresh(), 100);
  }

  #stopProgress(): void {
    this.#progressStartedAt = null;
    this.#progressBlocks = 0;
    this.#pendingBlocks = 0;
    this.#stopTicker();
    if (!this.#disposed && this.#state.progress !== null) this.#patch({ progress: null });
  }

  /**
   * How far through our own audio we are, measured on the AudioContext clock.
   *
   * NOT driven by `session.transmitting`, which was the first thing tried and is
   * wrong: the session emits `TRANSMIT_DONE` as soon as the blocks are
   * *scheduled*, so a bar driven by it jumps from 0% to done in a millisecond
   * and then stands still for the whole 1.92 s (or 3.84 s) the speaker is really
   * playing. The AudioContext clock is the clock the schedule was built on, and
   * the scheduled blocks really do occupy exactly `blocks x BLOCK_DURATION_MS` of
   * it — so this is the one figure here that measures our own audio rather than
   * estimating it. It still says nothing about what the peer has decoded, which
   * is why every string drawn from it says "about".
   */
  #progress(onAir: boolean): TransmitProgress | null {
    if (!onAir || this.#progressStartedAt === null) return null;
    const blocks = this.#progressBlocks > 0 ? this.#progressBlocks : 1;
    const totalMs = blocks * BLOCK_DURATION_MS;
    const elapsedMs = ((this.#context?.currentTime ?? 0) - this.#progressStartedAt) * 1_000;
    const fraction = clamp(elapsedMs / totalMs, 0, 1);
    const blockIndex = clamp(Math.floor(fraction * blocks) + 1, 1, blocks);
    return {
      blocks,
      blockIndex,
      fraction,
      // Clamped like `fraction` and `blockIndex` rather than `Math.max(0, \u2026)`:
      // `Math.max(0, NaN)` is `NaN`, which renders as "about 0 seconds left" for a
      // block that has not started.
      remainingMs: clamp(totalMs - elapsedMs, 0, totalMs),
    };
  }
}
