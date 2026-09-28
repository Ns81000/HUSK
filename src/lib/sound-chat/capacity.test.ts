/**
 * Measured capacity, not estimated (master plan Section 10.2 P10 and 10.1 class
 * 11), plus the machine-checked agreement between the numbers and the documents
 * that state them.
 *
 * Every figure here is measured through the real codec: a frame at the cap is
 * encoded to audio, decoded back, and authenticated. The arithmetic that turns
 * the locked 64-byte block into a capacity is asserted too, so a "small" change
 * to the header cannot silently move the budget.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { CODEC_PAYLOAD_LENGTH, openSoundChatCodec } from "./codec";
import { derivePairingKeys } from "./crypto";
import { AEAD_TAG_BYTES as CRYPTO_TAG_BYTES, SESSION_SALT_BYTES } from "./crypto";
import {
  FrameCodec,
  HEADER_BYTES,
  MAX_MESSAGE_ASCII_CHARACTERS,
  MAX_MESSAGE_BLOCKS,
  MAX_MESSAGE_PLAINTEXT_BYTES,
  MULTI_BLOCK_PLAINTEXT_BYTES,
  MULTI_HEADER_BYTES,
  MessageTooLongError,
  SINGLE_BLOCK_PLAINTEXT_BYTES,
  WIRE_BLOCK_BYTES,
} from "./protocol";

const PLAN = fileURLToPath(
  new URL("../../../prompts/sound-chat/SOUND_CHAT_MASTER_PLAN.md", import.meta.url),
);

const codec = await openSoundChatCodec();
afterAll(() => {
  codec.close();
});

async function pairage(): Promise<{ a: FrameCodec; b: FrameCodec }> {
  const keys = await derivePairingKeys("ABCD2345");
  const a = new FrameCodec({ keys, selfId: 0, sendSalt: new Uint8Array(16).fill(3) });
  const b = new FrameCodec({ keys, selfId: 1, sendSalt: new Uint8Array(16).fill(4) });
  a.adoptPeerSalt(new Uint8Array(16).fill(4));
  b.adoptPeerSalt(new Uint8Array(16).fill(3));
  return { a, b };
}

/** Encodes a frame with the real codec and decodes it back through the real Rx. */
function throughTheCodec(frame: Uint8Array): Uint8Array | null {
  const waveform = codec.encode(frame);
  let decoded: Uint8Array | null = null;
  const frames = Math.floor(waveform.length / 1024);
  for (let index = 0; index < frames; index += 1) {
    const chunk = waveform.subarray(index * 1024, (index + 1) * 1024);
    const out = codec.decode(chunk);
    if (out !== null) decoded = out;
  }
  return decoded;
}

describe("measured capacity", () => {
  it("derives the budget from the locked block, not from a hand-typed number", () => {
    expect(WIRE_BLOCK_BYTES).toBe(CODEC_PAYLOAD_LENGTH);
    expect(CRYPTO_TAG_BYTES).toBe(16);
    expect(SINGLE_BLOCK_PLAINTEXT_BYTES).toBe(WIRE_BLOCK_BYTES - HEADER_BYTES - CRYPTO_TAG_BYTES);
    expect(MULTI_BLOCK_PLAINTEXT_BYTES).toBe(
      WIRE_BLOCK_BYTES - MULTI_HEADER_BYTES - CRYPTO_TAG_BYTES,
    );
    expect(MULTI_HEADER_BYTES).toBe(HEADER_BYTES + 1);
    expect(MAX_MESSAGE_PLAINTEXT_BYTES).toBe(MULTI_BLOCK_PLAINTEXT_BYTES * MAX_MESSAGE_BLOCKS);
    // The numbers every document must agree with: 43 / 42 / 84.
    expect(SINGLE_BLOCK_PLAINTEXT_BYTES).toBe(43);
    expect(MULTI_BLOCK_PLAINTEXT_BYTES).toBe(42);
    expect(MAX_MESSAGE_PLAINTEXT_BYTES).toBe(84);
    expect(MAX_MESSAGE_ASCII_CHARACTERS).toBe(84);
    expect(SESSION_SALT_BYTES).toBe(16);
  });

  it("round-trips a single-block message at exactly 43 bytes, through the codec", async () => {
    const { a, b } = await pairage();
    const text = "A".repeat(SINGLE_BLOCK_PLAINTEXT_BYTES);
    const frames = await a.buildMessageFrames(new TextEncoder().encode(text), 5);
    expect(frames).toHaveLength(1);
    const decoded = throughTheCodec(frames[0] as Uint8Array);
    expect(decoded).not.toBeNull();
    const parsed = await b.parse(decoded as Uint8Array);
    expect(parsed.ok && parsed.frame.kind === "message").toBe(true);
    if (!parsed.ok || parsed.frame.kind !== "message") throw new Error("expected a message");
    expect(new TextDecoder().decode(parsed.frame.plaintext)).toBe(text);
  });

  it("round-trips a two-block message at exactly 84 bytes, block by block", async () => {
    const { a, b } = await pairage();
    const text = "B".repeat(MAX_MESSAGE_PLAINTEXT_BYTES);
    const frames = await a.buildMessageFrames(new TextEncoder().encode(text), 6);
    expect(frames).toHaveLength(2);
    const decoded: string[] = [];
    for (const frame of frames) {
      const block = throughTheCodec(frame);
      const parsed = await b.parse(block as Uint8Array);
      if (!parsed.ok || parsed.frame.kind !== "message") throw new Error("expected a block");
      decoded.push(new TextDecoder().decode(parsed.frame.plaintext));
    }
    expect(decoded.join("")).toBe(text);
    expect(decoded[0]).toHaveLength(MULTI_BLOCK_PLAINTEXT_BYTES);
    expect(decoded[1]).toHaveLength(MULTI_BLOCK_PLAINTEXT_BYTES);
  });

  it("refuses one byte past the cap, in either representation", async () => {
    const { a } = await pairage();
    await expect(
      a.buildMessageFrames(new Uint8Array(MAX_MESSAGE_PLAINTEXT_BYTES + 1), 7),
    ).rejects.toThrowError(MessageTooLongError);
    // UTF-8, not characters: 43 two-byte characters are 86 bytes and do not fit.
    await expect(
      a.buildMessageFrames(new TextEncoder().encode("é".repeat(43)), 7),
    ).rejects.toThrowError(MessageTooLongError);
    // 42 two-byte characters are exactly at the cap.
    const frames = await a.buildMessageFrames(new TextEncoder().encode("é".repeat(42)), 8);
    expect(frames).toHaveLength(2);
  });
});

describe("the documents agree with the measurement (10.1 class 7)", () => {
  it("states the measured capacities in the master plan", () => {
    // Whitespace is normalised: the rows wrap, and the assertion is about the
    // numbers a human reads, not about how the line breaks fell.
    const plan = readFileSync(PLAN, "utf8").replace(/\s+/g, " ");
    // Section 3's message-length row and Section 4's arithmetic both carry the
    // measured numbers, spelled out.
    expect(plan).toContain("84 usable bytes of plaintext");
    expect(plan).toContain("= 84 ASCII characters");
    expect(plan).toContain("2 x 42");
    // The stale pre-measurement estimates must be gone.
    expect(plan).not.toContain("~70 usable bytes");
    expect(plan).not.toContain("~86 bytes");
    expect(plan).not.toContain("~39 bytes");
  });
});
