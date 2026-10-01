/**
 * The Sound Chat session driver: one owner of the Rx feed, the codec, the
 * timers and the transport machine, with the Phase 2 protocol wired to it.
 *
 * What it guarantees (the contract Phase 3 builds its UI on):
 * - it is the *only* thing that starts audio; every transmission goes through
 *   `transmitAndPause`, so the Rx feed is paused for the exact window plus tail
 *   and we never decode ourselves;
 * - the transport machine is the single source of truth for what the radio is
 *   doing — no callback has to infer it from a boolean;
 * - three failure kinds stay apart (master plan Section 10.1 class 1): a codec
 *   throw stops the session as `module_error` and reaches `onModuleError`; our
 *   own misuse is reported the same way but never latches the codec; an
 *   exception thrown by *this* session's event consumer goes to
 *   `onListenerError` (or `console.error`) and the feed keeps running;
 * - pairing is a separate explicit machine; nothing is transmitted until the
 *   peer's key check has passed, and the pairing code itself never goes on air.
 *
 * What it does *not* do: no UI, no persistence, no cross-session storage. Every
 * buffer it keeps is bounded (message ids never wrap, the outbound queue and the
 * assembled-block state have hard caps, timers are cleared on stop).
 *
 * Timing is derived from the measured medium (Phase 0: one 64-byte block is
 * 90 frames x 1024 / 48000 = 1920 ms of audio) rather than from the network
 * chat's fixed 10 s ack window:
 * - ACK round trip: peer decodes at the end of our block (~0.03 s), pauses its
 *   own Rx for `BLOCK_DURATION_MS` + 0.5 s tail while it transmits the ACK
 *   (`BLOCK_DURATION_MS` of audio), and we decode at the end of that.
 *   A complete message is acked in ~1.95 s; a *partial* one waits
 *   `PARTIAL_ACK_DELAY_MS` (2220 ms, past the point where a second block would
 *   have been decoded) and is then acked, so ~4.15 s. `ACK_TIMEOUT_MS` is
 *   2 x 1920 + `TURN_GAP_MS` (700) + 1920 + 1000 = 7460 ms, sized for the
 *   *longest* message the cap allows: 3.8x the fast path and +3.3 s over the
 *   slow one. The turn gap is inside the window on purpose — a reply is only
 *   heard after the peer's Rx feed reopens.
 * - pairing: the enterer's confirmation window is 2 blocks + 2 s, and the
 *   displayer's listen stays open for `PAIR_PEER_TIMEOUT_MS` because a human is
 *   typing a code into the other device.
 */

import { onVisibilityChange, startListening, transmitAndPause } from "./audio-io";
import type { ListenHandle, Unsubscribe } from "./audio-io";
import type { SoundChatCodec } from "./codec";
import {
  derivePairingKeys,
  generatePairingCode,
  generatePairChallenge,
  generateSessionSalt,
  validatePairingCode,
} from "./crypto";
import type { PairingKeys, RandomSource } from "./crypto";
import {
  describePairingFailure,
  isPaired,
  pairingTransition,
  roleToPeerId,
  type PairingRole,
  type PairingState,
} from "./pairing";
import {
  FrameCodec,
  InboundAssembler,
  MAX_MESSAGE_BLOCKS,
  MAX_MESSAGE_PLAINTEXT_BYTES,
  MAX_SEND_ATTEMPTS,
  MessageIdAllocator,
  applyAck,
  blocksForPlaintextBytes,
  decideRetry,
  fullMask,
  pendingBlocks,
  type FrameRejection,
  type OutboundMessage,
  type OutboundStatus,
  type ParsedFrame,
} from "./protocol";
import { transition, type TransportEvent, type TransportState } from "./transport-machine";

/** Measured: 90 frames x 1024 samples / 48000 Hz. */
export const BLOCK_DURATION_MS = 1_920;
/** The same measurement on the AudioContext clock the schedule is built on. */
export const BLOCK_DURATION_SECONDS = BLOCK_DURATION_MS / 1_000;
/**
 * Scheduling head-room. `AudioBufferSourceNode.start(when)` treats a `when` in
 * the past as "now", which would collapse a multi-block schedule back onto one
 * instant — so every transmission starts a little into the future.
 */
export const TRANSMIT_LEAD_SECONDS = 0.05;
/**
 * The gap a replying transmission must leave after it *heard* something.
 *
 * `transmitAndPause` keeps a sender's own Rx feed closed for its whole block
 * plus `RX_PAUSE_TAIL_SECONDS` (0.5 s, measured in Phase 0), counted from the
 * moment its transmission began. A block takes 1.92 s, so the peer resumes
 * listening 0.5 s *after* we decoded its block — and a block only decodes once
 * 90 whole frames have been fed. A reply that starts immediately is therefore
 * 0.5 s too early and the peer never accumulates a full window: it hears 66 of
 * our 90 frames and decodes nothing. Waiting 700 ms (0.5 s of tail + 200 ms of
 * decode/scheduling margin) puts the whole reply inside the peer's window.
 */
export const TURN_GAP_MS = 700;
/**
 * The ACK wait, sized for the *longest* message the cap allows.
 *
 * The timer is armed when the audio is *scheduled*, not when it finishes, so the
 * window has to cover the whole round trip from the first sample leaving us:
 * our full transmission (up to 2 blocks), the peer's decode (~0.03 s), the turn
 * gap, the peer's own ACK block, and its decode. That is
 * `2 x 1920 + 700 + 1920 + 1000 = 7460 ms`. A constant sized for a single block
 * (5540 ms) timed out every 2-block message: the ACK then landed while the
 * machine was in `backoff`, where `ACK_RECEIVED` is a no-op, so the sender
 * retried and finally reported a failure for a message the peer had rendered
 * (P2V finding F4, measured in Phase 2V).
 */
export const ACK_TIMEOUT_MS =
  BLOCK_DURATION_MS * MAX_MESSAGE_BLOCKS + TURN_GAP_MS + BLOCK_DURATION_MS + 1_000;
/**
 * How long to wait before answering a partially-received message.
 *
 * A sender's own Rx feed is shut for its whole transmission plus the 0.5 s tail,
 * so an answer sent too early lands in a window that cannot decode: a one-block
 * sender reopens after 1920 + 500 = 2420 ms, and a two-block sender after
 * 3840 + 500 = 4340 ms. A single fixed delay cannot serve both — measured, the
 * 1-block delay put a two-block sender's answer 150 ms *inside* its closed
 * window, so it had to retransmit all 84 bytes. `#schedulePartialAck` therefore
 * scales this by the block count the answer is about.
 */
export const PARTIAL_ACK_DELAY_MS = BLOCK_DURATION_MS + 300;
export const BACKOFF_MIN_MS = 400;
export const BACKOFF_MAX_MS = 1_200;
export const PAIR_CONFIRM_TIMEOUT_MS = BLOCK_DURATION_MS * 2 + 2_000;
export const PAIR_PEER_TIMEOUT_MS = 90_000;
/** Bounded queue: a user cannot pile up messages faster than the air can carry. */
export const MAX_PENDING_MESSAGES = 4;
/** Bounded: how many "heard something unreadable" windows may extend an ACK wait. */
export const MAX_ACK_EXTENSIONS = 2;

export type SessionStats = {
  blocksDecoded: number;
  framesUnreadable: number;
  messagesDelivered: number;
  duplicatesSuppressed: number;
  conflicts: number;
  acksSent: number;
  retries: number;
};

export type SessionEvent =
  | { type: "transport"; state: TransportState }
  | { type: "pairing"; state: PairingState }
  | { type: "message"; msgId: number; text: string }
  /**
   * One of *our* messages, reported every time its status changes.
   *
   * `text` and `blockCount` are part of the event rather than something the
   * consumer reconstructs. `blockCount` is the only honest source for a transmit
   * progress bar's total (a one-block note is 1.92 s of sound and a two-block
   * note is 3.84 s, and guessing wrong is a progress bar that lies), and `text`
   * is what stops the consumer from having to pair an event up with the
   * submission it belongs to by position — a submission the pump rejects before
   * it allocates a `msgId` would otherwise shift every later pairing and put the
   * wrong words under a "delivered" badge. This is master plan Section 10.1
   * class 12: a phase-boundary interface whose real consumer did not exist yet,
   * stated explicitly instead of left implicit. The plaintext is already in
   * memory on both sides, is never logged and never persisted.
   */
  | {
      type: "outbound";
      /**
       * The submission's identity for its whole life, allocated by `send()`.
       * This — not `msgId` — is what a consumer keys a transcript row on.
       */
      readonly sendId: number;
      /**
       * The wire id, or `null` while the note is only queued. It is nulled
       * exactly once, on the `queued` event, and never again.
       */
      readonly msgId: number | null;
      status: OutboundStatus;
      attempts: number;
      blocks: number;
      text: string;
    }
  | {
      type: "heard-unreadable";
      /** Why the block could not be read; `conflicting-block` is authenticated but inconsistent. */
      reason: FrameRejection | "conflicting-block";
      count: number;
    };

export type SendRefusal =
  "not-paired" | "empty" | "too-long" | "queue-full" | "module-error" | "stopped";

export type SendResult =
  { ok: true; queued: boolean; readonly sendId: number } | { ok: false; reason: SendRefusal };

export type SoundChatSessionOptions = {
  codec: SoundChatCodec;
  context: AudioContext;
  stream: MediaStream;
  role: PairingRole;
  /** The displayer may omit this and have a code generated for it. */
  pairingCode?: string;
  /**
   * Pre-derived keys for `pairingCode`, when the caller already has them.
   *
   * Derivation is **600 000 PBKDF2 iterations**, measured at ~150 ms on the
   * libuv threadpool, and it is a pure function of the code. A suite that builds
   * twenty sessions therefore spends ~3 s of the four shared threads on
   * re-deriving the same handful of codes, which loads the pool hard enough to
   * tip unrelated timing-sensitive suites over their deadlines — measured: a new
   * 19-session suite added one failure to the full run on 2 of 3 occasions, while
   * the baseline without it was 54/54 green.
   *
   * This is an injection point, not a cache: nothing here retains a derived key,
   * so the property P9 depends on — no key material held anywhere but the caller's
   * own closure — is unchanged, and the production path still derives.
   */
  keys?: PairingKeys;
  random?: RandomSource;
  onEvent?: (event: SessionEvent) => void;
  /** A thrown consumer of `onEvent`: reported here, never fatal. */
  onListenerError?: (error: unknown) => void;
  /** The codec died, or our own frame contract broke. Terminal for the session. */
  onModuleError?: (error: unknown) => void;
};

const encoder = new TextEncoder();
const decoder = new TextDecoder();

type TimerKey = "ack" | "backoff" | "partialAck" | "pair" | "quiet";
type TimerSlot = ReturnType<typeof setTimeout> | undefined;

/**
 * Every session timer, in one named owner. A class rather than a bare record so
 * the key set is closed and each slot keeps the exact type `setTimeout` returns.
 */
class TimerSlots {
  ack: TimerSlot = undefined;
  backoff: TimerSlot = undefined;
  partialAck: TimerSlot = undefined;
  pair: TimerSlot = undefined;
  quiet: TimerSlot = undefined;

  read(key: TimerKey): TimerSlot {
    return this[key];
  }

  clear(key: TimerKey): void {
    this[key] = undefined;
  }
}

/** How many times one delivered message may be acknowledged again. */
export const MAX_RE_ACKS_PER_MESSAGE = 2;

/**
 * A bounded budget for re-acknowledging a message we have already rendered.
 *
 * The codec redelivers every block 2-4 times, so one re-ACK per redelivery is
 * what stops a lost acknowledgement looping the sender. But the *turn* machine
 * only caps the rate, not the total: an attacker replaying one recording could
 * otherwise keep us transmitting an ACK indefinitely. Two extra ACKs per message
 * cover the measured redelivery count with room to spare and bound the loop
 * (Section 10.2 P12).
 */
class ReAckBudget {
  readonly #used = new Map<number, number>();
  #highWater = -1;

  /** True while another re-ACK is allowed; consumes one when it is. */
  take(msgId: number): boolean {
    if (msgId <= this.#highWater) {
      const used = this.#used.get(msgId) ?? 0;
      if (used >= MAX_RE_ACKS_PER_MESSAGE) return false;
      this.#used.set(msgId, used + 1);
      return true;
    }
    // A new high-water mark retires everything below it, so the map holds at
    // most the messages above the mark and never grows with session length.
    this.#used.clear();
    this.#highWater = msgId;
    this.#used.set(msgId, 1);
    return true;
  }

  clear(): void {
    this.#used.clear();
    this.#highWater = -1;
  }

  get size(): number {
    return this.#used.size;
  }
}

/**
 * Whether the page is hidden right now. `onVisibilityChange` is a change-only
 * subscription, so the initial state has to be read once by whoever starts.
 */
function documentIsHidden(): boolean {
  if (typeof document === "undefined") return false;
  return document.visibilityState === "hidden";
}

/** Branch-free byte equality — a challenge is compared like a tag, not a string. */
function constantTimeEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= (left[index] ?? 0) ^ (right[index] ?? 0);
  }
  return difference === 0;
}

/**
 * The self-describing form of an outbound status change, so every report site
 * carries the same fields. `blocks` and `text` exist for the UI's honest
 * progress bar and for exact attribution (see the `outbound` event's contract).
 */
function outboundEvent(
  outbound: OutboundMessage,
  status: OutboundStatus,
): Extract<SessionEvent, { type: "outbound" }> {
  return {
    type: "outbound",
    sendId: outbound.sendId,
    msgId: outbound.msgId,
    status,
    attempts: outbound.attempts,
    blocks: outbound.blockCount,
    text: decoder.decode(outbound.plaintext),
  };
}

/**
 * The one event for a note that has been accepted but not yet claimed.
 *
 * Published from `send()`, synchronously, before it returns, so the transcript
 * row exists in the same tick the person pressed Send — and published by the
 * session rather than by the UI, so the queue has exactly one owner. The `msgId`
 * is `null` and the blocks are counted from the same `measureBlocks` the pump
 * will use, so the two can never disagree about how long the note will take.
 */
function queuedEvent(sendId: number, text: string): Extract<SessionEvent, { type: "outbound" }> {
  return {
    type: "outbound",
    sendId,
    msgId: null,
    status: "queued",
    attempts: 0,
    blocks: blocksForPlaintextBytes(encoder.encode(text).length) ?? 0,
    text,
  };
}

export class SoundChatSession {
  readonly #options: SoundChatSessionOptions;
  readonly #wire: FrameCodec;
  readonly #assembler = new InboundAssembler();
  readonly #ids: MessageIdAllocator;
  readonly #code: string;
  #state: TransportState = "idle";
  #pairing: PairingState = { kind: "idle" };
  #outbound: OutboundMessage | null = null;
  /** True while `#pump` owns the head of the queue, across its `await`s. */
  #pumping = false;
  /**
   * True from the moment we begin building a transmission until it is all on the
   * air. Set by the PAIR path as well as the message path, so a caller can never
   * read a half-built block set as "nothing to send".
   */
  #txBusy = false;
  /**
   * The queue, as submissions rather than bare strings.
   *
   * `sendId` is allocated at accept time and is what a consumer keys a transcript
   * row on, because `msgId` does not exist until the pump has sealed the note.
   * Carrying the pair rather than just the string is what lets a queued row and
   * its later row be provably the same note.
   */
  #pending: { readonly sendId: number; readonly text: string }[] = [];
  /**
   * The next submission id. Monotonic, never reused within a session, and not a
   * wire value, so there is no 16-bit ceiling for it to reach.
   */
  #nextSendId = 0;
  /**
   * A partial acknowledgement owed but not yet on the air.
   *
   * `blockCount` is the number of blocks the *sender* is putting out, which is
   * what sizes the wait: its Rx feed is shut for all of them, so the answer has
   * to outlast the whole transmission rather than one block.
   */
  #partialAck: { msgId: number; mask: number; blockCount: number } | null = null;
  #ackExtensions = 0;
  /**
   * The handshake challenge, once we have one: invented by the enterer, echoed
   * by the displayer. `null` means "we have not initiated", which is what lets
   * the displayer accept whatever challenge it is given and then pin it.
   */
  #pairChallenge: Uint8Array | null = null;
  /** Reported once; a module failure is terminal, so it cannot repeat. */
  #moduleFailureReported = false;
  /**
   * How many times each delivered msgId may be re-acknowledged, and the highest
   * msgId seen. Bounded by construction (P2V finding 9): without it, anyone who
   * can play one recording can make us transmit an ACK for as long as they keep
   * playing it.
   */
  readonly #reAckBudget = new ReAckBudget();
  /**
   * The `(msgId, mask)` ACKs already acted on for the message now in flight.
   *
   * The codec redelivers each block 2-4 times, so one partial ACK is delivered
   * 2-4 times and every copy used to spend another of the sender's three
   * attempts on byte-identical audio that then overlapped itself. Cleared
   * whenever `#outbound` is cleared or replaced, so it holds at most the
   * distinct masks of one message: bounded by construction (Section 10.2 P12).
   */
  readonly #handledAcks = new Set<string>();
  #listen: ListenHandle | null = null;
  #unsubscribe: Unsubscribe | null = null;
  /**
   * "This session does nothing more." Set by `stop()` and by `#moduleFailed`.
   *
   * It is one flag rather than two on purpose: the two events have different
   * causes but the same consequence — nothing this session does afterwards may
   * reach the radio or the consumer — and a second flag would have to be
   * remembered at every one of the eleven places below, which is precisely the
   * class of omission that left the pump resuming after a module death in the
   * first place. `restart()` is the single thing that clears it.
   */
  #stopped = false;
  /**
   * Bumped by anything that invalidates a claim already in flight, so a suspended
   * `await` can tell "the world moved under me" from "I am still the pump".
   *
   * `#stopped` cannot do this job on its own: `restart()` clears it, so a pump
   * parked inside `buildMessageFrames` when the codec died would wake up after a
   * `restart()` and put a note on the air that the fatal screen had already told
   * the user was never delivered. The epoch is captured before the `await` and
   * compared after it, so the pump can only ever continue its own claim.
   */
  #epoch = 0;
  #chain: Promise<void> = Promise.resolve();
  readonly #timers = new TimerSlots();
  /** True from the moment we hear a block until the quiet timer says otherwise. */
  #heardRecently = false;
  /** The ACK we owe the peer, kept until a quiet moment lets it go out. */
  #pendingAck: Uint8Array | null = null;
  /** The displayer's PAIR answer, held for the same reason. */
  #pendingPairReply = false;
  readonly #stats: SessionStats = {
    blocksDecoded: 0,
    framesUnreadable: 0,
    messagesDelivered: 0,
    duplicatesSuppressed: 0,
    conflicts: 0,
    acksSent: 0,
    retries: 0,
  };

  private constructor(options: SoundChatSessionOptions, code: string, keys: PairingKeys) {
    this.#options = options;
    this.#code = code;
    const salt = generateSessionSalt(options.random);
    this.#wire = new FrameCodec({
      keys,
      selfId: roleToPeerId(options.role),
      sendSalt: salt,
    });
    this.#ids = new MessageIdAllocator(salt[0]! * 256 + salt[1]!);
  }

  /**
   * Derives the session key from the code before anything can be transmitted.
   * A bad code, a missing WebCrypto or a hostile random source fails *here*,
   * with its own typed error, rather than halfway through a handshake.
   */
  static async create(options: SoundChatSessionOptions): Promise<SoundChatSession> {
    const code =
      options.pairingCode === undefined
        ? generatePairingCode(options.random)
        : validatePairingCode(options.pairingCode);
    const keys = options.keys ?? (await derivePairingKeys(code));
    return new SoundChatSession(options, code, keys);
  }

  get state(): TransportState {
    return this.#state;
  }

  get pairing(): PairingState {
    return this.#pairing;
  }

  get stats(): SessionStats {
    return { ...this.#stats };
  }

  /** The displayer's code; the enterer's own (validated) code. */
  get pairingCode(): string {
    return this.#code;
  }

  /** The session salt we send in our PAIR frame (public by design). */
  get sessionSalt(): Uint8Array {
    return Uint8Array.from(this.#wire.sendSalt);
  }

  /**
   * Starts the session: `START`, the mic feed, the visibility subscription and
   * the pairing flow. A user gesture is what makes this legal (iOS needs one to
   * unmute an AudioContext), which is why it is not done in `create`.
   */
  start(): void {
    if (this.#stopped) return;
    if (this.#state !== "idle" && this.#state !== "error") return;
    this.#emit({ type: "START" });
    // A method call is opaque to TS's narrowing, which is what we want here:
    // `#emit` is exactly what changed the state.
    if (this.#currentState() !== "listening") return;
    try {
      this.#listen ??= startListening({
        context: this.#options.context,
        stream: this.#options.stream,
        codec: this.#options.codec,
        onDecoded: (block) => this.#onDecodedBlock(block),
        onModuleError: (error) => this.#moduleFailed(error),
        onDecodedError: (error) => this.#reportListenerError(error),
      });
    } catch (error) {
      // `START` had already moved the machine to `listening`, so a throw here
      // used to leave the session claiming to listen with no feed at all — and
      // `start()`'s own guard made every retry a silent no-op (P2V finding 8).
      // The recoverable `error` state is the honest representation: the user can
      // fix the cause and START again.
      this.#emit({ type: "RECOVERABLE_ERROR" });
      this.#reportModuleError(error);
      return;
    }
    this.#unsubscribe ??= onVisibilityChange((hidden) => this.#onVisibility(hidden));
    // The subscription is change-only, so a session started while the page is
    // already hidden would never receive a HIDDEN event and would transmit on a
    // timer or a retry (P2V finding 12).
    if (documentIsHidden()) this.#onVisibility(true);
    this.#beginPairing();
  }

  /**
   * True while a transmission of ours is starting or under way — including the
   * window after `send()` returns, before the first block is played. A
   * multi-block message stays `true` until its *last* block is played, so this
   * is the honest "my audio is all on the air now" signal. Phase 3 shows its
   * progress from exactly this.
   */
  get transmitting(): boolean {
    return this.#txBusy || this.#state === "transmitting";
  }

  /**
   * True while a message of ours is in the system: the pump has claimed the
   * queue, or a transmission is waiting for its acknowledgement. False once the
   * peer has acknowledged it or given up on it.
   */
  get busy(): boolean {
    return this.#pumping || this.#outbound !== null;
  }

  /**
   * Leaves `module_error`/`error` and returns to a startable state. Refuses when
   * the codec itself is dead: that is terminal for the page session **by policy,
   * not by measurement** — the wasm module does survive an empty-payload trap
   * (Phase 0, `spike/codec-fatal.test.ts`), but a trap in Emscripten leaves the
   * C++ state undefined, so reusing a trapped instance is unsound. The honest
   * recovery is a reload, offered by the UI as "restart Sound Chat". No loop, no
   * retry storm.
   *
   * It also refuses a session it cannot actually leave, rather than reporting
   * success for a no-op (P2V finding 13): `RESTART` is a no-op in every healthy
   * state, and this driver performs no teardown, so "restart" is exactly
   * `module_error`/`error` -> `idle`. Phase 3 owns the real "restart Sound Chat"
   * affordance, which tears the session down and builds a new one.
   */
  restart(): { ok: true } | { ok: false; reason: "codec-dead" | "not-restartable" } {
    if (this.#options.codec.state !== "ready") return { ok: false, reason: "codec-dead" };
    if (this.#state !== "module_error" && this.#state !== "error") {
      return { ok: false, reason: "not-restartable" };
    }
    // The one thing that makes a terminal session startable again. Both halves
    // matter: without clearing `#stopped`, the `{ ok: true }` below would be a
    // promise `start()` cannot keep, because `start()` refuses a stopped session
    // — which is the same lie P2V finding 13 removed from the healthy path. And
    // without clearing the report latch, the second module failure in the same
    // page would be swallowed instead of reported.
    this.#stopped = false;
    this.#moduleFailureReported = false;
    this.#epoch += 1;
    // `#pumping` is the one piece of state a module failure leaves behind that the
    // epoch cannot reach: a pump parked in `buildMessageFrames` when the codec died
    // set it true, and `#pump`'s first guard then refuses *every* later pump. So a
    // restarted session accepted `send()`, published `queued`, and put nothing on
    // the air for the rest of its life — measured (Phase 4V deep-dive, M1).
    this.#pumping = false;
    this.#emit({ type: "RESTART" });
    return { ok: true };
  }

  /** Tears everything down. Idempotent, and safe with partial state. */
  stop(): void {
    this.#stopped = true;
    this.#epoch += 1;
    for (const key of ["ack", "backoff", "partialAck", "pair", "quiet"] as const) {
      this.#clearTimer(key);
    }
    this.#pendingAck = null;
    this.#pendingPairReply = false;
    this.#unsubscribe?.();
    this.#unsubscribe = null;
    this.#listen?.stop();
    this.#listen = null;
    this.#outbound = null;
    this.#handledAcks.clear();
    this.#pumping = false;
    // `#pending` is dropped WITHOUT reporting. `stop()` is the caller's own
    // teardown: it has already decided to discard everything, and the consumer
    // owns the view it is discarding from. Publishing a `failed` record here
    // would notify a consumer that is already tearing down, re-entrantly, from
    // inside the teardown. `#moduleFailed` is the opposite case — the session
    // ends but the screen stays up on a fatal panel, so anything still queued
    // has to be retired visibly or it reads "Queued" for the life of the page.
    // "Nothing at all after stop()" is the stronger contract, and it is the one
    // Phase 2V established.
    this.#pending = [];
    this.#partialAck = null;
    this.#reAckBudget.clear();
    // Any block already inside the chain is abandoned, so nothing that is still
    // awaiting `crypto.subtle` can deliver to a torn-down consumer afterwards.
    this.#chain = Promise.resolve();
    this.#emit({ type: "STOP" });
  }

  /**
   * Queues one message. Never blocks and never throws: a full queue, an
   * unpaired session, an over-long body and a dead codec are all *refusals* the
   * UI turns into its own honest copy. Queueing while hidden (or while another
   * message is in flight) is what "hold the send" means.
   */
  send(text: string): SendResult {
    // The codec verdict outranks `#stopped`, deliberately. `#moduleFailed` sets
    // that flag, so a dead codec would otherwise report the generic "Sound Chat
    // has stopped" and lose the sentence that names the actual cause; a real
    // `stop()` leaves the codec ready, so the order costs nothing there.
    if (this.#options.codec.state !== "ready") return { ok: false, reason: "module-error" };
    if (this.#stopped) return { ok: false, reason: "stopped" };
    if (!isPaired(this.#pairing)) return { ok: false, reason: "not-paired" };
    const bytes = encoder.encode(text);
    if (bytes.length === 0) return { ok: false, reason: "empty" };
    if (bytes.length > MAX_MESSAGE_PLAINTEXT_BYTES) return { ok: false, reason: "too-long" };
    if (this.#pending.length >= MAX_PENDING_MESSAGES) return { ok: false, reason: "queue-full" };
    this.#nextSendId += 1;
    const sendId = this.#nextSendId;
    this.#pending.push({ sendId, text });
    // Published here, synchronously, before `send()` returns: the note is ours
    // from this instant, and a consumer that waits for the pump to claim it would
    // show nothing at all for up to four queued notes (Phase 3V residual 1). The
    // session is the one that owns the queue, so the session is the one that
    // reports what is in it — this is not a second copy of the truth in the UI,
    // it is the truth.
    this.#notify(queuedEvent(sendId, text));
    // "Queued" means anything is ahead of this message: a transmission under
    // way, a pump that has claimed the queue, or a message still waiting. With
    // the pump deferred (below) a fresh send leaves `#pending` at 1, so the count
    // is what tells the first message from the rest.
    const queued = this.#outbound !== null || this.#pumping || this.#pending.length > 1;
    // The radio is claimed here, synchronously, so `transmitting` is true the
    // moment `send()` returns rather than only once the pump's first turn runs.
    this.#txBusy = true;
    // The pump is never entered on this stack. `#pump` awaits `crypto.subtle`,
    // and a consumer called from its own `catch` can call `send()` again; run
    // inline, that recursed on one stack until the stack overflowed, with
    // `queue-full` never reached because the queue never held more than one item
    // (P2V finding D2). A microtask break costs nothing: the audio cannot start
    // before the next frame either way.
    queueMicrotask(() => {
      void this.#pump();
    });
    return { ok: true, queued, sendId };
  }

  #beginPairing(): void {
    if (this.#pairing.kind !== "idle") return;
    if (this.#options.role === "displayer") {
      this.#pairing = pairingTransition(this.#pairing, {
        type: "BEGIN_DISPLAY",
        code: this.#code,
      });
      this.#armPairTimer(PAIR_PEER_TIMEOUT_MS, { type: "PEER_TIMEOUT" });
    } else {
      this.#pairing = pairingTransition(this.#pairing, { type: "BEGIN_ENTER", code: this.#code });
      this.#armPairTimer(PAIR_CONFIRM_TIMEOUT_MS, { type: "CONFIRM_TIMEOUT" });
      // The enterer initiates, so it is the side that must supply freshness: a
      // recorded PAIR frame from an earlier session with the same code would
      // otherwise authenticate for ever, because the key check only proves "this
      // code, at some point". The displayer has to echo this challenge back.
      this.#pairChallenge = generatePairChallenge(this.#options.random);
      void this.#transmitPairFrame();
    }
    this.#notify({ type: "pairing", state: this.#pairing });
  }

  async #transmitPairFrame(): Promise<void> {
    const challenge = this.#pairChallenge;
    if (challenge === null) return;
    // Same rule as every other block: one transmission of ours at a time, or the
    // two sum at the speaker and neither decodes. Phase 4V: this gate was
    // missing, so the only thing `#transmitPairFrame` did about our own audio was
    // hold the turn *afterwards* — measured, a hide/show inside the PAIR window put
    // two byte-identical PAIR blocks 1 s apart on the air, which sums them, and the
    // enterer's confirmation timeout then fires against a peer 1.92 s away.
    //
    // A refusal is remembered as `#pendingPairReply` rather than dropped, because
    // nothing else would ever re-send it: the displayer branch of `#onVisibility`
    // is the enterer's alone, and `#onPairFrame` returns early once we are paired.
    //
    // The flag is raised *before* asking for the air, not after a refusal: the arm
    // `#airIsOurs` may set is conditional on there being something worth a turn,
    // and a flag raised after the check is invisible to it — so the deferred PAIR
    // frame would hold the turn open and then nothing would ever walk into it.
    this.#pendingPairReply = true;
    if (!this.#airIsOurs()) return;
    this.#txBusy = true;
    let frame: Uint8Array;
    try {
      frame = await this.#wire.buildPairFrame(challenge);
    } finally {
      this.#txBusy = false;
    }
    this.#emit({ type: "TRANSMIT_BEGIN" });
    // The flag is consumed here rather than at the call site: every way this
    // method can fail to play (the machine refused the turn, the module died) is a
    // way the answer is still owed.
    if (this.#state !== "transmitting") return;
    this.#pendingPairReply = false;
    if (!this.#play(frame)) {
      this.#pendingPairReply = true;
      return;
    }
    this.#emit({ type: "TRANSMIT_DONE_UNACKED" });
    // The answer is audible for another 1.92 s while the machine already says
    // `listening`, and the composer is live the instant pairing completes — so
    // the turn has to be held explicitly, or the person's first note lands on
    // top of the answer and neither of them is decoded.
    this.#rearmQuietWhenOurSpeakerIsFree();
  }

  #onPairFrame(salt: Uint8Array, challenge: Uint8Array): void {
    if (isPaired(this.#pairing)) return;
    if (
      this.#pairing.kind !== "waiting-for-peer" &&
      this.#pairing.kind !== "awaiting-confirmation"
    ) {
      return;
    }
    // We initiated, so the peer's answer must echo *our* challenge. A
    // recording of a previous session's answer carries that session's challenge
    // and is refused here, which is what makes a cross-session replay useless
    // even though the key check itself verifies (P2V finding 2).
    const expected = this.#pairChallenge;
    if (expected !== null && !constantTimeEqual(challenge, expected)) {
      this.#onPairRejected();
      return;
    }
    // Our own misuse (a different salt on an already-paired codec) must not look
    // like a peer failure, so it is reported on the module channel and no state
    // moves. The guard above means it cannot happen while unpaired.
    try {
      this.#wire.adoptPeerSalt(salt);
    } catch (error) {
      this.#moduleFailed(error);
      return;
    }
    const next = pairingTransition(this.#pairing, { type: "PEER_CONFIRMED", salt });
    this.#pairing = next;
    this.#clearTimer("pair");
    this.#notify({ type: "pairing", state: next });
    // The displayer's answer goes out after the enterer's Rx feed is listening
    // again — the same turn-gap rule the ACK path obeys. It echoes the
    // challenge it was given, which is what proves the answer is live.
    if (next.kind === "paired" && next.role === "displayer") {
      this.#pairChallenge = challenge;
      if (this.#heardRecently) this.#pendingPairReply = true;
      else void this.#transmitPairFrame();
    }
  }

  #onPairRejected(): void {
    if (isPaired(this.#pairing)) return;
    this.#pairing = pairingTransition(this.#pairing, { type: "PEER_REJECTED" });
    this.#clearTimer("pair");
    this.#notify({ type: "pairing", state: this.#pairing });
  }

  #armPairTimer(ms: number, event: { type: "PEER_TIMEOUT" } | { type: "CONFIRM_TIMEOUT" }): void {
    this.#clearTimer("pair");
    this.#timers.pair = setTimeout(() => {
      this.#timers.pair = undefined;
      if (isPaired(this.#pairing) || this.#pairing.kind === "failed") return;
      this.#pairing = pairingTransition(this.#pairing, event);
      this.#notify({ type: "pairing", state: this.#pairing });
    }, ms);
  }

  /** Copy for the pairing screen; the UI decides where to show it. */
  get pairingFailureMessage(): string | null {
    return this.#pairing.kind === "failed" ? describePairingFailure(this.#pairing.reason) : null;
  }

  #onVisibility(hidden: boolean): void {
    if (this.#stopped) return;
    this.#emit({ type: hidden ? "HIDDEN" : "VISIBLE" });
    if (hidden || this.#state !== "listening") return;
    // An ACK we owe has to go out before anything of ours does, for the same
    // reason `#onChannelQuiet` sends it first. While the page was hidden the
    // quiet timer fired into `hidden_hold`, where `TRANSMIT_BEGIN` is refused —
    // so without this the ACK was stranded for good: measured, the sender then
    // burned all three attempts and reported "failed" for a note that was
    // sitting delivered on screen, with `acksSent` still 0.
    if (this.#pendingAck !== null && !this.#heardRecently) {
      if (this.#attemptAck()) return;
    }
    // Coming back: resume a held message before starting anything new.
    if (this.#outbound !== null) {
      void this.#transmitBlocks(pendingBlocks(this.#outbound));
      return;
    }
    // An enterer whose page was hidden when it started has never put its PAIR
    // frame on the air, and nothing else would ever send it — pairing then died
    // at `PAIR_CONFIRM_TIMEOUT_MS` with a message about the *other* device. The
    // turn gap has already elapsed inside the quiet timer, so this is the same
    // "the channel is ours" moment every other reply uses.
    if (
      this.#options.role === "enterer" &&
      this.#pairChallenge !== null &&
      !isPaired(this.#pairing)
    ) {
      if (this.#heardRecently) this.#pendingPairReply = true;
      else void this.#transmitPairFrame();
      return;
    }
    void this.#pump();
  }

  /**
   * Every heard block means the channel was busy *now*: remember that, and arm
   * the quiet timer that turns "the peer has stopped" into `CHANNEL_QUIET`.
   */
  #noteHeard(): void {
    this.#heardRecently = true;
    this.#clearTimer("quiet");
    this.#timers.quiet = setTimeout(() => {
      this.#timers.quiet = undefined;
      this.#heardRecently = false;
      if (this.#stopped) return;
      this.#onChannelQuiet();
    }, TURN_GAP_MS);
  }

  /**
   * True while our own speaker is still sounding.
   *
   * The Rx pause *is* that fact: `transmitAndPause` closed the feed for the whole
   * transmit window plus the measured tail, on the AudioContext clock, so
   * "the feed is paused" and "we are still talking" are the same question with
   * two names. Reading it here rather than recomputing the window is what keeps
   * a third copy of the pause arithmetic from existing.
   */
  #speakerBusy(): boolean {
    return this.#listen?.paused ?? false;
  }

  /**
   * Arms the quiet timer for the instant our own transmission stops sounding.
   *
   * Needed because nothing else asks again. Our own audio pauses our own Rx
   * feed, so it produces no decodes for `#noteHeard` to hear, and the transport
   * machine is already back in `listening` — `TRANSMIT_DONE_UNACKED` fires when
   * a block is *scheduled*, not when it stops. Without this, the turn after an
   * un-acknowledged transmission had to be assumed, and nothing ever assumed it
   * correctly.
   */
  #rearmQuietWhenOurSpeakerIsFree(): void {
    const listen = this.#listen;
    if (listen === null || !listen.paused) return;
    // Only when something is actually waiting for the turn. A timer armed for a
    // turn nobody wants is a timer that sits there for the length of a block and
    // then does nothing, and "nothing of ours is armed while we are idle" is a
    // property worth being able to assert.
    // `#pumping` counts too: a pump that has claimed a submission has already
    // shifted it off `#pending` but has not yet built `#outbound`, and a note
    // stranded in exactly that gap is the defect this arm exists to prevent.
    //
    // The two owed *answers* count as well, and they are the ones with no second
    // way back. A message also has the ACK deadline behind it and a PAIR frame its
    // own 5.84 s / 90 s timeout, but `#pendingAck` and `#pendingPairReply` live in a
    // slot nothing else ever revisits: if this arm skips while one is owed, that
    // answer is never sent. Phase 4V deep-dive, finding M2.
    if (
      this.#outbound === null &&
      this.#pending.length === 0 &&
      !this.#pumping &&
      this.#pendingAck === null &&
      !this.#pendingPairReply
    ) {
      return;
    }
    this.#clearTimer("quiet");
    const waitMs = Math.max(
      0,
      (listen.pausedUntilSeconds - this.#options.context.currentTime) * 1_000,
    );
    this.#timers.quiet = setTimeout(() => {
      this.#timers.quiet = undefined;
      if (this.#stopped) return;
      this.#onChannelQuiet();
    }, waitMs);
  }

  /**
   * Whether the caller may put audio on the air now.
   *
   * If our own speaker is still talking, the turn is *deferred*, never dropped:
   * the quiet timer is re-armed for the instant the feed reopens, which is the
   * only "the air is clear" signal this transport has.
   */
  #airIsOurs(): boolean {
    if (!this.#speakerBusy()) return true;
    this.#rearmQuietWhenOurSpeakerIsFree();
    return false;
  }

  #onChannelQuiet(): void {
    // The machine goes back to `listening` *before* anything queued fires, so a
    // reply can never be refused for arriving a hair early.
    this.#emit({ type: "CHANNEL_QUIET" });
    if (this.#pendingPairReply) {
      // The flag is only consumed once the answer is actually on its way. A PAIR
      // frame deferred by `#airIsOurs()` has nothing else that would ever re-send
      // it — the displayer branch of `#onVisibility` is the enterer's alone, and
      // `#onPairFrame` returns early once we are paired — so dropping it here lost
      // the answer outright while this device went on reporting itself paired
      // (Phase 4V deep-dive, H2).
      void this.#transmitPairFrame();
      return;
    }
    // Whatever we transmit next has to be the *only* thing on the air. An owed
    // ACK is played at `start(0)` — now — and is a full 1.92 s block, so starting
    // our own queued note behind it stacked two waveforms at the destination,
    // which neither end can decode: measured, the sender then never resolved
    // because its ACK landed inside the overlap.
    //
    // The guard that was supposed to hold the rest of the turn back could never
    // fire: `#attemptAck` ends in `TRANSMIT_DONE_UNACKED`, which puts the machine
    // straight back in `listening`, so `state !== "listening"` was never true
    // after a *successful* attempt. Only the air itself can answer that question,
    // so the ACK goes out alone and `#attemptAck` re-arms the turn for the moment
    // it stops sounding — which is the quiet moment that re-enters the pump.
    if (this.#pendingAck !== null) {
      // A refused attempt is kept, not dropped, and the next quiet moment retries.
      void this.#attemptAck();
      return;
    }
    if (this.#outbound !== null) {
      // A held or partially-sent message resumes now that the air is clear.
      const missing = pendingBlocks(this.#outbound);
      if (missing.length > 0 && this.#timers.backoff === undefined) {
        void this.#transmitBlocks(missing);
      }
      return;
    }
    void this.#pump();
  }

  /**
   * Sends the ACK we owe, if the channel is ours. A refused attempt is *kept*,
   * not dropped: the next quiet moment tries again, which is what makes the
   * reply independent of the order two timers happened to fire in.
   *
   * Returns whether the ACK actually went out, so a caller can keep the rest of
   * the turn to itself rather than stacking our own block on top of this one.
   */
  #attemptAck(): boolean {
    const frame = this.#pendingAck;
    if (frame === null || this.#heardRecently || this.#stopped) return false;
    if (!this.#airIsOurs()) return false;
    this.#emit({ type: "TRANSMIT_BEGIN" });
    if (this.#currentState() !== "transmitting") return false;
    if (!this.#play(frame)) return false;
    this.#pendingAck = null;
    this.#stats.acksSent += 1;
    this.#emit({ type: "TRANSMIT_DONE_UNACKED" });
    // Our own block is on the speaker now, so hold the turn open for it. The
    // sender needs this ACK to resolve its note: if it sums with anything else
    // of ours it never decodes, and the sender reports a failure for a note the
    // user can see sitting on the peer's screen.
    this.#rearmQuietWhenOurSpeakerIsFree();
    return true;
  }

  /**
   * Reports a submission the session will never put on the air.
   *
   * A note that was accepted and published as `queued` has a rendered row behind
   * it, so every path that abandons one has to retire that row — otherwise it
   * reads "Queued" for the rest of the session. There are exactly two such paths
   * that leave a consumer still listening: the pump failing to seal the note, and
   * a module failure. (`stop()` is deliberately *not* one of them; see its body.)
   *
   * `failed` is the honest status in each case: the other device never confirmed
   * anything, and never will.
   */
  #failSubmission(sendId: number, text: string): void {
    this.#notify({ ...queuedEvent(sendId, text), status: "failed" });
  }

  async #pump(): Promise<void> {
    if (this.#stopped || this.#outbound !== null || this.#pumping) {
      this.#txBusy = false;
      return;
    }
    if (this.#pending.length === 0) {
      this.#txBusy = false;
      return;
    }
    if (!isPaired(this.#pairing)) {
      this.#txBusy = false;
      return;
    }
    // The queue slot is claimed *synchronously*, before the first `await`.
    // `#pump` is async, so two `send()` calls in one tick used to both pass the
    // guard above and both read `#pending[0]`: one message was sealed twice
    // under two msgIds and one was silently lost (P2V finding 1). Claiming the
    // submission here, before anything can suspend, is what makes the pump
    // single.
    const submission = this.#pending.shift();
    if (submission === undefined) {
      this.#txBusy = false;
      return;
    }
    const text = submission.text;
    this.#pumping = true;
    let msgId: number;
    let plaintext: Uint8Array;
    try {
      // The allocator refusing to wrap is designed behaviour; nothing catching
      // that refusal was not (P2V finding 7). Both failures are our own misuse.
      msgId = this.#ids.next();
      plaintext = encoder.encode(text);
    } catch (error) {
      this.#pumping = false;
      this.#txBusy = false;
      this.#failSubmission(submission.sendId, text);
      this.#reportLater(error);
      return;
    }
    let frames: Uint8Array[];
    // Captured before the only suspension in this method, and compared after it.
    // `#stopped` alone is not enough here: `restart()` clears it, so without the
    // epoch a pump that was parked in `buildMessageFrames` when the codec died
    // would wake up after a restart and re-create `#outbound`, re-emitting a
    // `sending` event and arming a fresh ACK timer for a note the fatal screen
    // had already reported as never delivered (Phase 3V residual 4).
    const epoch = this.#epoch;
    try {
      frames = await this.#wire.buildMessageFrames(plaintext, msgId);
    } catch (error) {
      // A body the protocol refuses: our own misuse, reported on the consumer
      // channel, and the queue keeps moving instead of stalling forever.
      this.#pumping = false;
      this.#txBusy = false;
      this.#failSubmission(submission.sendId, text);
      this.#reportLater(error);
      return;
    }
    // `stop()` or a module failure may have run while the frames were being
    // sealed. Re-checking here is what keeps the public `busy` getter honest:
    // without it a session torn down mid-seal re-created `#outbound` and emitted
    // an `outbound` event *after* teardown, and `busy` stayed true for good
    // (P2V finding D1).
    if (this.#stopped || epoch !== this.#epoch) {
      this.#pumping = false;
      this.#txBusy = false;
      // This note is never going on the air either, and it already has a rendered
      // row from its `queued` event.
      this.#failSubmission(submission.sendId, text);
      return;
    }
    this.#pumping = false;
    this.#txBusy = false;
    // A new message is a new ACK window: the previous one's dedupe keys must not
    // suppress a legitimate answer to this one.
    this.#handledAcks.clear();
    this.#outbound = {
      sendId: submission.sendId,
      msgId,
      plaintext,
      frames,
      blockCount: frames.length,
      attempts: 0,
      ackedMask: 0,
      status: "sending",
    };
    // Held in a local, and re-checked after the event: a consumer is free to call
    // `stop()` from inside its own `sending` event, which clears `#outbound`. The
    // read below used to be a field access on `null` inside an async method every
    // call site reaches with `void` — so the TypeError became an unhandled
    // rejection attributed to nothing (Phase 4V deep-dive, F5).
    const outbound: OutboundMessage = this.#outbound;
    this.#notify(outboundEvent(outbound, "sending"));
    if (this.#stopped || this.#outbound !== outbound) return;
    // A handshake answer still owed outranks this note. The displayer is `paired`
    // — and its composer is live — from the moment it adopts the enterer's salt,
    // while the answer that lets the *enterer* confirm is still 700 ms from the
    // air. A note sent in that window preempted the answer entirely, and the
    // enterer never heard a PAIR frame at all, so it timed out and reported
    // `failed` against a displayer that believed itself paired (Phase 4V deep-dive,
    // H2). The note is not lost: `#outbound` holds it with no attempt spent, and
    // `#onChannelQuiet` sends the answer first and then resumes this.
    if (this.#pendingPairReply) return;
    await this.#transmitBlocks(pendingBlocks(outbound));
  }

  async #transmitBlocks(indices: number[]): Promise<void> {
    const outbound = this.#outbound;
    if (outbound === null || indices.length === 0 || this.#stopped) return;
    if (outbound.attempts >= MAX_SEND_ATTEMPTS) {
      this.#failOutbound(outbound);
      return;
    }
    // Our own speaker is still finishing an un-acknowledged block — an ACK, or a
    // PAIR answer. Starting here would sum the two waveforms and neither end
    // would decode either, so the turn is held, not spent: the attempt counter
    // is only reached once the machine actually starts audio (P2V finding 4).
    if (!this.#airIsOurs()) return;
    this.#emit({ type: "TRANSMIT_BEGIN" });
    if (this.#state !== "transmitting") {
      // Refused — held because the tab is hidden, or the peer owns the air. An
      // attempt is only *spent* once the machine actually started audio; a
      // hide/show cycle used to cost one of three, so three cycles failed a
      // message that had never reached the air (P2V finding 4).
      return;
    }
    // A small lead so the first scheduled block is never in the past, which
    // `AudioBufferSourceNode.start` would treat as "now" and so collapse the
    // whole schedule back onto one instant.
    const startAtSeconds = this.#options.context.currentTime + TRANSMIT_LEAD_SECONDS;
    outbound.attempts += 1;
    if (outbound.attempts > 1) {
      this.#stats.retries += 1;
      this.#notify(outboundEvent(outbound, outbound.status));
    }
    for (const [offset, index] of indices.entries()) {
      // A tab that goes hidden mid-message stops the remaining blocks here: the
      // machine is in hidden_hold by then and refuses to start audio anyway.
      if (this.#state !== "transmitting") return;
      const frame = outbound.frames[index];
      if (frame === undefined) continue;
      // Blocks are scheduled back to back on the AudioContext clock. `start()`
      // with no argument starts at `currentTime`, so two of them in the same tick
      // would *sum* at the destination and a 2-block message would be
      // undecodable (measured, Phase 2V). The first block carries the pause for
      // the whole window; the rest pass 0 so the feed is not re-armed per block.
      //
      // The raw audio only — `ListenHandle.pause` adds the measured tail itself.
      // Passing the tail in as well shut the sender's own feed for 0.5 s longer
      // than the window, which ate the first 0.5 s of the peer's ACK and broke
      // every single-block message (measured, Phase 2V).
      const first = offset === 0;
      const hold = first ? indices.length * BLOCK_DURATION_SECONDS : 0;
      if (!this.#play(frame, startAtSeconds + offset * BLOCK_DURATION_SECONDS, hold)) return;
    }
    this.#emit({ type: "TRANSMIT_DONE" });
    this.#armAckTimer(indices.length);
  }

  #play(frame: Uint8Array, startAtSeconds = 0, pauseSeconds?: number): boolean {
    const listen = this.#listen;
    if (listen === null) return false;
    try {
      transmitAndPause(
        listen,
        this.#options.context,
        this.#options.codec,
        frame,
        startAtSeconds,
        pauseSeconds,
      );
      return true;
    } catch (error) {
      // A throw on the Tx path is the module dying (or our frame contract
      // breaking): one report, no retry, no loop (Section 10.2 P11).
      this.#moduleFailed(error);
      return false;
    }
  }

  #failOutbound(outbound: OutboundMessage): void {
    outbound.status = "failed";
    this.#notify(outboundEvent(outbound, "failed"));
    this.#outbound = null;
    this.#handledAcks.clear();
    this.#ackExtensions = 0;
    this.#emit({ type: "BACKOFF_EXPIRED" });
    void this.#pump();
  }

  #armAckTimer(blockCount: number): void {
    this.#clearTimer("ack");
    // A partial retry only sends the missing blocks, so its window shrinks with
    // them; the shared ceiling still applies.
    const scaled = Math.min(
      ACK_TIMEOUT_MS,
      blockCount * BLOCK_DURATION_MS + TURN_GAP_MS + BLOCK_DURATION_MS + 1_000,
    );
    this.#timers.ack = setTimeout(() => {
      this.#timers.ack = undefined;
      this.#onAckDeadline();
    }, scaled);
  }

  #onAckDeadline(): void {
    if (this.#state !== "awaiting_ack" || this.#outbound === null) return;
    this.#emit({ type: "ACK_TIMEOUT" });
    this.#scheduleRetry();
  }

  #scheduleRetry(): void {
    const outbound = this.#outbound;
    if (outbound === null || this.#timers.backoff !== undefined || this.#state !== "backoff") {
      return;
    }
    const decision = decideRetry(outbound);
    if (decision.action === "fail") {
      this.#failOutbound(outbound);
      return;
    }
    const delay = BACKOFF_MIN_MS + Math.random() * (BACKOFF_MAX_MS - BACKOFF_MIN_MS);
    this.#timers.backoff = setTimeout(() => {
      this.#timers.backoff = undefined;
      this.#emit({ type: "BACKOFF_EXPIRED" });
      if (this.#state !== "listening") return;
      void this.#transmitBlocks(decision.blocks);
    }, delay);
  }

  #onDecodedBlock(block: Uint8Array): void {
    // Serialised through one promise chain, so two blocks that arrive close
    // together are authenticated and assembled in the order they were heard.
    this.#chain = this.#chain
      .then(() => this.#handleBlock(block))
      .catch((error) => this.#reportListenerError(error));
  }

  /**
   * One decoded 64-byte block. Everything hostile is handled here as a *reason*:
   * a block we cannot authenticate is "nothing decoded" (P5) plus one
   * "something was heard" signal (P6), never an exception into the mic feed.
   */
  async #handleBlock(block: Uint8Array): Promise<void> {
    // A block already inside the chain when `stop()` ran is not processed: it
    // would deliver a message to a consumer that has torn down, and `#noteHeard`
    // would arm a fresh timer after `stop()` cleared the table (P2V finding 5).
    if (this.#stopped) return;
    this.#stats.blocksDecoded += 1;
    this.#noteHeard();
    const outcome = await this.#wire.parse(block);
    // Re-checked *after* the await: the guard at the top cannot cover a block
    // that was already suspended inside `parse` when `stop()` ran, and such a
    // block used to be delivered to a consumer that had torn down (P2V finding
    // D5). No timer is armed either — this returns before `#noteHeard`'s
    // successor could re-arm one.
    if (this.#stopped) return;
    if (!outcome.ok) {
      this.#stats.framesUnreadable += 1;
      this.#emit({ type: "HEARD_UNREADABLE" });
      this.#notify({
        type: "heard-unreadable",
        reason: outcome.reason,
        count: this.#stats.framesUnreadable,
      });
      // Only a *well-formed PAIR frame* whose key check failed says "that device
      // is using a different code" — a conclusion worth ending a handshake on.
      // Treating every pre-pairing auth failure as one meant any noise did it: a
      // 64-byte block with two non-zero bytes was enough, so no code and no
      // recording were needed to kill a live pairing, which then refused the
      // genuine peer's real PAIR frame and could not re-pair at all (Phase 4).
      // Everything else unauthenticated is "something was heard that we cannot
      // read" (P5/P6), and the handshake ends on its own timeout instead.
      if (outcome.reason === "pair-key-failed" && !isPaired(this.#pairing)) {
        this.#onPairRejected();
      }
      this.#extendAckDeadline();
      return;
    }
    const frame = outcome.frame;
    if (frame.kind === "pair") {
      this.#onPairFrame(frame.salt, frame.challenge);
      return;
    }
    if (frame.kind === "ack") {
      this.#onAckFrame(frame.msgId, frame.mask);
      return;
    }
    this.#onMessageBlock(frame);
  }

  #onAckFrame(msgId: number, mask: number): void {
    const outbound = this.#outbound;
    // An ACK for a message we never sent (or already resolved) is ignored: it
    // cannot move anything, and it is exactly what a hostile peer would try.
    if (outbound === null || outbound.msgId !== msgId) return;
    // The codec redelivers every block 2-4 times, so a *partial* ACK arrives 2-4
    // times too. Each redelivery used to re-enter `#transmitBlocks` and spend
    // another one of the sender's three attempts on byte-identical audio that
    // then stacked on itself — measured: two overlapping retransmissions and a
    // `failed` note while the peer had assembled the whole message. One
    // retransmission per distinct (msgId, mask) per ACK window is the intent, so
    // the same answer twice is a no-op. A genuinely *changed* mask (more blocks
    // arrived) still gets through.
    const seen = this.#handledAcks;
    const key = `${msgId}:${mask}`;
    if (seen.has(key)) return;
    seen.add(key);
    this.#clearTimer("ack");
    this.#ackExtensions = 0;
    const status = applyAck(outbound, mask);
    this.#notify(outboundEvent(outbound, status));
    this.#emit({ type: "ACK_RECEIVED" });
    if (status === "sent") {
      this.#outbound = null;
      this.#handledAcks.clear();
      void this.#pump();
      return;
    }
    // Partial ACK: the peer has some blocks; only the missing ones go back out,
    // under the same msgId (P11).
    const missing = pendingBlocks(outbound);
    if (missing.length > 0) void this.#transmitBlocks(missing);
  }

  #onMessageBlock(frame: Extract<ParsedFrame, { kind: "message" }>): void {
    const outcome = this.#assembler.accept({
      msgId: frame.msgId,
      blockIndex: frame.blockIndex,
      blockCount: frame.blockCount,
      plaintext: frame.plaintext,
    });
    // A message frame is never the ACK we might be waiting for, so it means the
    // peer is on the air: yield the turn, or back off if we were mid-message.
    // `CHANNEL_QUIET` comes from the quiet timer, once the air really is clear.
    this.#emit({ type: "PEER_STARTED_TRANSMITTING" });
    switch (outcome.status) {
      case "delivered":
        this.#stats.messagesDelivered += 1;
        this.#emit({ type: "MESSAGE_DECODED" });
        this.#notify({
          type: "message",
          msgId: outcome.msgId,
          text: decoder.decode(outcome.plaintext),
        });
        // The whole note is in hand, so any partial-ACK timer still armed for it
        // is now obsolete. Left armed, it put a *second* ACK on the air about a
        // second later carrying the stale partial mask — measured on the wire as
        // `[0b11, 0b01]` — which cost a wasted 1.92 s block per two-block message
        // and could make the sender retransmit a block it had already sent.
        this.#clearPartialAck();
        void this.#sendAck(outcome.msgId, fullMask(outcome.blockCount));
        break;
      case "partial":
        this.#partialAck = {
          msgId: outcome.msgId,
          mask: outcome.mask,
          blockCount: outcome.blockCount,
        };
        this.#schedulePartialAck();
        break;
      case "duplicate":
        // Already rendered; re-ACK so a lost acknowledgement cannot make the
        // sender retry for ever (the codec redelivers every block 2-4 times).
        // The budget bounds that: a replayed recording must not be able to make
        // this device transmit for as long as the attacker keeps playing it.
        //
        // Note the pending partial-ACK is deliberately NOT cleared here. A
        // duplicate is what the codec emits when it re-hears block 0 of a
        // message whose second block has not arrived yet — clearing there
        // cancelled the very timer the answer depends on, so the partial
        // message was never answered at all.
        this.#stats.duplicatesSuppressed += 1;
        if (this.#reAckBudget.take(outcome.msgId)) {
          void this.#sendAck(outcome.msgId, outcome.mask);
        }
        break;
      case "conflict":
        // Authenticated but inconsistent with what we already hold: never
        // rendered, counted, and the sender is told what we actually have.
        this.#stats.conflicts += 1;
        this.#emit({ type: "HEARD_UNREADABLE" });
        this.#notify({
          type: "heard-unreadable",
          reason: "conflicting-block",
          count: this.#stats.conflicts,
        });
        // The answer here supersedes any partial answer owed for the same note.
        this.#clearPartialAck();
        void this.#sendAck(outcome.msgId, outcome.mask);
        break;
      case "stale":
        // Below the high-water mark: a redelivery or a replay of an older
        // message. Never rendered, and not acked (we do not know its blocks).
        this.#stats.duplicatesSuppressed += 1;
        break;
      default:
        break;
    }
    if (this.#state === "backoff") this.#scheduleRetry();
  }

  async #sendAck(msgId: number, mask: number): Promise<void> {
    if (this.#stopped || mask === 0 || !isPaired(this.#pairing)) return;
    // Kept until the channel is quiet: the peer's own Rx feed stays shut for
    // `TURN_GAP_MS` after it transmitted, and a reply that starts inside that
    // window never fills the peer's 90-frame analysis window.
    this.#pendingAck = await this.#wire.buildAckFrame(msgId, mask);
    this.#attemptAck();
  }

  /**
   * Forgets a partial acknowledgement we owe but have not sent.
   *
   * Called whenever a definitive answer for the same note supersedes it. Without
   * it the armed timer fired anyway, a second time, with a mask that no longer
   * described what the sender actually holds.
   */
  #clearPartialAck(): void {
    this.#partialAck = null;
    this.#clearTimer("partialAck");
  }

  #schedulePartialAck(): void {
    this.#clearTimer("partialAck");
    // Scaled to the transmission we are answering: the sender's feed is shut for
    // all of its blocks plus the tail, so a fixed one-block delay is too early for
    // a two-block message and its answer is simply lost.
    const blockCount = this.#partialAck?.blockCount ?? 1;
    const delay = blockCount * BLOCK_DURATION_MS + 300;
    this.#timers.partialAck = setTimeout(() => {
      this.#timers.partialAck = undefined;
      const pendingAck = this.#partialAck;
      this.#partialAck = null;
      if (pendingAck === null) return;
      void this.#sendAck(pendingAck.msgId, pendingAck.mask);
    }, delay);
  }

  /**
   * A block we could not read is a busy channel: extend our ACK window instead
   * of talking over it, but only finitely often — past the limit it counts as a
   * collision and the message is retried (Section 10.2 P11, P12).
   */
  #extendAckDeadline(): void {
    if (this.#state !== "awaiting_ack" || this.#outbound === null) return;
    if (this.#ackExtensions >= MAX_ACK_EXTENSIONS) {
      this.#emit({ type: "COLLISION_DETECTED" });
      this.#scheduleRetry();
      return;
    }
    this.#ackExtensions += 1;
    this.#armAckTimer(pendingBlocks(this.#outbound).length);
  }

  /** Terminal for the session: report once, cancel every retry, never loop. */
  #moduleFailed(error: unknown): void {
    // Idempotent. A Tx death leaves the Rx feed attached, so the next capture
    // chunk fails too and used to report a second time (P2V finding 6).
    if (this.#moduleFailureReported) return;
    this.#moduleFailureReported = true;
    // Terminal means terminal. Every timer is cleared, the feed is released and
    // the queue is emptied below, so a session that keeps "working" after this
    // point is not working — it is a pump resuming inside an already-abandoned
    // message and emitting events nobody is left to honour (Phase 3V residual 4:
    // this flag was never set, so a park in `buildMessageFrames` woke up after a
    // module death, re-created `#outbound` and called `transmitBlocks` with a
    // `#listen` that had already been released). `restart()` is the only way
    // back, and it checks the codec first.
    this.#stopped = true;
    this.#epoch += 1;
    // Same reasoning as `restart()`, and for the same reason: a pump suspended in
    // `buildMessageFrames` when the codec died holds this flag, and every later
    // pump would be refused by it. `restart()` is what makes the session usable
    // again, so it is the thing that has to clear it.
    this.#pumping = false;
    this.#emit({ type: "MODULE_DIED" });
    // `pair` is cleared here as well as in `stop()`: a 90 s listen timer that
    // outlived a terminal module error later emitted `pairing: failed`.
    for (const key of ["ack", "backoff", "partialAck", "pair", "quiet"] as const) {
      this.#clearTimer(key);
    }
    this.#pendingAck = null;
    this.#pendingPairReply = false;
    this.#partialAck = null;
    // The feed is released too, so no further chunk can re-report or keep the
    // mic indicator lit on a session that can no longer transmit.
    this.#listen?.stop();
    this.#listen = null;
    // The one thing `#stopped` alone cannot cover: a block already dispatched
    // into `#chain` before the death. `stop()` resets the chain for exactly this
    // reason and `#moduleFailed` did not, so a frame that was already suspended
    // inside `crypto.subtle` went on to be parsed, counted in `blocksDecoded` and
    // reported to a consumer over a session that is now terminal. Resetting the
    // chain abandons it identically, and cannot affect `restart()`'s contract
    // because `restart()` is the only thing that clears `#stopped` again.
    this.#chain = Promise.resolve();
    this.#unsubscribe?.();
    this.#unsubscribe = null;
    this.#reAckBudget.clear();
    const outbound = this.#outbound;
    if (outbound !== null) {
      outbound.status = "failed";
      this.#notify(outboundEvent(outbound, "failed"));
    }
    this.#outbound = null;
    this.#handledAcks.clear();
    // Every note still waiting behind it has a rendered `queued` row behind it
    // now, and this session is never going to send any of them. Dropping the
    // queue silently would leave those rows reading "Queued" on a fatal screen
    // for the life of the page.
    for (const queued of this.#pending) this.#failSubmission(queued.sendId, queued.text);
    this.#pending = [];
    this.#reportModuleError(error);
  }

  /**
   * Reports a consumer-channel failure and then continues the queue — from a
   * *fresh* frame, never on this one.
   *
   * `#pump` is called with `void` at five sites, so re-entering it from inside
   * its own `catch` recursed on one stack: a consumer that re-sent from
   * `onListenerError` overflowed the stack at depth ~1500, and `queue-full`
   * never fired because the queue never held more than one item. Hopping to a
   * microtask breaks the cycle (P2V finding D2).
   */
  #reportLater(error: unknown): void {
    this.#reportListenerError(error);
    queueMicrotask(() => {
      void this.#pump();
    });
  }

  /**
   * A consumer of ours threw: its own channel, never a codec verdict.
   *
   * The reporter is protected in turn (P2V finding 3). It is called from
   * `#notify`, from the chain's own `.catch` and from the pump's misuse paths,
   * so a consumer whose *error handler* throws used to escape into all of them:
   * `#chain` stayed rejected, every later block was skipped, and the session
   * still reported `listening` — deaf but healthy-looking.
   */
  #reportListenerError(error: unknown): void {
    this.#reportTo(this.#options.onListenerError, error, "a session error handler threw");
  }

  /**
   * The module-failure channel, protected exactly like the listener one. A
   * throwing `onModuleError` used to escape into `#play`'s catch and reject the
   * pump, because every call site reaches it with `void` (P2V finding D4).
   */
  #reportModuleError(error: unknown): void {
    this.#reportTo(this.#options.onModuleError, error, "a module error handler threw");
  }

  #reportTo(report: ((error: unknown) => void) | undefined, error: unknown, label: string): void {
    if (report === undefined) {
      console.error("Sound Chat: a session consumer threw", error);
      return;
    }
    try {
      report(error);
    } catch (secondary) {
      console.error(`Sound Chat: ${label}`, secondary);
      console.error("Sound Chat: a session consumer threw", error);
    }
  }

  #emit(event: TransportEvent): void {
    const next = transition(this.#state, event);
    if (next === this.#state) return;
    this.#state = next;
    this.#notify({ type: "transport", state: next });
  }

  /** Opaque to TS narrowing: the state may have moved inside a call. */
  #currentState(): TransportState {
    return this.#state;
  }

  #notify(event: SessionEvent): void {
    const listener = this.#options.onEvent;
    if (listener === undefined) return;
    try {
      listener(event);
    } catch (error) {
      this.#reportListenerError(error);
    }
  }

  #clearTimer(key: TimerKey): void {
    const timer = this.#timers.read(key);
    if (timer !== undefined) {
      clearTimeout(timer);
      this.#timers.clear(key);
    }
  }
}
