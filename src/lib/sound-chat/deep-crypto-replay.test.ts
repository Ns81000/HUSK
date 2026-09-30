/**
 * Phase 2V deep dive — trying to *break* the Phase 2 crypto/protocol properties
 * (master plan Section 10.2 P1-P9) rather than to confirm them.
 *
 * Each `it` is an attack, not a feature check:
 * - P2/P4: replay a whole recording of a *previous* session into a fresh one;
 * - P2: make two sessions' nonce spaces collapse, to find what P2 actually
 *   rests on;
 * - P1: two peers whose counters collide, and a two-time pad;
 * - P4: a two-block message whose second block is replayed, with and without a
 *   rewritten envelope;
 * - P5/P6: a frame that decodes but cannot be read, versus silence;
 * - P7: the pairing code on the air;
 * - P9: keys, codes or plaintext reaching a log or storage.
 *
 * All of it runs through the real key schedule, real AEAD and the real
 * assembler. Nothing is mocked.
 */
import { describe, expect, it, vi } from "vitest";
import { derivePairingKeys, keyCheckTag, PAIR_CHALLENGE_BYTES, SESSION_SALT_BYTES } from "./crypto";
import {
  FRAME_KIND,
  FrameCodec,
  InboundAssembler,
  MAX_MESSAGE_PLAINTEXT_BYTES,
  PAIR_BODY_BYTES,
  PAIR_KEY_CHECK_OFFSET,
} from "./protocol";

/** A fixed handshake challenge; the session generates a fresh one per pairing. */
const TEST_CHALLENGE = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);

const CODE = "ABCD2345";
const keys = await derivePairingKeys(CODE);

function salt(byte: number): Uint8Array {
  return new Uint8Array(SESSION_SALT_BYTES).fill(byte);
}

function bytes(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

function pad(length: number): Uint8Array {
  return new Uint8Array(length).fill(0x5a);
}

/** Two codecs on the same code, paired the way the handshake pairs them. */
async function sessionPair(
  selfByte: number,
  peerByte: number,
): Promise<{ a: FrameCodec; b: FrameCodec }> {
  const a = new FrameCodec({ keys, selfId: 0, sendSalt: salt(selfByte) });
  const b = new FrameCodec({ keys, selfId: 1, sendSalt: salt(peerByte) });
  a.adoptPeerSalt(salt(peerByte));
  b.adoptPeerSalt(salt(selfByte));
  return { a, b };
}

describe("P2/P4 — a recording of a previous session replayed into a new one", () => {
  // P2V FINDING: real bug in protocol.ts (`FrameCodec.parse` / `adoptPeerSalt`)
  // and session.ts (`#onPairFrame`).
  it("refuses yesterday's frame today, and can never be made to accept it", async () => {
    // Session 1: an ordinary conversation, recorded by anyone in the room (an
    // accepted limit). Everything below is what that recording holds.
    const yesterday = await sessionPair(0x11, 0x22);
    const recordedPair = await yesterday.a.buildPairFrame(TEST_CHALLENGE);
    const [recordedMessage] = await yesterday.a.buildMessageFrames(bytes("yesterday"), 7);
    expect((await yesterday.b.parse(recordedMessage as Uint8Array)).ok).toBe(true);

    // Session 2: the same pairing code, its own fresh random salt — the honest
    // case, in which yesterday's frame is simply unreadable.
    const today = new FrameCodec({ keys, selfId: 1, sendSalt: salt(0x33) });
    expect(await today.parse(recordedMessage as Uint8Array)).toEqual({
      ok: false,
      reason: "auth-failed",
    });

    // A recorded message is dead on arrival as long as the peer salt is not the
    // recorded one: a fresh session salt means a fresh nonce, so the tag can
    // never be recomputed. This is the P2 property, and it needs no help from
    // the dedupe window.
    today.adoptPeerSalt(salt(0x22)); // the genuine peer's salt, from yesterday
    expect(await today.parse(recordedMessage as Uint8Array)).toEqual({
      ok: false,
      reason: "auth-failed",
    });

    // ...but the codec layer *can* be made to accept a recording, and the reason
    // matters: the salt is public, so adopting a recorded one restores the old
    // nonce space and every frame ever recorded under it authenticates. The
    // codec has no freshness input of its own, so this is not a bug in it — it
    // is the reason `SoundChatSession` must never adopt a salt it did not earn
    // from a live handshake (P2V finding 2). A fresh codec, because a paired one
    // refuses a second salt by design.
    const fooled = new FrameCodec({ keys, selfId: 1, sendSalt: salt(0x33) });
    fooled.adoptPeerSalt(salt(0x11)); // exactly what `#onPairFrame` used to do
    const replayed = await fooled.parse(recordedMessage as Uint8Array);
    expect(replayed.ok, "the codec can be made to accept a recorded salt").toBe(true);
    // The recorded *PAIR* frame is the other half. It is not AEAD, so it verifies
    // in any later session with the same code — the codec cannot know which
    // challenge is "current". The session is the layer that can: it compares the
    // echoed challenge with the one *it* generated, so a recording is refused.
    // That check lives in `SoundChatSession.#onPairFrame` and is exercised
    // session-level in `deep-session-seams.test.ts` and
    // `deep-verify-pair-challenge.test.ts`; asserting here that a frame differs
    // from a literal the test just built would only restate its own constructor
    // argument.
    expect(await today.parse(recordedPair)).toMatchObject({ ok: true, frame: { kind: "pair" } });
  });

  it("cannot re-adopt a second salt once a replayed one is in place", async () => {
    // The other half of the same finding: after a replayed PAIR has been
    // adopted, the *honest* peer's own PAIR frame can no longer be adopted —
    // `adoptPeerSalt` throws — and `#onPairFrame` reports that on the module
    // channel, which is terminal for the session.
    const today = new FrameCodec({ keys, selfId: 1, sendSalt: salt(0x35) });
    today.adoptPeerSalt(salt(0x11));
    expect(() => today.adoptPeerSalt(salt(0x36))).toThrowError(/already belongs to a paired/);
    // Re-adopting the *same* salt is the one that is allowed, so the codec's own
    // redelivery of its PAIR frame can never trip the guard.
    expect(() => today.adoptPeerSalt(salt(0x11))).not.toThrow();
  });
});

describe("P2 — what the nonce space actually rests on", () => {
  it("collapses into a two-time pad when the session salt repeats (P2V FINDING)", async () => {
    // Two *different* sessions that happen to draw the same 16-byte salt, with
    // the same msgId: same key, same nonce, different plaintext. AES-GCM in that
    // state is a two-time pad — the plaintexts cancel out of the ciphertexts,
    // so anyone with both recordings reads both messages. This is the one
    // AES-GCM failure that is catastrophic, and nothing in the design defends it
    // except the randomness of `generateSessionSalt`.
    const first = new FrameCodec({ keys, selfId: 0, sendSalt: salt(0x55) });
    const second = new FrameCodec({ keys, selfId: 0, sendSalt: salt(0x55) });
    const plaintextA = bytes("AAAAAAAA");
    const plaintextB = bytes("BBBBBBBB");
    const [frameA] = await first.buildMessageFrames(plaintextA, 42);
    const [frameB] = await second.buildMessageFrames(plaintextB, 42);
    const bodyA = (frameA as Uint8Array).subarray(5, 5 + 8);
    const bodyB = (frameB as Uint8Array).subarray(5, 5 + 8);
    // XOR(ciphertext, ciphertext) == XOR(plaintext, plaintext): the leak, stated
    // as the property it is rather than as two different-looking byte strings.
    const cancelled = bodyA.map((byte, index) => byte ^ (bodyB[index] ?? 0));
    expect(cancelled).toEqual(plaintextA.map((byte, index) => byte ^ (plaintextB[index] ?? 0)));
    // One known plaintext is all it takes: XOR it back out of the other.
    expect(cancelled.map((byte) => byte ^ (plaintextA[0] ?? 0))).toEqual(plaintextB);

    // With a *different* salt the same two messages share no structure at all,
    // which is exactly what the honest design relies on.
    const other = new FrameCodec({ keys, selfId: 0, sendSalt: salt(0x56) });
    const [frameC] = await other.buildMessageFrames(plaintextA, 42);
    const bodyC = (frameC as Uint8Array).subarray(5, 5 + 8);
    expect(bodyA.map((byte, index) => byte ^ (bodyC[index] ?? 0))).not.toEqual(cancelled);
    expect(Array.from(frameA as Uint8Array)).not.toEqual(Array.from(frameC as Uint8Array));

    // P2V FINDING: `RandomSource` is a public, injectable option on
    // `SoundChatSessionOptions` and nothing checks that it is a CSPRNG. A fixed
    // or seeded source silently removes the only thing P2 rests on.
    const fixed = new Uint8Array(SESSION_SALT_BYTES).fill(9);
    const fromHostileSource = new FrameCodec({ keys, selfId: 0, sendSalt: fixed });
    const alsoHostile = new FrameCodec({ keys, selfId: 0, sendSalt: fixed });
    const [hostileA] = await fromHostileSource.buildMessageFrames(bytes("AAAAAAAA"), 1);
    const [hostileB] = await alsoHostile.buildMessageFrames(bytes("BBBBBBBB"), 1);
    const leak = (hostileA as Uint8Array)
      .subarray(5, 13)
      .map((byte, index) => byte ^ ((hostileB as Uint8Array).subarray(5, 13)[index] ?? 0));
    expect(leak).toEqual(new Uint8Array(8).fill(0x41 ^ 0x42));
  });
});

describe("P1/P2 — two peers whose counters deliberately collide", () => {
  it("keeps the two directions apart even with identical msgIds and text", async () => {
    const { a, b } = await sessionPair(0x61, 0x62);
    const [fromA] = await a.buildMessageFrames(bytes("collision"), 0);
    const [fromB] = await b.buildMessageFrames(bytes("collision"), 0);
    expect(Array.from(fromA as Uint8Array)).not.toEqual(Array.from(fromB as Uint8Array));
    // Each is readable only by the other, and neither by its own sender.
    expect((await b.parse(fromA as Uint8Array)).ok).toBe(true);
    expect((await a.parse(fromB as Uint8Array)).ok).toBe(true);
    expect((await a.parse(fromA as Uint8Array)).ok).toBe(false);
    expect((await b.parse(fromB as Uint8Array)).ok).toBe(false);
  });
});

describe("P4 — a two-block message, replayed block by block", () => {
  it("never renders a block twice, whatever the codec redelivers", async () => {
    const { a } = await sessionPair(0x71, 0x72);
    const frames = await a.buildMessageFrames(pad(MAX_MESSAGE_PLAINTEXT_BYTES), 900);
    const assembler = new InboundAssembler();
    const block = (index: number) => ({
      msgId: 900,
      blockIndex: index,
      blockCount: 2,
      plaintext: (frames[index] as Uint8Array).subarray(6, 6 + 42),
    });
    expect(assembler.accept(block(0)).status).toBe("partial");
    // Block 1 arrives before block 0: still exactly one delivery.
    expect(assembler.accept(block(1)).status).toBe("delivered");
    // Every redelivery the codec makes of either block is suppressed.
    for (let redelivery = 0; redelivery < 20; redelivery += 1) {
      expect(assembler.accept(block(0)).status, `redelivery ${redelivery}`).toBe("duplicate");
      expect(assembler.accept(block(1)).status, `redelivery ${redelivery}`).toBe("duplicate");
    }
    // ...and a replay of the whole message *below* the high-water mark is stale.
    expect(assembler.accept({ ...block(0), msgId: 899 }).status).toBe("stale");
  });

  it("refuses a replayed block whose envelope was rewritten (P3, P4)", async () => {
    const { a, b } = await sessionPair(0x73, 0x74);
    const frames = await a.buildMessageFrames(pad(MAX_MESSAGE_PLAINTEXT_BYTES), 901);
    const second = frames[1] as Uint8Array;
    expect((await b.parse(second)).ok).toBe(true);
    // A different msgId: the header is in the AAD, so the tag fails.
    const movedId = Uint8Array.from(second);
    movedId[2] = 0x82;
    expect(await b.parse(movedId)).toEqual({ ok: false, reason: "auth-failed" });
    // A different block index, still structurally legal: `seq` is in the AAD
    // *and* in the nonce, so this one fails the tag too.
    const movedSeq = Uint8Array.from(second);
    movedSeq[5] = 0x02;
    expect(await b.parse(movedSeq)).toEqual({ ok: false, reason: "auth-failed" });
    // A different declared length. This one is caught one step earlier, by the
    // padding check, because shortening `len` moves the body end into the tag —
    // but it is still a refusal, never a different message.
    const movedLen = Uint8Array.from(second);
    movedLen[4] = 41;
    expect(await b.parse(movedLen)).toEqual({ ok: false, reason: "nonzero-padding" });
    // A different sender: refused structurally, before any key is touched.
    const movedPeer = Uint8Array.from(second);
    movedPeer[3] = 1;
    expect(await b.parse(movedPeer)).toEqual({ ok: false, reason: "bad-peer" });
  });
});

describe("P5/P6 — heard but unreadable is not silence, and is not an error", () => {
  it("separates a damaged frame from an absent one, and never invents a message", async () => {
    const { a, b } = await sessionPair(0x81, 0x82);
    const assembler = new InboundAssembler();
    const [built] = await a.buildMessageFrames(bytes("readable"), 1000);
    const good = built as Uint8Array;
    const damaged = Uint8Array.from(good);
    // One bit of the authentication tag: the body is untouched, so the only
    // thing that can refuse this frame is the tag itself.
    const tagStart = 5 + (good[4] ?? 0);
    damaged[tagStart] = (damaged[tagStart] ?? 0) ^ 0x01;

    const damagedOutcome = await b.parse(damaged);
    expect(damagedOutcome).toEqual({ ok: false, reason: "auth-failed" });
    // Nothing reaches the assembler, so nothing can be rendered from it.
    expect(assembler.partialCount).toBe(0);
    expect(assembler.highWater).toBeNull();
    // The undamaged control, with no other change, is delivered.
    const goodOutcome = await b.parse(good);
    expect(goodOutcome.ok).toBe(true);
    if (!goodOutcome.ok || goodOutcome.frame.kind !== "message")
      throw new Error("expected a frame");
    const delivered = assembler.accept({
      msgId: goodOutcome.frame.msgId,
      blockIndex: 0,
      blockCount: 1,
      plaintext: goodOutcome.frame.plaintext,
    });
    expect(delivered.status).toBe("delivered");
  });

  it("treats a wrong-code PAIR frame as unreadable, not as a protocol error", async () => {
    const other = await derivePairingKeys("ABCD2346");
    const stranger = new FrameCodec({ keys: other, selfId: 0, sendSalt: salt(0x91) });
    const receiver = new FrameCodec({ keys, selfId: 1, sendSalt: salt(0x92) });
    expect(await receiver.parse(await stranger.buildPairFrame(TEST_CHALLENGE))).toEqual({
      ok: false,
      reason: "auth-failed",
    });
    // The right code, the wrong role: a reflected confirmation is not a pairing.
    const reflected = new FrameCodec({ keys, selfId: 0, sendSalt: salt(0x92) });
    const frame = await reflected.buildPairFrame(TEST_CHALLENGE);
    expect(frame[3]).toBe(0);
    const tamperedRole = Uint8Array.from(frame);
    tamperedRole[3] = 1;
    expect(await receiver.parse(tamperedRole)).toEqual({ ok: false, reason: "bad-peer" });
  });
});

describe("P7 — the pairing code never goes on the air", () => {
  it("has room in the PAIR frame for a salt, a challenge and a tag, and nothing else", async () => {
    const { a } = await sessionPair(0xa1, 0xa2);
    const pair = await a.buildPairFrame(TEST_CHALLENGE);
    expect(pair[0]).toBe(FRAME_KIND.PAIR);
    expect(pair[4]).toBe(PAIR_BODY_BYTES);
    // The body is exactly salt ‖ challenge ‖ keyCheck, and every other byte is zero.
    expect(Array.from(pair.subarray(0, 5))).toEqual([FRAME_KIND.PAIR, 0, 0, 0, PAIR_BODY_BYTES]);
    expect(Array.from(pair.subarray(5, 5 + SESSION_SALT_BYTES))).toEqual(Array.from(salt(0xa1)));
    expect(Array.from(pair.subarray(5 + SESSION_SALT_BYTES, PAIR_KEY_CHECK_OFFSET))).toEqual(
      Array.from(TEST_CHALLENGE),
    );
    expect(pair.subarray(PAIR_KEY_CHECK_OFFSET + 16).every((byte) => byte === 0)).toBe(true);

    // The code itself, and the master key it derives, appear nowhere.
    const codeBytes = bytes(CODE);
    const frameBytes = Array.from(pair);
    for (const byte of codeBytes) {
      expect(frameBytes.includes(byte), `PAIR frame leaks code byte ${byte}`).toBe(false);
    }
    const master = await keys.directionKey(0);
    expect(master.extractable).toBe(false);

    // The key check is an HMAC over the salt and the role — so it proves "same
    // code, live right now" and nothing else. Two roles, two tags.
    const asDisplay = await keyCheckTag(keys.mac, salt(0xa1), TEST_CHALLENGE, 0);
    const asEnterer = await keyCheckTag(keys.mac, salt(0xa1), TEST_CHALLENGE, 1);
    expect(Array.from(asDisplay)).not.toEqual(Array.from(asEnterer));
    expect(asDisplay).toHaveLength(16);
    expect(pair.subarray(PAIR_KEY_CHECK_OFFSET, PAIR_KEY_CHECK_OFFSET + 16)).toEqual(asDisplay);
  });
});

describe("P9 — nothing secret reaches a log or storage", () => {
  it("runs a whole exchange with hostile storage and a spied console", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const touched: string[] = [];
    const hostile = (name: string) => ({
      getItem: (key: string) => {
        touched.push(`${name}.getItem(${key})`);
        return null;
      },
      setItem: (key: string) => {
        touched.push(`${name}.setItem(${key})`);
      },
      removeItem: (key: string) => {
        touched.push(`${name}.removeItem(${key})`);
      },
    });
    vi.stubGlobal("localStorage", hostile("localStorage"));
    vi.stubGlobal("sessionStorage", hostile("sessionStorage"));
    const cookie = vi.fn();
    vi.stubGlobal("document", {
      get cookie() {
        return cookie();
      },
      set cookie(value: string) {
        cookie(value);
      },
    });
    try {
      const { a, b } = await sessionPair(0xb1, 0xb2);
      const [frame] = await a.buildMessageFrames(bytes("top secret"), 1);
      expect((await b.parse(frame as Uint8Array)).ok).toBe(true);
      expect(await b.parse(await a.buildPairFrame(TEST_CHALLENGE))).toMatchObject({ ok: true });
      expect((await b.parse(await a.buildAckFrame(1, 0b1))).ok).toBe(true);

      const said = [...log.mock.calls, ...warn.mock.calls, ...error.mock.calls].flat().join(" ");
      expect(said).not.toContain(CODE);
      expect(said).not.toContain("top secret");
      expect(log).not.toHaveBeenCalled();
      expect(touched).toEqual([]);
      expect(cookie).not.toHaveBeenCalled();
    } finally {
      log.mockRestore();
      warn.mockRestore();
      error.mockRestore();
      vi.unstubAllGlobals();
    }
  });
});
