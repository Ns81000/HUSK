/**
 * Phase 2V deep dive — the wire format under exhaustive hostile input.
 *
 * `protocol.test.ts` pins the *shape* of the refusals it knows about
 * (truncation, a wrong kind, a dirty padding, five flipped header bytes). This
 * file goes after the boundaries the plan never enumerates: **every byte of
 * every frame kind, every one of the 256 `seq` values, every legal and illegal
 * plaintext length, every `len` and `msgId` boundary, and every `fromPeerId`
 * value** — through the real key schedule, so a pass means the bytes on the wire
 * really are what two peers exchange.
 *
 * Nothing here is mocked: `derivePairingKeys`, `sealBlock` and `openBlock` are
 * the product implementations, and a "refused" means the product refused.
 */
import { describe, expect, it } from "vitest";
import { AEAD_TAG_BYTES, buildNonce, derivePairingKeys, openBlock, sealBlock } from "./crypto";
import {
  decodeSeq,
  encodeSeq,
  frameAad,
  FrameCodec,
  fullMask,
  HEADER_BYTES,
  MAX_MESSAGE_BLOCKS,
  MAX_MESSAGE_PLAINTEXT_BYTES,
  MessageTooLongError,
  MULTI_BLOCK_PLAINTEXT_BYTES,
  MULTI_HEADER_BYTES,
  ProtocolUsageError,
  SINGLE_BLOCK_PLAINTEXT_BYTES,
  WIRE_BLOCK_BYTES,
} from "./protocol";

/** A fixed handshake challenge; the session generates a fresh one per pairing. */
const TEST_CHALLENGE = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);

const CODE = "ABCD2345";
const SALT_A = new Uint8Array(16).fill(0x11);
const SALT_B = new Uint8Array(16).fill(0x22);

/** One derived key schedule and one paired pair, shared by the whole file. */
const keys = await derivePairingKeys(CODE);
const a = new FrameCodec({ keys, selfId: 0, sendSalt: SALT_A });
const b = new FrameCodec({ keys, selfId: 1, sendSalt: SALT_B });
a.adoptPeerSalt(SALT_B);
b.adoptPeerSalt(SALT_A);

function bytes(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

function pad(length: number): Uint8Array {
  return new Uint8Array(length).fill(0x41);
}

type Frame = { name: string; frame: Uint8Array; header: number };

async function samples(): Promise<Frame[]> {
  const [single] = await a.buildMessageFrames(bytes("hi"), 0x0102);
  const multi = await a.buildMessageFrames(pad(MAX_MESSAGE_PLAINTEXT_BYTES), 0x0103);
  const ack = await a.buildAckFrame(0x0104, 0b1);
  const pair = await a.buildPairFrame(TEST_CHALLENGE);
  return [
    { name: "MESSAGE", frame: single as Uint8Array, header: HEADER_BYTES },
    { name: "MESSAGE_MULTI[0]", frame: multi[0] as Uint8Array, header: MULTI_HEADER_BYTES },
    { name: "MESSAGE_MULTI[1]", frame: multi[1] as Uint8Array, header: MULTI_HEADER_BYTES },
    { name: "ACK", frame: ack, header: HEADER_BYTES },
    { name: "PAIR", frame: pair, header: HEADER_BYTES },
  ];
}

function flip(source: Uint8Array, index: number, mask = 0x01): Uint8Array {
  const copy = Uint8Array.from(source);
  copy[index] = (copy[index] ?? 0) ^ mask;
  return copy;
}

describe("every byte a receiver can see is authenticated or refused (P3, exhaustive)", () => {
  it("refuses a single-bit change at all 64 positions of every frame kind", async () => {
    for (const { name, frame } of await samples()) {
      // The control: untouched, the intended peer reads it.
      const control = await b.parse(frame);
      expect(control.ok, `${name} must be readable when untouched`).toBe(true);

      for (let index = 0; index < WIRE_BLOCK_BYTES; index += 1) {
        const outcome = await b.parse(flip(frame, index));
        expect(outcome.ok, `${name}: flipping byte ${index} must not parse`).toBe(false);
      }
    }
  });

  it("fails the tag for every one of the 16 tag bytes, not the padding check", async () => {
    // `MESSAGE_MULTI[1]` is excluded because its tag occupies bytes 48..63 —
    // byte-for-byte the same positions as `MESSAGE_MULTI[0]`'s, so sweeping it
    // again would prove nothing new. Stated here so the exclusion cannot become
    // an unexplained blind spot in a file whose whole job is exhaustiveness.
    const cases: Frame[] = (await samples()).filter(
      (entry) => entry.name !== "PAIR" && entry.name !== "MESSAGE_MULTI[1]",
    );
    expect(cases.length).toBe(3);
    for (const { name, frame, header } of cases) {
      const len = frame[4] ?? 0;
      for (let offset = 0; offset < AEAD_TAG_BYTES; offset += 1) {
        const index = header + len + offset;
        const outcome = await b.parse(flip(frame, index));
        expect(outcome, `${name}: tag byte ${offset}`).toEqual({
          ok: false,
          reason: "auth-failed",
        });
      }
    }
  });

  it("refuses a rewritten envelope: every header field, one at a time", async () => {
    const [single] = await a.buildMessageFrames(bytes("rewrite"), 0x0201);
    const base = single as Uint8Array;
    for (let index = 0; index < HEADER_BYTES; index += 1) {
      for (const mask of [0x01, 0x80]) {
        const outcome = await b.parse(flip(base, index, mask));
        expect(outcome.ok, `header byte ${index} mask ${mask.toString(16)}`).toBe(false);
      }
    }
    // ...and the same for a multi-block frame, including the `seq` byte, which
    // is part of the AAD and therefore part of the nonce as well.
    const multi = (await a.buildMessageFrames(pad(MAX_MESSAGE_PLAINTEXT_BYTES), 0x0202))[1];
    const second = multi as Uint8Array;
    for (let index = 0; index < MULTI_HEADER_BYTES; index += 1) {
      for (const mask of [0x01, 0x40]) {
        expect((await b.parse(flip(second, index, mask))).ok, `multi byte ${index}`).toBe(false);
      }
    }
  });
});

describe("every seq byte value", () => {
  it("accepts only the two legal multi-block seq values and refuses the rest", async () => {
    const multi = (
      await a.buildMessageFrames(pad(MAX_MESSAGE_PLAINTEXT_BYTES), 0x0301)
    )[0] as Uint8Array;
    expect(multi[5]).toBe(encodeSeq(0, MAX_MESSAGE_BLOCKS));
    const structural: number[] = [];
    for (let value = 0; value < 256; value += 1) {
      const attempt = Uint8Array.from(multi);
      attempt[5] = value;
      const outcome = await b.parse(attempt);
      const parts = decodeSeq(value);
      const legal = parts.blockCount === MAX_MESSAGE_BLOCKS && parts.blockIndex < parts.blockCount;
      if (!legal) {
        structural.push(value);
        expect(outcome, `seq 0x${value.toString(16)} must be bad-seq`).toEqual({
          ok: false,
          reason: "bad-seq",
        });
      } else if (value === encodeSeq(0, MAX_MESSAGE_BLOCKS)) {
        expect(outcome.ok, "the real seq must still parse").toBe(true);
      } else {
        // Structurally legal but not what was sealed: the AAD and the nonce both
        // carry `seq`, so the tag has to fail.
        expect(outcome, `seq 0x${value.toString(16)}`).toEqual({
          ok: false,
          reason: "auth-failed",
        });
      }
    }
    // Exactly two nibble pairs are legal at all, and 254 of 256 values are not.
    expect(structural).toHaveLength(254);
    expect(structural).not.toContain(0x02);
    expect(structural).not.toContain(0x12);
  });

  it("guards every seq input, and decodes the extremes", () => {
    expect(encodeSeq(0, 2)).toBe(0x02);
    expect(encodeSeq(1, 2)).toBe(0x12);
    for (const [index, count] of [
      [0, 0],
      [0, 3],
      [0, 16],
      [0, 17],
      [0, 255],
      [2, 2],
      [1, 1],
      [-1, 2],
      [0.5, 2],
      [0, 1.5],
      [Number.NaN, 2],
    ] as [number, number][]) {
      expect(() => encodeSeq(index, count), `encodeSeq(${index}, ${count})`).toThrowError(
        ProtocolUsageError,
      );
    }
    expect(decodeSeq(0x00)).toEqual({ blockIndex: 0, blockCount: 0 });
    expect(decodeSeq(0xff)).toEqual({ blockIndex: 15, blockCount: 15 });
  });
});

describe("len and msgId boundaries", () => {
  it("round-trips every legal plaintext length for both block kinds", async () => {
    for (const length of [
      1,
      2,
      3,
      SINGLE_BLOCK_PLAINTEXT_BYTES - 1,
      SINGLE_BLOCK_PLAINTEXT_BYTES,
    ]) {
      const frames = await a.buildMessageFrames(pad(length), 0x0400 + length);
      expect(frames, `length ${length}`).toHaveLength(1);
      const parsed = await b.parse(frames[0] as Uint8Array);
      expect(parsed.ok, `length ${length}`).toBe(true);
      if (!parsed.ok || parsed.frame.kind !== "message") throw new Error("expected a message");
      expect(parsed.frame.plaintext).toHaveLength(length);
    }
    for (const length of [1, 2, MULTI_BLOCK_PLAINTEXT_BYTES - 1, MULTI_BLOCK_PLAINTEXT_BYTES]) {
      const frames = await a.buildMessageFrames(pad(length), 0x0500 + length);
      expect(frames, `length ${length}`).toHaveLength(1);
      const parsed = await b.parse(frames[0] as Uint8Array);
      expect(parsed.ok, `length ${length}`).toBe(true);
    }
    // The exact single -> multi transition, and the two-block cap.
    const boundary = SINGLE_BLOCK_PLAINTEXT_BYTES + 1;
    const [justOver] = await a.buildMessageFrames(pad(boundary), 0x0600);
    expect(justOver?.[0]).toBe(3);
    const capped = await a.buildMessageFrames(pad(MAX_MESSAGE_PLAINTEXT_BYTES), 0x0601);
    expect(capped).toHaveLength(MAX_MESSAGE_BLOCKS);
    await expect(
      a.buildMessageFrames(pad(MAX_MESSAGE_PLAINTEXT_BYTES + 1), 0x0602),
    ).rejects.toThrowError(MessageTooLongError);
    await expect(a.buildMessageFrames(new Uint8Array(0), 0x0603)).rejects.toThrowError(
      ProtocolUsageError,
    );
  });

  it("refuses every len outside the capacity of its kind, at both ends", async () => {
    const [single] = await a.buildMessageFrames(bytes("abc"), 0x0701);
    const singleBlock = single as Uint8Array;
    for (const len of [0, SINGLE_BLOCK_PLAINTEXT_BYTES + 1, 64, 128, 255]) {
      const attempt = Uint8Array.from(singleBlock);
      attempt[4] = len;
      expect(await b.parse(attempt), `single len ${len}`).toEqual({
        ok: false,
        reason: "bad-length",
      });
    }
    const [multi] = await a.buildMessageFrames(pad(MAX_MESSAGE_PLAINTEXT_BYTES), 0x0702);
    const multiBlock = multi as Uint8Array;
    for (const len of [0, MULTI_BLOCK_PLAINTEXT_BYTES + 1, 43, 64, 255]) {
      const attempt = Uint8Array.from(multiBlock);
      attempt[4] = len;
      expect(await b.parse(attempt), `multi len ${len}`).toEqual({
        ok: false,
        reason: "bad-length",
      });
    }
    // An ACK's body is exactly one byte and nothing else.
    const ack = await a.buildAckFrame(0x0703, 0b1);
    for (const len of [0, 2, 42, 255]) {
      const attempt = Uint8Array.from(ack);
      attempt[4] = len;
      expect(await b.parse(attempt), `ack len ${len}`).toEqual({
        ok: false,
        reason: "bad-length",
      });
    }
    // A PAIR's len must be the salt length and its msgId must be zero.
    const pair = await a.buildPairFrame(TEST_CHALLENGE);
    for (const len of [0, 15, 17, 32, 255]) {
      const attempt = Uint8Array.from(pair);
      attempt[4] = len;
      expect(await b.parse(attempt), `pair len ${len}`).toEqual({
        ok: false,
        reason: "bad-length",
      });
    }
    for (const [high, low] of [
      [0, 1],
      [1, 0],
      [0xff, 0xff],
    ] as [number, number][]) {
      const attempt = Uint8Array.from(pair);
      attempt[1] = high;
      attempt[2] = low;
      expect(await b.parse(attempt), `pair msgId ${high}${low}`).toEqual({
        ok: false,
        reason: "reserved-field",
      });
    }
  });

  it("accepts msgId 0, 1, 0xFFFE and 0xFFFF, and refuses everything else", async () => {
    for (const msgId of [0, 1, 0xfffe, 0xffff]) {
      const [frame] = await a.buildMessageFrames(bytes(`id-${msgId}`), msgId);
      const parsed = await b.parse(frame as Uint8Array);
      expect(parsed.ok, `msgId ${msgId}`).toBe(true);
      if (parsed.ok && parsed.frame.kind === "message") {
        expect(parsed.frame.msgId).toBe(msgId);
      } else {
        throw new Error(`msgId ${msgId} did not parse as a message`);
      }
      const ack = await b.parse(await a.buildAckFrame(msgId, 0b1));
      expect(ack.ok, `ack for msgId ${msgId}`).toBe(true);
    }
    for (const msgId of [-1, 0x10000, 0.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      await expect(a.buildMessageFrames(bytes("x"), msgId)).rejects.toThrowError(
        ProtocolUsageError,
      );
      await expect(a.buildAckFrame(msgId, 1)).rejects.toThrowError(ProtocolUsageError);
    }
  });

  it("refuses every fromPeerId that is not the other peer", async () => {
    const [single] = await a.buildMessageFrames(bytes("peer"), 0x0801);
    const base = single as Uint8Array;
    for (let peerId = 0; peerId < 256; peerId += 1) {
      const attempt = Uint8Array.from(base);
      attempt[3] = peerId;
      const outcome = await b.parse(attempt);
      if (peerId === 0) {
        expect(outcome.ok, "the peer's own id must still parse").toBe(true);
      } else {
        expect(outcome, `fromPeerId ${peerId}`).toEqual({ ok: false, reason: "bad-peer" });
      }
    }
  });
});

describe("truncation, extension and shape", () => {
  it("refuses any frame that is not exactly one 64-byte block", async () => {
    const [single] = await a.buildMessageFrames(bytes("shape"), 0x0901);
    const base = single as Uint8Array;
    for (const length of [0, 1, 5, 63, 65, 128, 1024]) {
      const attempt =
        length <= base.length
          ? base.subarray(0, length)
          : (() => {
              const grown = new Uint8Array(length);
              grown.set(base);
              return grown;
            })();
      expect(await b.parse(attempt), `length ${length}`).toEqual({
        ok: false,
        reason: "short-frame",
      });
    }
  });

  it("distinguishes a too-short sealed body from a wrong tag, and pins both", async () => {
    const key = await keys.directionKey(0);
    const nonce = buildNonce({ salt: SALT_A, frameKind: 1, msgId: 1, seq: 0 });
    const aad = new Uint8Array([1, 0, 0, 0, 2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
    // Fewer bytes than the tag: our own misuse of `openBlock`, reported as shape
    // and never as "the transmission was tampered with".
    for (const length of [0, 1, 15]) {
      expect(await openBlock(key, nonce, aad, new Uint8Array(length))).toEqual({
        ok: false,
        reason: "shape",
      });
    }
    // Exactly a tag and no ciphertext: the right shape, a wrong tag.
    expect(await openBlock(key, nonce, aad, new Uint8Array(AEAD_TAG_BYTES))).toEqual({
      ok: false,
      reason: "tag",
    });
  });
});

describe("per-direction keys, proved at the frame level (P1)", () => {
  it("gives the two directions different bytes for the same message and id", async () => {
    const [fromA] = await a.buildMessageFrames(bytes("same"), 0x0a01);
    const [fromB] = await b.buildMessageFrames(bytes("same"), 0x0a01);
    // One shared key with per-side counters starting at 0 would make these two
    // byte-identical — a two-time pad, and a reflection the peer could not tell
    // from its own. They are not.
    expect(Array.from(fromA as Uint8Array)).not.toEqual(Array.from(fromB as Uint8Array));
    expect((await b.parse(fromA as Uint8Array)).ok).toBe(true);
    expect((await a.parse(fromB as Uint8Array)).ok).toBe(true);
  });

  it("refuses a peer's own transmission twice over: peer byte first, then key", async () => {
    const [own] = await a.buildMessageFrames(bytes("mine"), 0x0a02);
    expect(a.paired).toBe(true);
    // Guard one: the frame claims `fromPeerId` 0 and this is peer 0, so it is
    // refused structurally, before any key is touched. Unpaused self-reception
    // can therefore never become a self-reply loop.
    expect(await a.parse(own as Uint8Array)).toEqual({ ok: false, reason: "bad-peer" });

    // Guard two: an envelope that passes the peer check by claiming to come
    // from peer 1 — the only peer this receiver will ever accept. Sealed with
    // the key that direction *owns*, it is readable; sealed with the sender's
    // own key instead, it is not. Nothing else differs between the two frames.
    const msgId = 0x0a03;
    const len = 4;
    const header = new Uint8Array([1, (msgId >> 8) & 0xff, msgId & 0xff, 1, len]);
    const aad = new Uint8Array(
      HEADER_BYTES + (WIRE_BLOCK_BYTES - HEADER_BYTES - len - AEAD_TAG_BYTES),
    );
    aad.set(header, 0);
    const bodyBytes = bytes("mine");
    const nonce = buildNonce({ salt: SALT_B, frameKind: 1, msgId, seq: 0 });
    const frameWith = async (direction: 0 | 1): Promise<Uint8Array> => {
      const sealed = await sealBlock(await keys.directionKey(direction), nonce, aad, bodyBytes);
      const frame = new Uint8Array(WIRE_BLOCK_BYTES);
      frame.set(header, 0);
      frame.set(sealed, HEADER_BYTES);
      return frame;
    };
    // Peer 0 (this codec) opens with `directionKey(1)` — the send key of peer 1.
    expect((await a.parse(await frameWith(1))).ok).toBe(true);
    // The same envelope sealed with peer 0's own send key is refused: the tag
    // cannot be forged into the other direction.
    expect(await a.parse(await frameWith(0))).toEqual({ ok: false, reason: "auth-failed" });
  });
});

describe("the AAD rule, from the wire bytes alone (P3)", () => {
  it("recomputes the same AAD the sealer used, for every kind and length", async () => {
    for (const { name, frame, header } of await samples()) {
      if (name === "PAIR") continue; // the key check is an HMAC, never AEAD
      const len = frame[4] ?? 0;
      const aad = frameAad(frame, header, len);
      expect(aad.subarray(0, header), `${name} header`).toEqual(frame.subarray(0, header));
      expect(aad.length, `${name} aad length`).toBe(
        header + WIRE_BLOCK_BYTES - header - len - AEAD_TAG_BYTES,
      );
      expect(Array.from(aad.subarray(header)).every((byte) => byte === 0)).toBe(true);

      // Every sample frame was sealed by `a` with SALT_A, so the AAD recomputed
      // from the wire bytes must open it. This is the equality assertion between
      // the builder's AAD rule and the parser's, at the frame level.
      const kind = frame[0] ?? 0;
      const msgId = ((frame[1] ?? 0) << 8) | (frame[2] ?? 0);
      const seq = header === MULTI_HEADER_BYTES ? (frame[5] ?? 0) : 0;
      const key = await keys.directionKey(0);
      const nonce = buildNonce({ salt: SALT_A, frameKind: kind, msgId, seq });
      const sealed = frame.subarray(header, header + len + AEAD_TAG_BYTES);
      const opened = await openBlock(key, nonce, aad, sealed);
      expect(opened.ok, `${name}: the recomputed AAD must open the frame`).toBe(true);
      // And any change to it fails the tag, which is what P3 buys.
      const damaged = Uint8Array.from(aad, (byte) => byte ^ 0xff);
      expect(await openBlock(key, nonce, damaged, sealed), `${name}: damaged aad`).toEqual({
        ok: false,
        reason: "tag",
      });
    }
  });

  it("refuses an AAD the frame cannot justify, rather than inventing one", () => {
    const frame = new Uint8Array(WIRE_BLOCK_BYTES);
    expect(() => frameAad(frame, HEADER_BYTES, 43 + 1)).toThrowError(ProtocolUsageError);
    expect(() => frameAad(frame, HEADER_BYTES, 64)).toThrowError(ProtocolUsageError);
    expect(() => frameAad(frame, MULTI_HEADER_BYTES, 0)).not.toThrow();
    // A negative (or non-integer) `len` is our own misuse, and the exported
    // helper refuses it rather than silently producing a shorter AAD: with
    // `len = -1` the padding would start inside the header. Not reachable from
    // the product (`#open` validates `len` first), but the boundary belongs to
    // the function.
    expect(() => frameAad(frame, HEADER_BYTES, -1)).toThrowError(ProtocolUsageError);
    expect(() => frameAad(frame, HEADER_BYTES, 1.5)).toThrowError(ProtocolUsageError);
    expect(() => frameAad(frame, HEADER_BYTES, Number.NaN)).toThrowError(ProtocolUsageError);
    expect(() => frameAad(frame, -1, 0)).toThrowError(ProtocolUsageError);
  });
});

describe("ACK masks at their boundaries", () => {
  it("carries 0 and 255 as legal masks and refuses everything else", async () => {
    for (const mask of [0x00, 0x01, 0x80, 0xff]) {
      const parsed = await b.parse(await a.buildAckFrame(0x0b01, mask));
      expect(parsed.ok, `mask ${mask}`).toBe(true);
      if (parsed.ok && parsed.frame.kind === "ack") expect(parsed.frame.mask).toBe(mask);
      else throw new Error(`mask ${mask} did not parse as an ack`);
    }
    for (const mask of [-1, 256, 0.5, Number.NaN, 1.5]) {
      await expect(a.buildAckFrame(0x0b02, mask)).rejects.toThrowError(ProtocolUsageError);
    }
    // The mask helpers themselves, at the two interesting boundaries.
    expect(fullMask(0)).toBe(0);
    expect(fullMask(1)).toBe(0b1);
    expect(fullMask(2)).toBe(0b11);
    expect(fullMask(7)).toBe(0b111_1111);
    expect(fullMask(8)).toBe(0xff);
    expect(fullMask(255)).toBe(0xff);
  });
});
