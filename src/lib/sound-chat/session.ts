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
 *   2 x 1920 + 1000 = 4840 ms: 2.5x the fast path, +0.7 s over the slow one.
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
  MAX_MESSAGE_PLAINTEXT_BYTES,
  MAX_SEND_ATTEMPTS,
  MessageIdAllocator,
  applyAck,
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
/** 2 blocks + the 700 ms turn gap + 1000 ms: see the derivation above. */
export const ACK_TIMEOUT_MS = BLOCK_DURATION_MS * 2 + TURN_GAP_MS + 1_000;
/** Past one whole block, so a second block of the same message can still land. */
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
  | { type: "outbound"; msgId: number; status: OutboundStatus; attempts: number }
  | {
      type: "heard-unreadable";
      /** Why the block could not be read; `conflicting-block` is authenticated but inconsistent. */
      reason: FrameRejection | "conflicting-block";
      count: number;
    };

export type SendRefusal =
  "not-paired" | "empty" | "too-long" | "queue-full" | "module-error" | "stopped";

export type SendResult = { ok: true; queued: boolean } | { ok: false; reason: SendRefusal };

export type SoundChatSessionOptions = {
  codec: SoundChatCodec;
  context: AudioContext;
  stream: MediaStream;
  role: PairingRole;
  /** The displayer may omit this and have a code generated for it. */
  pairingCode?: string;
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

export class SoundChatSession {
  readonly #options: SoundChatSessionOptions;
  readonly #wire: FrameCodec;
  readonly #assembler = new InboundAssembler();
  readonly #ids: MessageIdAllocator;
  readonly #code: string;
  #state: TransportState = "idle";
  #pairing: PairingState = { kind: "idle" };
  #outbound: OutboundMessage | null = null;
  #pending: string[] = [];
  #partialAck: { msgId: number; mask: number } | null = null;
  #ackExtensions = 0;
  #listen: ListenHandle | null = null;
  #unsubscribe: Unsubscribe | null = null;
  #stopped = false;
  #chain: Promise<void> = Promise.resolve();
  readonly #timers: Record<TimerKey, ReturnType<typeof setTimeout> | undefined> = {
    ack: undefined,
    backoff: undefined,
    partialAck: undefined,
    pair: undefined,
    quiet: undefined,
  };
  /** True from the moment we hear a block until the quiet timer says otherwise. */
  #heardRecently = false;
  /** The single reply we owe the peer once the channel goes quiet. */
  #replyAfterQuiet: (() => void) | null = null;
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
    const keys = await derivePairingKeys(code);
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
    this.#listen ??= startListening({
      context: this.#options.context,
      stream: this.#options.stream,
      codec: this.#options.codec,
      onDecoded: (block) => this.#onDecodedBlock(block),
      onModuleError: (error) => this.#moduleFailed(error),
      onDecodedError: (error) => this.#reportListenerError(error),
    });
    this.#unsubscribe ??= onVisibilityChange((hidden) => this.#onVisibility(hidden));
    this.#beginPairing();
  }

  /**
   * Leaves `module_error`/`error` and returns to a startable state. Refuses when
   * the codec itself is dead: that is terminal for the page session (measured —
   * a trap leaves the C++ state undefined), so the honest recovery is a reload,
   * offered by the UI as "restart Sound Chat". No loop, no retry storm.
   */
  restart(): { ok: true } | { ok: false; reason: "codec-dead" } {
    if (this.#options.codec.state !== "ready") return { ok: false, reason: "codec-dead" };
    this.#emit({ type: "RESTART" });
    return { ok: true };
  }

  /** Tears everything down. Idempotent, and safe with partial state. */
  stop(): void {
    this.#stopped = true;
    for (const key of ["ack", "backoff", "partialAck", "pair", "quiet"] as const) {
      this.#clearTimer(key);
    }
    this.#replyAfterQuiet = null;
    this.#unsubscribe?.();
    this.#unsubscribe = null;
    this.#listen?.stop();
    this.#listen = null;
    this.#outbound = null;
    this.#pending = [];
    this.#partialAck = null;
    this.#emit({ type: "STOP" });
  }

  /**
   * Queues one message. Never blocks and never throws: a full queue, an
   * unpaired session, an over-long body and a dead codec are all *refusals* the
   * UI turns into its own honest copy. Queueing while hidden (or while another
   * message is in flight) is what "hold the send" means.
   */
  send(text: string): SendResult {
    if (this.#stopped) return { ok: false, reason: "stopped" };
    if (this.#options.codec.state !== "ready") return { ok: false, reason: "module-error" };
    if (!isPaired(this.#pairing)) return { ok: false, reason: "not-paired" };
    const bytes = encoder.encode(text);
    if (bytes.length === 0) return { ok: false, reason: "empty" };
    if (bytes.length > MAX_MESSAGE_PLAINTEXT_BYTES) return { ok: false, reason: "too-long" };
    if (this.#pending.length >= MAX_PENDING_MESSAGES) return { ok: false, reason: "queue-full" };
    this.#pending.push(text);
    const queued = this.#outbound !== null;
    void this.#pump();
    return { ok: true, queued };
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
      void this.#transmitPairFrame();
    }
    this.#notify({ type: "pairing", state: this.#pairing });
  }

  async #transmitPairFrame(): Promise<void> {
    const frame = await this.#wire.buildPairFrame();
    this.#emit({ type: "TRANSMIT_BEGIN" });
    if (this.#state !== "transmitting") return;
    if (!this.#play(frame)) return;
    this.#emit({ type: "TRANSMIT_DONE_UNACKED" });
  }

  #onPairFrame(salt: Uint8Array): void {
    if (isPaired(this.#pairing)) return;
    if (
      this.#pairing.kind !== "waiting-for-peer" &&
      this.#pairing.kind !== "awaiting-confirmation"
    ) {
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
    // again — the same turn-gap rule the ACK path obeys.
    if (next.kind === "paired" && next.role === "displayer") {
      this.#afterTurnGap(() => void this.#transmitPairFrame());
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
    // Coming back: resume a held message before starting anything new.
    if (this.#outbound !== null) {
      void this.#transmitBlocks(pendingBlocks(this.#outbound));
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

  #onChannelQuiet(): void {
    // The machine goes back to `listening` *before* anything queued fires, so a
    // reply can never be refused for arriving a hair early.
    this.#emit({ type: "CHANNEL_QUIET" });
    const queuedReply = this.#replyAfterQuiet;
    this.#replyAfterQuiet = null;
    if (queuedReply !== null) queuedReply();
    if (this.#currentState() !== "listening") return;
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
   * Runs `action` once the channel is quiet — never inside the gap a peer's own
   * Rx feed needs after it transmitted (`TURN_GAP_MS`), and never while it might
   * still be transmitting the rest of a multi-block message. Exactly one reply
   * can be queued: a peer that owes us a reply owes us one.
   */
  #afterTurnGap(action: () => void): void {
    if (!this.#heardRecently) {
      action();
      return;
    }
    this.#replyAfterQuiet = action;
  }

  async #pump(): Promise<void> {
    if (this.#stopped || this.#outbound !== null || this.#pending.length === 0) return;
    if (!isPaired(this.#pairing)) return;
    const frames: Uint8Array[] = [];
    const msgId = this.#ids.next();
    const plaintext = encoder.encode(this.#pending[0] ?? "");
    try {
      frames.push(...(await this.#wire.buildMessageFrames(plaintext, msgId)));
    } catch (error) {
      // A body the protocol refuses: our own misuse, reported on the consumer
      // channel, and the queue keeps moving instead of stalling forever.
      this.#pending.shift();
      this.#reportListenerError(error);
      void this.#pump();
      return;
    }
    this.#pending.shift();
    this.#outbound = {
      msgId,
      plaintext,
      frames,
      blockCount: frames.length,
      attempts: 0,
      ackedMask: 0,
      status: "sending",
    };
    this.#notify({ type: "outbound", msgId, status: "sending", attempts: 0 });
    await this.#transmitBlocks(pendingBlocks(this.#outbound));
  }

  async #transmitBlocks(indices: number[]): Promise<void> {
    const outbound = this.#outbound;
    if (outbound === null || indices.length === 0 || this.#stopped) return;
    if (outbound.attempts >= MAX_SEND_ATTEMPTS) {
      this.#failOutbound(outbound);
      return;
    }
    outbound.attempts += 1;
    if (outbound.attempts > 1) {
      this.#stats.retries += 1;
      this.#notify({
        type: "outbound",
        msgId: outbound.msgId,
        status: outbound.status,
        attempts: outbound.attempts,
      });
    }
    this.#emit({ type: "TRANSMIT_BEGIN" });
    if (this.#state !== "transmitting") return;
    for (const index of indices) {
      // A tab that goes hidden mid-message stops the remaining blocks here: the
      // machine is in hidden_hold by then and refuses to start audio anyway.
      if (this.#state !== "transmitting") return;
      const frame = outbound.frames[index];
      if (frame === undefined) continue;
      if (!this.#play(frame)) return;
    }
    this.#emit({ type: "TRANSMIT_DONE" });
    this.#armAckTimer();
  }

  #play(frame: Uint8Array): boolean {
    const listen = this.#listen;
    if (listen === null) return false;
    try {
      transmitAndPause(listen, this.#options.context, this.#options.codec, frame);
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
    this.#notify({
      type: "outbound",
      msgId: outbound.msgId,
      status: "failed",
      attempts: outbound.attempts,
    });
    this.#outbound = null;
    this.#ackExtensions = 0;
    this.#emit({ type: "BACKOFF_EXPIRED" });
    void this.#pump();
  }

  #armAckTimer(): void {
    this.#clearTimer("ack");
    this.#timers.ack = setTimeout(() => {
      this.#timers.ack = undefined;
      this.#onAckDeadline();
    }, ACK_TIMEOUT_MS);
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
    this.#stats.blocksDecoded += 1;
    this.#noteHeard();
    const outcome = await this.#wire.parse(block);
    if (!outcome.ok) {
      this.#stats.framesUnreadable += 1;
      this.#emit({ type: "HEARD_UNREADABLE" });
      this.#notify({
        type: "heard-unreadable",
        reason: outcome.reason,
        count: this.#stats.framesUnreadable,
      });
      if (outcome.reason === "auth-failed") this.#onPairRejected();
      this.#extendAckDeadline();
      return;
    }
    const frame = outcome.frame;
    if (frame.kind === "pair") {
      this.#onPairFrame(frame.salt);
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
    this.#clearTimer("ack");
    this.#ackExtensions = 0;
    const status = applyAck(outbound, mask);
    this.#notify({ type: "outbound", msgId, status, attempts: outbound.attempts });
    this.#emit({ type: "ACK_RECEIVED" });
    if (status === "sent") {
      this.#outbound = null;
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
        void this.#sendAck(outcome.msgId, fullMask(outcome.blockCount));
        break;
      case "partial":
        this.#partialAck = { msgId: outcome.msgId, mask: outcome.mask };
        this.#schedulePartialAck();
        break;
      case "duplicate":
        // Already rendered; re-ACK so a lost acknowledgement cannot make the
        // sender retry for ever (the codec redelivers every block 2-4 times).
        this.#stats.duplicatesSuppressed += 1;
        void this.#sendAck(outcome.msgId, outcome.mask);
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
    const frame = await this.#wire.buildAckFrame(msgId, mask);
    // The ACK goes out only after the peer's own Rx feed is listening again.
    this.#afterTurnGap(() => {
      this.#emit({ type: "TRANSMIT_BEGIN" });
      // The channel is not ours right now (mid-message, hidden, or in backoff):
      // the peer's own ACK timeout retries, so dropping this one loses nothing.
      if (this.#currentState() !== "transmitting") return;
      if (!this.#play(frame)) return;
      this.#stats.acksSent += 1;
      this.#emit({ type: "TRANSMIT_DONE_UNACKED" });
    });
  }

  #schedulePartialAck(): void {
    this.#clearTimer("partialAck");
    this.#timers.partialAck = setTimeout(() => {
      this.#timers.partialAck = undefined;
      const pendingAck = this.#partialAck;
      this.#partialAck = null;
      if (pendingAck === null) return;
      void this.#sendAck(pendingAck.msgId, pendingAck.mask);
    }, PARTIAL_ACK_DELAY_MS);
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
    this.#armAckTimer();
  }

  /** Terminal for the session: report once, cancel every retry, never loop. */
  #moduleFailed(error: unknown): void {
    this.#emit({ type: "MODULE_DIED" });
    for (const key of ["ack", "backoff", "partialAck", "quiet"] as const) {
      this.#clearTimer(key);
    }
    this.#replyAfterQuiet = null;
    const outbound = this.#outbound;
    if (outbound !== null) {
      outbound.status = "failed";
      this.#notify({
        type: "outbound",
        msgId: outbound.msgId,
        status: "failed",
        attempts: outbound.attempts,
      });
    }
    this.#outbound = null;
    this.#pending = [];
    this.#options.onModuleError?.(error);
  }

  /** A consumer of ours threw: its own channel, never a codec verdict. */
  #reportListenerError(error: unknown): void {
    if (this.#options.onListenerError !== undefined) {
      this.#options.onListenerError(error);
      return;
    }
    console.error("Sound Chat: a session consumer threw", error);
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
    const timer = this.#timers[key];
    if (timer !== undefined) {
      clearTimeout(timer);
      this.#timers[key] = undefined;
    }
  }
}
