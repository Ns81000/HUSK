/**
 * Sound Chat's wire protocol: the frames that go into the fixed 64-byte ggwave
 * blocks, the framing rules, the inbound dedupe/assembly state and the outbound
 * retry policy.
 *
 * Master plan Section 4 locks the single-block MESSAGE shape:
 *
 * ```
 * byte 0      frameKind (the version byte: wire version 1's reserved values)
 * bytes 1-2   msgId, big-endian
 * byte 3      fromPeerId (0 | 1)
 * byte 4      len — real bytes of the body
 * bytes 5..   AEAD ciphertext + 16-byte tag, zero-padded to the end of the block
 * ```
 *
 * Phase 2 finalises the two extensions Section 4 left open, both as reserved
 * values of that same version byte (the plan's own device for the ACK frame):
 *
 * | kind | name          | header | body                                                  |
 * | ---: | :------------ | -----: | :---------------------------------------------------- |
 * |    1 | MESSAGE       | 5      | `ct(len) ‖ tag(16) ‖ zeros` → 43 plaintext bytes       |
 * |    2 | ACK           | 5      | `ct(1) ‖ tag(16) ‖ zeros` → one received-blocks bitmask|
 * |    3 | MESSAGE_MULTI | 6      | `byte 5 = seq`, then `ct(len) ‖ tag(16) ‖ zeros` → 42  |
 * |    4 | PAIR          | 5      | `salt(16) ‖ challenge(8) ‖ keyCheck(16) ‖ zeros` - HMAC over a domain-separated `salt/challenge/role`, never AEAD; `len` = 24 |
 *
 * `seq = (blockIndex << 4) | blockCount`, so a 2-block message is seq `0x02`
 * then `0x12`; `blockCount` is capped at `MAX_MESSAGE_BLOCKS` (2), which is the
 * plan's two-block cap. Capacity is therefore **measured, not estimated**: 43
 * plaintext bytes in one block, 42 per block in a multi-block message (the `seq`
 * byte costs one), i.e. **84 bytes** for the 2-block cap — see
 * `MAX_MESSAGE_PLAINTEXT_BYTES` and `capacity.test.ts`.
 *
 * AAD rule: everything a receiver can see *except* the ciphertext and tag — the
 * header bytes plus the zero padding. Flipping any byte of a frame therefore
 * fails the tag; it binds `ver`(kind), `msgId`, `fromPeerId`, `len` and `seq`
 * exactly as master plan Section 10.2 P3 requires.
 *
 * A failed tag is an outcome, never an exception and never a rendered message
 * (P5), and it is *distinguishable* from silence (P6) because the caller only
 * gets here when the codec actually produced a 64-byte block.
 */

import { CODEC_PAYLOAD_LENGTH } from "./codec";
import {
  AEAD_TAG_BYTES,
  assertPeerId,
  PAIR_CHALLENGE_BYTES,
  SESSION_SALT_BYTES,
  buildNonce,
  keyCheckTag,
  openBlock,
  sealBlock,
  verifyKeyCheck,
  type PairingKeys,
  type PeerId,
} from "./crypto";

/** Every frame is exactly one locked codec block. */
export const WIRE_BLOCK_BYTES = CODEC_PAYLOAD_LENGTH;
export const HEADER_BYTES = 5;
export const MULTI_HEADER_BYTES = 6;
/** A PAIR frame's body: our session salt plus the challenge we are answering. */
export const PAIR_BODY_BYTES = SESSION_SALT_BYTES + PAIR_CHALLENGE_BYTES;
export const PAIR_KEY_CHECK_OFFSET = HEADER_BYTES + PAIR_BODY_BYTES;
export const TAG_BYTES = AEAD_TAG_BYTES;

/** Reserved version-byte values. Anything else is an unknown frame. */
export const FRAME_KIND = {
  MESSAGE: 1,
  ACK: 2,
  MESSAGE_MULTI: 3,
  PAIR: 4,
} as const;

export type FrameKind = (typeof FRAME_KIND)[keyof typeof FRAME_KIND];

/** The plan's two-block cap; `seq`'s count nibble must equal this exactly. */
export const MAX_MESSAGE_BLOCKS = 2;
/** 64 − 5-byte header − 16-byte tag. */
export const SINGLE_BLOCK_PLAINTEXT_BYTES = WIRE_BLOCK_BYTES - HEADER_BYTES - TAG_BYTES;
/** 64 − 6-byte header (the extra byte is `seq`) − 16-byte tag. */
export const MULTI_BLOCK_PLAINTEXT_BYTES = WIRE_BLOCK_BYTES - MULTI_HEADER_BYTES - TAG_BYTES;
/** What a user may actually type into one message: 2 × 42 bytes. */
export const MAX_MESSAGE_PLAINTEXT_BYTES = MULTI_BLOCK_PLAINTEXT_BYTES * MAX_MESSAGE_BLOCKS;
/** The same budget for the plain-ASCII copy the composer will count. */
export const MAX_MESSAGE_ASCII_CHARACTERS = MAX_MESSAGE_PLAINTEXT_BYTES;

/**
 * How many 64-byte blocks `bytes` of plaintext needs, or `null` when it cannot
 * fit inside the two-block cap.
 *
 * THE single implementation of that arithmetic. The composer's estimate, the
 * session's accept-time estimate and the sealed `blockCount` all have to agree —
 * a queued row that quoted one block for a two-block note is a progress bar that
 * lies — so this lives beside the constants it derives from and everything else
 * calls it. The two-block path carries one byte less per block than the
 * single-block path, which is why 43 and 84 are the two interesting boundaries
 * rather than 43 and 86.
 */
export function blocksForPlaintextBytes(bytes: number): number | null {
  if (bytes <= 0) return 0;
  if (bytes <= SINGLE_BLOCK_PLAINTEXT_BYTES) return 1;
  if (bytes <= MAX_MESSAGE_PLAINTEXT_BYTES) return MAX_MESSAGE_BLOCKS;
  return null;
}

/** How long an incomplete multi-block message is held before it is dropped. */
export const PARTIAL_MESSAGE_TTL_MS = 30_000;
/** Bounded assembly state: at most this many partial messages are remembered. */
export const MAX_PARTIAL_MESSAGES = 4;

/** Our own misuse of the protocol API. */
export class ProtocolUsageError extends Error {
  override readonly name: string = "ProtocolUsageError";
}

/** A message longer than the two-block cap can never be sent. */
export class MessageTooLongError extends ProtocolUsageError {
  override readonly name = "MessageTooLongError";
  constructor(bytes: number) {
    super(
      `a Sound Chat message carries at most ${MAX_MESSAGE_PLAINTEXT_BYTES} bytes ` +
        `(${MAX_MESSAGE_BLOCKS} blocks); that one is ${bytes}`,
    );
  }
}

/** The session ran out of message ids — bounded state, not a wrap-around. */
export class MessageIdExhaustedError extends ProtocolUsageError {
  override readonly name = "MessageIdExhaustedError";
  constructor() {
    super("this session has used all 65536 message ids; pair again to start a new session");
  }
}

export type ParsedFrame =
  | {
      kind: "message";
      msgId: number;
      blockIndex: number;
      blockCount: number;
      plaintext: Uint8Array;
    }
  | { kind: "ack"; msgId: number; mask: number }
  | { kind: "pair"; peerId: PeerId; salt: Uint8Array; challenge: Uint8Array };

/**
 * Every way a *received* block can fail to become a frame. All of them are
 * reported as "nothing decoded" to the user; the codec itself cannot tell us
 * more than that (deep dive §3.1). `auth-failed` is the AEAD/key-confirmation
 * case, which is the one the UI turns into "a transmission was heard but this
 * pairing code cannot read it" (P6).
 */
export type FrameRejection =
  | "short-frame"
  | "unknown-kind"
  | "bad-length"
  | "nonzero-padding"
  | "bad-seq"
  | "bad-peer"
  | "reserved-field"
  | "auth-failed";

export type ParseOutcome = { ok: true; frame: ParsedFrame } | { ok: false; reason: FrameRejection };

/** `seq`'s two nibbles: which block of how many. */
export function encodeSeq(blockIndex: number, blockCount: number): number {
  if (
    !Number.isInteger(blockIndex) ||
    !Number.isInteger(blockCount) ||
    blockIndex < 0 ||
    blockCount < 1 ||
    blockIndex >= blockCount ||
    blockCount > MAX_MESSAGE_BLOCKS ||
    blockCount > 16 ||
    blockIndex > 15
  ) {
    throw new ProtocolUsageError(`seq ${blockIndex}/${blockCount} is outside the wire format`);
  }
  return ((blockIndex << 4) | blockCount) & 0xff;
}

/** The two nibbles a multi-block `seq` byte carries. */
export type SeqParts = {
  blockIndex: number;
  blockCount: number;
};

export function decodeSeq(seq: number): SeqParts {
  return { blockIndex: (seq >> 4) & 0x0f, blockCount: seq & 0x0f };
}

/** Big-endian 16-bit message id, as the locked layout specifies. */
function readMsgId(block: Uint8Array): number {
  return ((block[1] ?? 0) << 8) | (block[2] ?? 0);
}

function writeMsgId(block: Uint8Array, msgId: number): void {
  block[1] = (msgId >> 8) & 0xff;
  block[2] = msgId & 0xff;
}

/**
 * The authenticated-but-unencrypted bytes of a frame: header plus zero padding.
 * Both the sealer and the opener compute it the same way, from data that is on
 * the wire, so they agree without either side trusting the other.
 */
export function frameAad(frame: Uint8Array, headerBytes: number, len: number): Uint8Array {
  const bodyStart = headerBytes + len + TAG_BYTES;
  // Every part is checked, not just the total: a negative `len` used to make
  // `bodyStart` land *inside* the header and silently produce a shorter AAD
  // (P2V finding 16). Unreachable from `#open`, which validates `len` first, but
  // this is a boundary the function itself must refuse.
  if (!Number.isInteger(headerBytes) || headerBytes < 0 || headerBytes > frame.length) {
    throw new ProtocolUsageError(`header of ${headerBytes} bytes does not fit the frame`);
  }
  if (!Number.isInteger(len) || len < 0) {
    throw new ProtocolUsageError(`body length ${len} is not a non-negative integer`);
  }
  if (bodyStart > frame.length) {
    throw new ProtocolUsageError(
      `frame body of ${len} bytes does not fit a ${frame.length}-byte block`,
    );
  }
  const aad = new Uint8Array(headerBytes + (frame.length - bodyStart));
  aad.set(frame.subarray(0, headerBytes), 0);
  aad.set(frame.subarray(bodyStart), headerBytes);
  return aad;
}

export function isAllZero(bytes: Uint8Array): boolean {
  for (const byte of bytes) {
    if (byte !== 0) return false;
  }
  return true;
}

/** Builds one wire block from header fields plus an already-sealed body. */
function assembleFrame(
  kind: FrameKind,
  msgId: number,
  fromPeerId: PeerId,
  len: number,
  sealed: Uint8Array,
  seq?: number,
): Uint8Array {
  const headerBytes = kind === FRAME_KIND.MESSAGE_MULTI ? MULTI_HEADER_BYTES : HEADER_BYTES;
  const block = new Uint8Array(WIRE_BLOCK_BYTES);
  block[0] = kind;
  writeMsgId(block, msgId);
  block[3] = fromPeerId;
  block[4] = len;
  if (headerBytes === MULTI_HEADER_BYTES) {
    block[5] = seq ?? 0;
  }
  block.set(sealed, headerBytes);
  return block;
}

/** The standard 1-byte ACK mask for a message of `blockCount` blocks. */
export function fullMask(blockCount: number): number {
  return blockCount >= 8 ? 0xff : (1 << blockCount) - 1;
}

export function maskHasBlock(mask: number, index: number): boolean {
  return (mask & (1 << index)) !== 0;
}

/** A header field holds a value the wire format reserves for something else. */
export const PAIR_KEY_CHECK_BYTES = 16;

export type FrameCodecOptions = {
  keys: PairingKeys;
  /** Which of the two peers this device is. */
  selfId: PeerId;
  /** This device's own random session salt: the nonce salt of our direction. */
  sendSalt: Uint8Array;
};

/**
 * Builds and parses wire frames for one paired session. The peer's salt is
 * learned from its PAIR frame, so before that a MESSAGE frame cannot even have
 * its nonce reconstructed — which is the honest outcome: unreadable.
 */
export class FrameCodec {
  readonly #keys: PairingKeys;
  readonly #selfId: PeerId;
  readonly #peerId: PeerId;
  readonly #sendSalt: Uint8Array;
  #peerSalt: Uint8Array | null = null;

  constructor(options: FrameCodecOptions) {
    assertPeerId(options.selfId);
    if (options.sendSalt.length !== SESSION_SALT_BYTES) {
      throw new ProtocolUsageError(
        `session salt of ${options.sendSalt.length} bytes, expected ${SESSION_SALT_BYTES}`,
      );
    }
    this.#keys = options.keys;
    this.#selfId = options.selfId;
    this.#peerId = options.selfId === 0 ? 1 : 0;
    this.#sendSalt = Uint8Array.from(options.sendSalt);
  }

  /** Our own salt, safe to show: it is public and worthless without the key. */
  get sendSalt(): Uint8Array {
    return this.#sendSalt;
  }

  get paired(): boolean {
    return this.#peerSalt !== null;
  }

  /**
   * Learns the peer's salt from its verified PAIR frame. Refusing a *different*
   * salt on an already-paired codec is deliberate: re-pairing is a new session,
   * and a replayed PAIR frame must not be able to move the nonce space under a
   * running conversation.
   */
  adoptPeerSalt(salt: Uint8Array): void {
    if (salt.length !== SESSION_SALT_BYTES) {
      throw new ProtocolUsageError(`peer salt of ${salt.length} bytes is the wrong length`);
    }
    if (this.#peerSalt !== null) {
      if (this.#peerSalt.every((byte, index) => byte === salt[index])) return;
      throw new ProtocolUsageError(
        "this codec already belongs to a paired session; re-pairing needs a new session",
      );
    }
    this.#peerSalt = Uint8Array.from(salt);
  }

  /**
   * Splits a message into 1 or 2 sealed frames. Refuses an empty body (a frame
   * always carries one) and anything past the two-block cap rather than letting
   * the C++ layer silently truncate it.
   */
  async buildMessageFrames(plaintext: Uint8Array, msgId: number): Promise<Uint8Array[]> {
    assertMsgId(msgId);
    if (plaintext.length === 0) {
      throw new ProtocolUsageError("refusing to send an empty message");
    }
    if (plaintext.length > MAX_MESSAGE_PLAINTEXT_BYTES) {
      throw new MessageTooLongError(plaintext.length);
    }
    const multi = plaintext.length > SINGLE_BLOCK_PLAINTEXT_BYTES;
    const kind = multi ? FRAME_KIND.MESSAGE_MULTI : FRAME_KIND.MESSAGE;
    const headerBytes = multi ? MULTI_HEADER_BYTES : HEADER_BYTES;
    const capacity = multi ? MULTI_BLOCK_PLAINTEXT_BYTES : SINGLE_BLOCK_PLAINTEXT_BYTES;
    const blockCount = multi ? MAX_MESSAGE_BLOCKS : 1;
    const key = await this.#keys.directionKey(this.#selfId);
    const frames: Uint8Array[] = [];
    for (let index = 0; index < blockCount; index += 1) {
      const slice = plaintext.subarray(index * capacity, (index + 1) * capacity);
      const seq = multi ? encodeSeq(index, blockCount) : 0;
      const nonce = buildNonce({ salt: this.#sendSalt, frameKind: kind, msgId, seq });
      const aad = headerAad({
        kind,
        msgId,
        fromPeerId: this.#selfId,
        len: slice.length,
        headerBytes,
        seq,
      });
      const sealed = await sealBlock(key, nonce, aad, slice);
      frames.push(assembleFrame(kind, msgId, this.#selfId, slice.length, sealed, seq));
    }
    return frames;
  }

  /** One ACK frame: a 1-byte bitmask of the blocks that were authenticated. */
  async buildAckFrame(msgId: number, mask: number): Promise<Uint8Array> {
    assertMsgId(msgId);
    if (!Number.isInteger(mask) || mask < 0 || mask > 0xff) {
      throw new ProtocolUsageError(`ack mask ${mask} is not a single byte`);
    }
    const key = await this.#keys.directionKey(this.#selfId);
    const nonce = buildNonce({ salt: this.#sendSalt, frameKind: FRAME_KIND.ACK, msgId, seq: 0 });
    const aad = headerAad({
      kind: FRAME_KIND.ACK,
      msgId,
      fromPeerId: this.#selfId,
      len: 1,
      headerBytes: HEADER_BYTES,
      seq: 0,
    });
    const sealed = await sealBlock(key, nonce, aad, Uint8Array.of(mask));
    return assembleFrame(FRAME_KIND.ACK, msgId, this.#selfId, 1, sealed);
  }

  /**
   * The pairing key confirmation. Never AEAD: it is sent before either side
   * knows the other's salt, so it cannot use the per-direction nonce space.
   *
   * It covers the session challenge, not just the salt, and that is what makes a
   * recorded PAIR frame worthless to a later session: the challenge is fresh per
   * handshake, so a recording either fails the tag or — when a recording of
   * *this* session is replayed — is rejected because it does not echo the
   * challenge the initiator invented (P2V finding 2). The initiator passes its
   * own challenge; the responder passes back the one it received.
   */
  async buildPairFrame(challenge: Uint8Array): Promise<Uint8Array> {
    const tag = await keyCheckTag(this.#keys.mac, this.#sendSalt, challenge, this.#selfId);
    const block = new Uint8Array(WIRE_BLOCK_BYTES);
    block[0] = FRAME_KIND.PAIR;
    writeMsgId(block, 0);
    block[3] = this.#selfId;
    block[4] = PAIR_BODY_BYTES;
    block.set(this.#sendSalt, HEADER_BYTES);
    block.set(challenge, HEADER_BYTES + SESSION_SALT_BYTES);
    block.set(tag, PAIR_KEY_CHECK_OFFSET);
    return block;
  }

  /**
   * Total on hostile input: every failure is a *reason*, never an exception.
   * Only our own misuse (a salt we cannot even build a nonce from) throws.
   */
  async parse(block: Uint8Array): Promise<ParseOutcome> {
    if (block.length !== WIRE_BLOCK_BYTES) return { ok: false, reason: "short-frame" };
    const kind = block[0] ?? 0;
    const msgId = readMsgId(block);
    const fromPeerId = block[3] ?? 0xff;
    if (fromPeerId > 1) return { ok: false, reason: "bad-peer" };
    if (fromPeerId !== this.#peerId) return { ok: false, reason: "bad-peer" };
    switch (kind) {
      case FRAME_KIND.MESSAGE:
        return await this.#openMessage(
          block,
          kind,
          msgId,
          HEADER_BYTES,
          SINGLE_BLOCK_PLAINTEXT_BYTES,
        );
      case FRAME_KIND.MESSAGE_MULTI:
        return await this.#openMessage(
          block,
          kind,
          msgId,
          MULTI_HEADER_BYTES,
          MULTI_BLOCK_PLAINTEXT_BYTES,
        );
      case FRAME_KIND.ACK:
        return await this.#openAck(block, msgId);
      case FRAME_KIND.PAIR:
        return await this.#openPair(block, msgId);
      default:
        return { ok: false, reason: "unknown-kind" };
    }
  }

  async #openMessage(
    block: Uint8Array,
    kind: FrameKind,
    msgId: number,
    headerBytes: number,
    capacity: number,
  ): Promise<ParseOutcome> {
    const len = block[4] ?? 0;
    if (len === 0 || len > capacity) return { ok: false, reason: "bad-length" };
    const seq = headerBytes === MULTI_HEADER_BYTES ? (block[5] ?? 0) : 0;
    let blockCount = 1;
    if (headerBytes === MULTI_HEADER_BYTES) {
      const decoded = decodeSeq(seq);
      blockCount = decoded.blockCount;
      if (blockCount !== MAX_MESSAGE_BLOCKS || decoded.blockIndex >= blockCount) {
        return { ok: false, reason: "bad-seq" };
      }
    }
    const opened = await this.#open(block, kind, msgId, seq, len, headerBytes);
    if (!opened.ok) return { ok: false, reason: opened.reason };
    if (opened.plaintext.length !== len) return { ok: false, reason: "bad-length" };
    return {
      ok: true,
      frame: {
        kind: "message",
        msgId,
        blockIndex: headerBytes === MULTI_HEADER_BYTES ? decodeSeq(seq).blockIndex : 0,
        blockCount,
        plaintext: opened.plaintext,
      },
    };
  }

  async #openAck(block: Uint8Array, msgId: number): Promise<ParseOutcome> {
    const len = block[4] ?? 0;
    if (len !== 1) return { ok: false, reason: "bad-length" };
    const opened = await this.#open(block, FRAME_KIND.ACK, msgId, 0, len, HEADER_BYTES);
    if (!opened.ok) return { ok: false, reason: opened.reason };
    return { ok: true, frame: { kind: "ack", msgId, mask: opened.plaintext[0] ?? 0 } };
  }

  async #openPair(block: Uint8Array, msgId: number): Promise<ParseOutcome> {
    if (msgId !== 0) return { ok: false, reason: "reserved-field" };
    const len = block[4] ?? 0;
    if (len !== PAIR_BODY_BYTES) return { ok: false, reason: "bad-length" };
    if (!isAllZero(block.subarray(PAIR_KEY_CHECK_OFFSET + PAIR_KEY_CHECK_BYTES))) {
      return { ok: false, reason: "nonzero-padding" };
    }
    const salt = Uint8Array.from(
      block.subarray(HEADER_BYTES, PAIR_KEY_CHECK_OFFSET - PAIR_CHALLENGE_BYTES),
    );
    const challenge = Uint8Array.from(
      block.subarray(PAIR_KEY_CHECK_OFFSET - PAIR_CHALLENGE_BYTES, PAIR_KEY_CHECK_OFFSET),
    );
    const tag = block.subarray(PAIR_KEY_CHECK_OFFSET, PAIR_KEY_CHECK_OFFSET + PAIR_KEY_CHECK_BYTES);
    if (!(await verifyKeyCheck(this.#keys.mac, salt, challenge, this.#peerId, tag))) {
      return { ok: false, reason: "auth-failed" };
    }
    return { ok: true, frame: { kind: "pair", peerId: this.#peerId, salt, challenge } };
  }

  async #open(
    block: Uint8Array,
    kind: FrameKind,
    msgId: number,
    seq: number,
    len: number,
    headerBytes: number,
  ): Promise<
    { ok: true; plaintext: Uint8Array } | { ok: false; reason: "nonzero-padding" | "auth-failed" }
  > {
    const bodyEnd = headerBytes + len + TAG_BYTES;
    if (!isAllZero(block.subarray(bodyEnd))) return { ok: false, reason: "nonzero-padding" };
    const salt = this.#peerSalt;
    if (salt === null) return { ok: false, reason: "auth-failed" };
    const key = await this.#keys.directionKey(this.#peerId);
    const nonce = buildNonce({ salt, frameKind: kind, msgId, seq });
    const aad = frameAad(block, headerBytes, len);
    const opened = await openBlock(key, nonce, aad, block.subarray(headerBytes, bodyEnd));
    // "wrong shape" and "wrong tag" are the same verdict to a receiver: nothing
    // decoded (P5). Only our own misuse throws, and it never gets this far.
    if (!opened.ok) return { ok: false, reason: "auth-failed" };
    return { ok: true, plaintext: opened.plaintext };
  }
}

function assertMsgId(msgId: number): void {
  if (!Number.isInteger(msgId) || msgId < 0 || msgId > 0xffff) {
    throw new ProtocolUsageError(`msgId ${msgId} is not a 16-bit unsigned integer`);
  }
}

/**
 * The AAD built from header fields, before the frame exists. Deliberately
 * identical to `frameAad(assembledFrame, headerBytes, len)` — the capacity test
 * asserts that equality, because a drift here would be invisible until a peer
 * stopped authenticating.
 */
function headerAad(fields: {
  kind: FrameKind;
  msgId: number;
  fromPeerId: PeerId;
  len: number;
  headerBytes: number;
  seq: number;
}): Uint8Array {
  const header = new Uint8Array(fields.headerBytes);
  header[0] = fields.kind;
  writeMsgId(header, fields.msgId);
  header[3] = fields.fromPeerId;
  header[4] = fields.len;
  if (fields.headerBytes === MULTI_HEADER_BYTES) header[5] = fields.seq;
  const paddingBytes = WIRE_BLOCK_BYTES - fields.headerBytes - fields.len - TAG_BYTES;
  const aad = new Uint8Array(fields.headerBytes + paddingBytes);
  aad.set(header, 0);
  return aad;
}

/** One authenticated message block, as handed to the assembler. */
export type MessageBlock = {
  msgId: number;
  blockIndex: number;
  blockCount: number;
  plaintext: Uint8Array;
};

export type DeliveryOutcome =
  | {
      status: "delivered";
      msgId: number;
      plaintext: Uint8Array;
      blockCount: number;
      mask: number;
    }
  | { status: "partial"; msgId: number; mask: number; blockCount: number }
  | { status: "duplicate"; msgId: number; mask: number; blockCount: number }
  | { status: "stale"; msgId: number }
  | { status: "conflict"; msgId: number; mask: number; blockCount: number };

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

/**
 * Inbound dedupe and multi-block assembly — bounded, in-memory, per session.
 *
 * Dedupe is a *high-water mark plus a per-message block set*, not a ring buffer
 * of recent ids: the sender allocates msgIds monotonically and never transmits a
 * lower id after a higher one, so any block at or below the mark is a
 * redelivery, a retry of a message the sender already gave up on, or a replay —
 * and none of those may be rendered a second time (P4). That is O(1) state, which
 * a ring of the last N ids cannot be while still rejecting a replay of message
 * #1 after message #300.
 */
export class InboundAssembler {
  readonly #maxPartial: number;
  readonly #ttlMs: number;
  readonly #now: () => number;
  readonly #partials = new Map<
    number,
    { mask: number; blockCount: number; blocks: Map<number, Uint8Array>; at: number }
  >();
  #highWater: number | null = null;

  constructor(options?: { maxPartialMessages?: number; ttlMs?: number; now?: () => number }) {
    this.#maxPartial = options?.maxPartialMessages ?? MAX_PARTIAL_MESSAGES;
    this.#ttlMs = options?.ttlMs ?? PARTIAL_MESSAGE_TTL_MS;
    this.#now = options?.now ?? (() => Date.now());
  }

  /** The highest msgId that was delivered whole, or null before the first one. */
  get highWater(): number | null {
    return this.#highWater;
  }

  /** Bounded state, exposed so a test can prove it never grows without limit. */
  get partialCount(): number {
    return this.#partials.size;
  }

  accept(frame: MessageBlock): DeliveryOutcome {
    const now = this.#now();
    this.#expire(now);
    const { msgId, blockIndex, blockCount, plaintext } = frame;
    if (blockIndex >= blockCount) {
      return { status: "conflict", msgId, mask: 0, blockCount };
    }
    if (this.#highWater !== null && msgId <= this.#highWater) {
      return msgId === this.#highWater
        ? { status: "duplicate", msgId, mask: fullMask(blockCount), blockCount }
        : { status: "stale", msgId };
    }

    let entry = this.#partials.get(msgId);
    if (entry !== undefined && entry.blockCount !== blockCount) {
      // Same id, different block structure: the sender never mixes the two.
      return { status: "conflict", msgId, mask: entry.mask, blockCount: entry.blockCount };
    }
    if (entry === undefined) {
      entry = { mask: 0, blockCount, blocks: new Map(), at: now };
      this.#admit(msgId, entry);
    }

    const existing = entry.blocks.get(blockIndex);
    if (existing !== undefined) {
      return sameBytes(existing, plaintext)
        ? { status: "duplicate", msgId, mask: entry.mask, blockCount }
        : { status: "conflict", msgId, mask: entry.mask, blockCount };
    }
    entry.blocks.set(blockIndex, plaintext);
    entry.mask |= 1 << blockIndex;
    entry.at = now;
    if (entry.mask !== fullMask(blockCount)) {
      return { status: "partial", msgId, mask: entry.mask, blockCount };
    }

    this.#partials.delete(msgId);
    this.#highWater = msgId;
    return {
      status: "delivered",
      msgId,
      mask: entry.mask,
      blockCount,
      plaintext: joinBlocks(entry.blocks, blockCount),
    };
  }

  #admit(
    msgId: number,
    entry: { mask: number; blockCount: number; blocks: Map<number, Uint8Array>; at: number },
  ): void {
    // A cap of zero means "admit nothing". The eviction loop used to break out
    // with the map still full and then admit anyway, so a configured cap of 0
    // silently behaved as 1 (P2V finding 15). Unreachable from the product, which
    // never passes options — but the exported class must honour its own bound.
    while (this.#partials.size >= this.#maxPartial) {
      const oldest = this.#partials.keys().next().value;
      if (oldest === undefined) return;
      this.#partials.delete(oldest);
    }
    this.#partials.set(msgId, entry);
  }

  #expire(now: number): void {
    for (const [msgId, entry] of this.#partials) {
      if (now - entry.at > this.#ttlMs) this.#partials.delete(msgId);
    }
  }
}

function joinBlocks(blocks: Map<number, Uint8Array>, blockCount: number): Uint8Array {
  const parts: Uint8Array[] = [];
  let total = 0;
  for (let index = 0; index < blockCount; index += 1) {
    const part = blocks.get(index);
    if (part === undefined) continue;
    parts.push(part);
    total += part.length;
  }
  const joined = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    joined.set(part, offset);
    offset += part.length;
  }
  return joined;
}

/**
 * Monotonic 16-bit message ids, seeded at a random point each session (the
 * session salt is what makes nonces fresh; the random seed only keeps two
 * recordings of different sessions from looking alike).
 *
 * Never wraps. AES-GCM nonce uniqueness inside one direction rests on "a msgId
 * is used for exactly one message, ever", so the allocator refuses rather than
 * returning to 0 — that is the guard behind Section 10.2 P2, and it makes all
 * protocol state bounded (P12).
 */
export class MessageIdAllocator {
  #next: number;

  constructor(start = 0) {
    if (!Number.isInteger(start) || start < 0 || start > 0xffff) {
      throw new ProtocolUsageError(`msgId start ${start} is not a 16-bit unsigned integer`);
    }
    this.#next = start;
  }

  next(): number {
    if (this.#next > 0xffff) throw new MessageIdExhaustedError();
    const value = this.#next;
    this.#next += 1;
    return value;
  }

  get remaining(): number {
    return 0x10000 - this.#next;
  }
}

/** How many times one message may be put on the air before it is a failure. */
export const MAX_SEND_ATTEMPTS = 3;

/**
 * One of our own messages, from acceptance to proof.
 *
 * `queued` is the state a note is in between `send()` accepting it and the pump
 * claiming it. It exists so the transcript can show a note that is already ours
 * but not yet on the air: without it, three notes accepted in one second produce
 * no rendered rows at all until the pump reaches them, and the screen says
 * "Queued" once, attributed to nothing.
 *
 * It is deliberately a *session* status rather than a UI invention. The session
 * owns the queue, so the session publishes what is in it and the UI renders what
 * it is told. A UI that published its own accepted-but-unclaimed rows and retired
 * them against the real ones later would be a second owner of transcript state,
 * which is the one thing this feature's controller exists to prevent.
 */
export type OutboundStatus = "queued" | "sending" | "sent" | "failed";

export type OutboundMessage = {
  /**
   * The session-local identity of the submission, assigned when `send()`
   * accepted it and carried unchanged through every later status.
   *
   * WHY this exists beside `msgId`: `msgId` is a 16-bit *wire* value the pump
   * allocates only after the note has been sealed, so it does not exist at the
   * one moment the UI most needs to name the note. `sendId` is the one counter
   * that spans the whole life of a submission, which is what makes a queued row
   * and its later `sending`/`sent`/`failed` row provably the same note: the key
   * is never reassigned, so a note can neither appear twice nor fall out between
   * two statuses.
   */
  readonly sendId: number;
  msgId: number;
  /** Kept for the composer/UI; never logged and never persisted (P9). */
  plaintext: Uint8Array;
  /**
   * Sealed exactly once. A retry re-transmits these bytes unchanged, so the
   * retry's nonce is reused with the *identical* plaintext — the one reuse case
   * AES-GCM tolerates, and the reason the retry does not re-encrypt.
   */
  frames: Uint8Array[];
  blockCount: number;
  attempts: number;
  ackedMask: number;
  status: OutboundStatus;
};

export function pendingBlocks(message: OutboundMessage): number[] {
  const pending: number[] = [];
  for (let index = 0; index < message.blockCount; index += 1) {
    if (!maskHasBlock(message.ackedMask, index)) pending.push(index);
  }
  return pending;
}

/**
 * Applies a received ACK mask. Only the bits the message actually has count;
 * anything above `blockCount` is ignored instead of being allowed to mark a
 * block that was never sent as received.
 */
export function applyAck(message: OutboundMessage, mask: number): OutboundStatus {
  message.ackedMask |= mask & fullMask(message.blockCount);
  if (message.ackedMask === fullMask(message.blockCount)) message.status = "sent";
  return message.status;
}

export type RetryDecision = { action: "retry"; blocks: number[] } | { action: "fail" };

/**
 * What to do after an ACK did not arrive in time. A partial ACK still means the
 * peer heard *something*, so only the missing blocks go back on the air, and the
 * msgId never changes (P11).
 */
export function decideRetry(
  message: OutboundMessage,
  maxAttempts = MAX_SEND_ATTEMPTS,
): RetryDecision {
  if (message.status === "sent") return { action: "retry", blocks: [] };
  if (message.attempts >= maxAttempts) return { action: "fail" };
  const blocks = pendingBlocks(message);
  if (blocks.length === 0) return { action: "fail" };
  return { action: "retry", blocks };
}
