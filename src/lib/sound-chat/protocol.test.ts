/**
 * Protocol tests for Phase 2 — the locked Section 4 wire format, the `seq`
 * extension, and the hostile-input set of master plan Section 10.3 (protocol and
 * crypto rows), each with the guard it violates.
 *
 * Frames here are built and parsed by the real code, with the real key schedule,
 * so a passing test means the bytes on the wire are what two peers exchange.
 */
import { describe, expect, it } from "vitest";
import {
  AEAD_TAG_BYTES,
  derivePairingKeys,
  PAIR_CHALLENGE_BYTES,
  SESSION_SALT_BYTES,
} from "./crypto";
import {
  applyAck,
  decideRetry,
  decodeSeq,
  encodeSeq,
  FRAME_KIND,
  frameAad,
  FrameCodec,
  fullMask,
  InboundAssembler,
  isAllZero,
  maskHasBlock,
  MAX_MESSAGE_BLOCKS,
  MAX_MESSAGE_PLAINTEXT_BYTES,
  MessageIdAllocator,
  MessageIdExhaustedError,
  MessageTooLongError,
  MULTI_BLOCK_PLAINTEXT_BYTES,
  PAIR_BODY_BYTES,
  MULTI_HEADER_BYTES,
  pendingBlocks,
  ProtocolUsageError,
  SINGLE_BLOCK_PLAINTEXT_BYTES,
  WIRE_BLOCK_BYTES,
  type OutboundMessage,
} from "./protocol";

/** A fixed handshake challenge; the session generates a fresh one per pairing. */
const TEST_CHALLENGE = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);

const CODE = "ABCD2345";
const SALT_A = new Uint8Array(16).fill(1);
const SALT_B = new Uint8Array(16).fill(2);

/** Two codecs that have completed the pairing handshake, ready to exchange. */
async function freshPairage(
  saltA: Uint8Array = SALT_A,
  saltB: Uint8Array = SALT_B,
): Promise<{ a: FrameCodec; b: FrameCodec }> {
  const keys = await derivePairingKeys(CODE);
  const a = new FrameCodec({ keys, selfId: 0, sendSalt: saltA });
  const b = new FrameCodec({ keys, selfId: 1, sendSalt: saltB });
  const aPair = await a.buildPairFrame(TEST_CHALLENGE);
  const bPair = await b.buildPairFrame(TEST_CHALLENGE);
  expect((await b.parse(aPair)).ok).toBe(true);
  expect((await a.parse(bPair)).ok).toBe(true);
  a.adoptPeerSalt(saltB);
  b.adoptPeerSalt(saltA);
  return { a, b };
}

function randomSalt(): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(16));
}

function bytes(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

describe("wire format", () => {
  it("carries a short message in one block, byte-exact, with the locked header", async () => {
    const { a, b } = await freshPairage();
    const frames = await a.buildMessageFrames(bytes("hello"), 0x1234);
    const block = frames[0] as Uint8Array;
    expect(frames).toHaveLength(1);
    expect(block).toHaveLength(WIRE_BLOCK_BYTES);
    expect(block[0]).toBe(FRAME_KIND.MESSAGE);
    expect(block[1]).toBe(0x12);
    expect(block[2]).toBe(0x34);
    expect(block[3]).toBe(0);
    expect(block[4]).toBe(5);
    expect(isAllZero(block.subarray(5 + 5 + AEAD_TAG_BYTES))).toBe(true);

    const parsed = await b.parse(block);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok || parsed.frame.kind !== "message") throw new Error("expected a message");
    expect(parsed.frame.msgId).toBe(0x1234);
    expect(parsed.frame.blockIndex).toBe(0);
    expect(parsed.frame.blockCount).toBe(1);
    expect(new TextDecoder().decode(parsed.frame.plaintext)).toBe("hello");
  });

  it("splits a long message into two blocks with the seq extension", async () => {
    const { a, b } = await freshPairage();
    const text = "x".repeat(MAX_MESSAGE_PLAINTEXT_BYTES);
    const frames = await a.buildMessageFrames(bytes(text), 7);
    expect(frames).toHaveLength(MAX_MESSAGE_BLOCKS);
    const first = frames[0] as Uint8Array;
    const second = frames[1] as Uint8Array;
    expect(first[0]).toBe(FRAME_KIND.MESSAGE_MULTI);
    expect(first[4]).toBe(MULTI_BLOCK_PLAINTEXT_BYTES);
    expect(decodeSeq(first[5] ?? 0)).toEqual({ blockIndex: 0, blockCount: 2 });
    expect(decodeSeq(second[5] ?? 0)).toEqual({ blockIndex: 1, blockCount: 2 });
    expect(encodeSeq(0, 2)).toBe(0x02);
    expect(encodeSeq(1, 2)).toBe(0x12);

    const one = await b.parse(first);
    const two = await b.parse(second);
    if (!one.ok || one.frame.kind !== "message") throw new Error("expected block 0");
    if (!two.ok || two.frame.kind !== "message") throw new Error("expected block 1");
    expect(one.frame.blockIndex).toBe(0);
    expect(one.frame.plaintext.length).toBe(MULTI_BLOCK_PLAINTEXT_BYTES);
    expect(two.frame.blockIndex).toBe(1);
    // The two blocks concatenate back to exactly what was sent.
    expect(
      new TextDecoder().decode(one.frame.plaintext) + new TextDecoder().decode(two.frame.plaintext),
    ).toBe(text);
  });

  it("round-trips an ACK mask and refuses a nonsense one", async () => {
    const { a, b } = await freshPairage();
    const ack = await a.buildAckFrame(9, 0b10);
    expect(ack[0]).toBe(FRAME_KIND.ACK);
    expect(ack[4]).toBe(1);
    const parsed = await b.parse(ack);
    if (!parsed.ok || parsed.frame.kind !== "ack") throw new Error("expected an ack");
    expect(parsed.frame.msgId).toBe(9);
    expect(parsed.frame.mask).toBe(0b10);
    await expect(a.buildAckFrame(9, 256)).rejects.toThrowError(ProtocolUsageError);
    await expect(a.buildAckFrame(-1, 1)).rejects.toThrowError(ProtocolUsageError);
  });

  it("sends the pairing frame as a key check, with the code never on the wire", async () => {
    const keys = await derivePairingKeys(CODE);
    const a = new FrameCodec({ keys, selfId: 0, sendSalt: SALT_A });
    const b = new FrameCodec({ keys, selfId: 1, sendSalt: SALT_B });
    const frame = await a.buildPairFrame(TEST_CHALLENGE);
    expect(frame[0]).toBe(FRAME_KIND.PAIR);
    // The body is the 16-byte salt plus the 8-byte session challenge, and the
    // key check covers both.
    expect(frame[4]).toBe(PAIR_BODY_BYTES);
    expect(PAIR_BODY_BYTES).toBe(SESSION_SALT_BYTES + PAIR_CHALLENGE_BYTES);
    expect(Array.from(frame.subarray(5, 5 + SESSION_SALT_BYTES))).toEqual(Array.from(SALT_A));
    expect(Array.from(frame.subarray(5 + SESSION_SALT_BYTES, 5 + PAIR_BODY_BYTES))).toEqual(
      Array.from(TEST_CHALLENGE),
    );
    expect(new TextDecoder().decode(frame)).not.toContain(CODE);
    const parsed = await b.parse(frame);
    expect(parsed.ok && parsed.frame.kind === "pair").toBe(true);
    // Before it learns a salt, a peer cannot read a message frame at all.
    expect(b.paired).toBe(false);
    b.adoptPeerSalt(SALT_A);
    expect(b.paired).toBe(true);
    // Re-pairing with a different salt is our own misuse, not a peer failure.
    expect(() => b.adoptPeerSalt(SALT_B)).toThrowError(ProtocolUsageError);
    expect(() => b.adoptPeerSalt(SALT_A)).not.toThrow();
  });
});

describe("hostile frames (Section 10.3, protocol row)", () => {
  it("refuses truncated and empty frames, and unknown frame kinds", async () => {
    const { b } = await freshPairage();
    expect(await b.parse(new Uint8Array(0))).toEqual({ ok: false, reason: "short-frame" });
    expect(await b.parse(new Uint8Array(WIRE_BLOCK_BYTES - 1))).toEqual({
      ok: false,
      reason: "short-frame",
    });
    expect(await b.parse(new Uint8Array(WIRE_BLOCK_BYTES + 1))).toEqual({
      ok: false,
      reason: "short-frame",
    });
    for (const kind of [0, 5, 0xff]) {
      const block = new Uint8Array(WIRE_BLOCK_BYTES);
      block[0] = kind;
      block[3] = 0;
      expect(await b.parse(block), `kind ${kind}`).toEqual({
        ok: false,
        reason: "unknown-kind",
      });
    }
  });

  it("refuses a reserved header value, a wrong peer, a bad length and dirty padding", async () => {
    const { a, b } = await freshPairage();
    // A PAIR frame whose reserved msgId field is not zero.
    const pair = await a.buildPairFrame(TEST_CHALLENGE);
    const reserved = Uint8Array.from(pair);
    reserved[2] = 1;
    expect(await b.parse(reserved)).toEqual({ ok: false, reason: "reserved-field" });

    // A frame claiming to come from an id that is neither peer, or from us.
    const message = (await a.buildMessageFrames(bytes("hi"), 3))[0] as Uint8Array;
    const wrongPeer = Uint8Array.from(message);
    wrongPeer[3] = 2;
    expect(await b.parse(wrongPeer)).toEqual({ ok: false, reason: "bad-peer" });
    const selfPeer = Uint8Array.from(message);
    selfPeer[3] = 1;
    expect(await b.parse(selfPeer)).toEqual({ ok: false, reason: "bad-peer" });

    // `len` that does not match the ciphertext: too large, and zero.
    const tooLong = Uint8Array.from(message);
    tooLong[4] = SINGLE_BLOCK_PLAINTEXT_BYTES + 1;
    expect(await b.parse(tooLong)).toEqual({ ok: false, reason: "bad-length" });
    const zeroLength = Uint8Array.from(message);
    zeroLength[4] = 0;
    expect(await b.parse(zeroLength)).toEqual({ ok: false, reason: "bad-length" });

    // A non-zero byte in the padding is a structural refusal.
    const dirtyPadding = Uint8Array.from(message);
    dirtyPadding[WIRE_BLOCK_BYTES - 1] = 1;
    expect(await b.parse(dirtyPadding)).toEqual({ ok: false, reason: "nonzero-padding" });

    // A multi-block seq that claims more blocks than the cap, or an index past
    // the count.
    const multi = (await a.buildMessageFrames(bytes("z".repeat(60)), 4))[0] as Uint8Array;
    const tooMany = Uint8Array.from(multi);
    tooMany[5] = encodeSeq(0, 2) === 0x02 ? 0x03 : 0;
    expect(await b.parse(tooMany)).toEqual({ ok: false, reason: "bad-seq" });
    const badIndex = Uint8Array.from(multi);
    badIndex[5] = encodeSeq(1, 2);
    expect(await b.parse(badIndex)).toEqual({ ok: false, reason: "auth-failed" });
  });

  it("fails authentication for a tampered ciphertext, tag or header byte (P3)", async () => {
    const { a, b } = await freshPairage();
    const message = (await a.buildMessageFrames(bytes("tamper me"), 11))[0] as Uint8Array;
    expect((await b.parse(message)).ok).toBe(true);

    const ciphertextFlip = Uint8Array.from(message);
    ciphertextFlip[5] = (ciphertextFlip[5] ?? 0) ^ 0x40;
    expect(await b.parse(ciphertextFlip)).toEqual({ ok: false, reason: "auth-failed" });

    const tagFlip = Uint8Array.from(message);
    const tagOffset = 5 + (message[4] ?? 0) + AEAD_TAG_BYTES - 1;
    tagFlip[tagOffset] = (tagFlip[tagOffset] ?? 0) ^ 0x01;
    expect(await b.parse(tagFlip)).toEqual({ ok: false, reason: "auth-failed" });

    // Every byte a receiver can see is authenticated: flip each in turn.
    for (let index = 0; index <= 4; index += 1) {
      const flipped = Uint8Array.from(message);
      flipped[index] = (flipped[index] ?? 0) ^ 0x01;
      const outcome = await b.parse(flipped);
      expect(outcome.ok, `header byte ${index}`).toBe(false);
    }
    // A rewritten envelope (a replayed frame pointed at another msgId) fails.
    const replayed = Uint8Array.from(message);
    replayed[1] = 0x00;
    replayed[2] = 0x63;
    expect(await b.parse(replayed)).toEqual({ ok: false, reason: "auth-failed" });
  });

  it("refuses a frame from another session or another pairing", async () => {
    const first = await freshPairage();
    const message = (await first.a.buildMessageFrames(bytes("cross-session"), 1))[0] as Uint8Array;
    // Same code, *fresh random* salts — what a reloaded session actually looks
    // like: the nonces differ, so the old frame cannot authenticate (P2).
    const second = await freshPairage(randomSalt(), randomSalt());
    expect(await second.b.parse(message)).toEqual({ ok: false, reason: "auth-failed" });
    // ...and a session that reused the same salts would *not* be protected. This
    // is asserted deliberately: it is the property the random salt buys.
    const reused = await freshPairage(SALT_A, SALT_B);
    expect(await reused.b.parse(message)).toMatchObject({ ok: true });
    // Different code entirely, same roles and salts: the key check still fails.
    const keys = await derivePairingKeys("ABCD2346");
    const stranger = new FrameCodec({ keys, selfId: 1, sendSalt: SALT_B });
    stranger.adoptPeerSalt(SALT_A);
    expect(await stranger.parse(message)).toEqual({ ok: false, reason: "auth-failed" });
    const strangerDisplayer = new FrameCodec({ keys, selfId: 0, sendSalt: SALT_A });
    expect(await first.b.parse(await strangerDisplayer.buildPairFrame(TEST_CHALLENGE))).toEqual({
      ok: false,
      reason: "auth-failed",
    });
  });
});

describe("wire invariants worth a test of their own", () => {
  it("uses one AAD rule for building and parsing, binding header and padding", async () => {
    const { a } = await freshPairage();
    const single = (await a.buildMessageFrames(bytes("abc"), 1))[0] as Uint8Array;
    const multi = (await a.buildMessageFrames(bytes("y".repeat(60)), 2))[0] as Uint8Array;
    const ack = await a.buildAckFrame(3, 1);
    const cases: { frame: Uint8Array; header: number }[] = [
      { frame: single, header: 5 },
      { frame: multi, header: MULTI_HEADER_BYTES },
      { frame: ack, header: 5 },
    ];
    for (const { frame, header } of cases) {
      const len = frame[4] ?? 0;
      const aad = frameAad(frame, header, len);
      expect(Array.from(aad.subarray(0, header))).toEqual(Array.from(frame.subarray(0, header)));
      expect(aad.length).toBe(header + WIRE_BLOCK_BYTES - header - len - AEAD_TAG_BYTES);
      expect(isAllZero(aad.subarray(header))).toBe(true);
    }
    expect(() => frameAad(new Uint8Array(WIRE_BLOCK_BYTES), 5, 200)).toThrowError(
      ProtocolUsageError,
    );
  });

  it("refuses an empty and an over-long body at build time", async () => {
    const { a } = await freshPairage();
    await expect(a.buildMessageFrames(new Uint8Array(0), 1)).rejects.toThrowError(
      ProtocolUsageError,
    );
    await expect(
      a.buildMessageFrames(new Uint8Array(MAX_MESSAGE_PLAINTEXT_BYTES + 1), 1),
    ).rejects.toThrowError(MessageTooLongError);
    expect(fullMask(2)).toBe(0b11);
    expect(maskHasBlock(0b10, 1)).toBe(true);
    expect(maskHasBlock(0b10, 0)).toBe(false);
    await expect(a.buildMessageFrames(bytes("x"), 0x10000)).rejects.toThrowError(
      ProtocolUsageError,
    );
  });
});

describe("inbound dedupe and assembly", () => {
  const block = (msgId: number, blockIndex: number, blockCount: number, text: string) => ({
    msgId,
    blockIndex,
    blockCount,
    plaintext: bytes(text),
  });

  it("assembles a two-block message out of order, once", () => {
    const assembler = new InboundAssembler();
    const first = assembler.accept(block(1, 1, 2, "world"));
    expect(first.status).toBe("partial");
    expect(first.status === "partial" && first.mask).toBe(0b10);
    const second = assembler.accept(block(1, 0, 2, "hello "));
    expect(second.status).toBe("delivered");
    if (second.status !== "delivered") throw new Error("expected delivery");
    expect(new TextDecoder().decode(second.plaintext)).toBe("hello world");
    expect(second.mask).toBe(0b11);
    expect(assembler.highWater).toBe(1);
    // The same block again: a redelivery, never a second render (P4).
    const again = assembler.accept(block(1, 0, 2, "hello "));
    expect(again.status).toBe("duplicate");
  });

  it("suppresses a replayed frame and a frame below the high-water mark (P4)", () => {
    const assembler = new InboundAssembler();
    expect(assembler.accept(block(5, 0, 1, "five")).status).toBe("delivered");
    expect(assembler.accept(block(6, 0, 1, "six")).status).toBe("delivered");
    // A capture of message 5, replayed after message 6: stale, never rendered.
    expect(assembler.accept(block(5, 0, 1, "five")).status).toBe("stale");
    // The newest message replayed: a duplicate.
    expect(assembler.accept(block(6, 0, 1, "six")).status).toBe("duplicate");
  });

  it("calls out a conflicting block instead of guessing", () => {
    const assembler = new InboundAssembler();
    expect(assembler.accept(block(3, 0, 2, "aaaa")).status).toBe("partial");
    // Same (msgId, seq) with different content can only come from a hostile
    // sender reusing a nonce; it must not overwrite what we already hold.
    expect(assembler.accept(block(3, 0, 2, "bbbb")).status).toBe("conflict");
    // Same id, different block structure: also inconsistent.
    expect(assembler.accept(block(3, 0, 1, "aaaa")).status).toBe("conflict");
    // An index outside the claimed count is refused outright.
    expect(assembler.accept(block(4, 2, 2, "cccc")).status).toBe("conflict");
  });

  it("keeps its state bounded however much hostile input arrives (P12)", () => {
    const assembler = new InboundAssembler({ maxPartialMessages: 3, ttlMs: 60_000 });
    for (let msgId = 0; msgId < 500; msgId += 1) {
      assembler.accept(block(1000 + msgId, 0, 2, `part-${msgId}`));
      expect(assembler.partialCount).toBeLessThanOrEqual(3);
    }
  });

  it("drops a partial message once its own window passes", () => {
    let now = 0;
    const assembler = new InboundAssembler({ ttlMs: 100, now: () => now });
    expect(assembler.accept(block(1, 0, 2, "later")).status).toBe("partial");
    expect(assembler.partialCount).toBe(1);
    now = 1_000;
    // A block of a *different* message after the window: the old partial is gone.
    expect(assembler.accept(block(2, 0, 2, "fresh")).status).toBe("partial");
    expect(assembler.partialCount).toBe(1);
    // And the expired message can no longer be completed, so it is never
    // delivered late; its second block starts a new partial under the new id.
    expect(assembler.accept(block(1, 1, 2, "later")).status).toBe("partial");
    expect(assembler.highWater).toBeNull();
  });
});

describe("message ids and retry policy", () => {
  it("allocates monotonically and refuses to wrap (P2, P12)", () => {
    const allocator = new MessageIdAllocator(0xfffd);
    expect(allocator.next()).toBe(0xfffd);
    expect(allocator.next()).toBe(0xfffe);
    expect(allocator.next()).toBe(0xffff);
    expect(allocator.remaining).toBe(0);
    expect(() => allocator.next()).toThrowError(MessageIdExhaustedError);
    expect(() => new MessageIdAllocator(-1)).toThrowError(ProtocolUsageError);
    expect(() => new MessageIdAllocator(0x10000)).toThrowError(ProtocolUsageError);
  });

  it("tracks a partial ACK, ignores bits past the block count, and counts attempts", () => {
    const message: OutboundMessage = {
      sendId: 1,
      msgId: 1,
      plaintext: bytes("hi"),
      frames: [new Uint8Array(WIRE_BLOCK_BYTES), new Uint8Array(WIRE_BLOCK_BYTES)],
      blockCount: 2,
      attempts: 1,
      ackedMask: 0,
      status: "sending",
    };
    expect(pendingBlocks(message)).toEqual([0, 1]);
    // A mask with a bit for a block that was never sent must not count it acked.
    expect(applyAck(message, 0b1001)).toBe("sending");
    expect(message.ackedMask).toBe(0b01);
    expect(pendingBlocks(message)).toEqual([1]);
    expect(applyAck(message, 0b10)).toBe("sent");
    expect(decideRetry(message)).toEqual({ action: "retry", blocks: [] });
  });

  it("gives up after the attempt cap instead of retrying for ever", () => {
    const message: OutboundMessage = {
      sendId: 2,
      msgId: 2,
      plaintext: bytes("hi"),
      frames: [new Uint8Array(WIRE_BLOCK_BYTES)],
      blockCount: 1,
      attempts: 3,
      ackedMask: 0,
      status: "sending",
    };
    expect(decideRetry(message)).toEqual({ action: "fail" });
    expect(decideRetry(message, 4)).toEqual({ action: "retry", blocks: [0] });
  });
});
