/**
 * The composer's budget, asserted against the protocol's own measurements and
 * against the verdict the wire layer actually returns.
 *
 * The second half is the part that matters (master plan Section 10.1 class 12):
 * a counter that predicts "43 bytes, one block" while the protocol refuses at 42
 * would make the UI lie on exactly the boundary a user is most likely to hit. So
 * every boundary is checked against the real `FrameCodec`, not against a number
 * this file typed.
 */

import { afterAll, describe, expect, it } from "vitest";
import { openSoundChatCodec } from "../codec";
import { derivePairingKeys } from "../crypto";
import {
  FrameCodec,
  MAX_MESSAGE_PLAINTEXT_BYTES,
  MessageTooLongError,
  SINGLE_BLOCK_PLAINTEXT_BYTES,
} from "../protocol";
import { BLOCK_DURATION_MS, blocksForBytes, measureMessage, secondsLabel } from "./budget";

const codec = await openSoundChatCodec();
afterAll(() => {
  codec.close();
});

const CODE = "ABCD2345";
const wire = new FrameCodec({
  keys: await derivePairingKeys(CODE),
  selfId: 1,
  sendSalt: new Uint8Array(16),
});
const encoder = new TextEncoder();

describe("measured capacity", () => {
  it("uses the numbers the protocol measured, not hand-typed ones", () => {
    expect(SINGLE_BLOCK_PLAINTEXT_BYTES).toBe(43);
    expect(MAX_MESSAGE_PLAINTEXT_BYTES).toBe(84);
    expect(BLOCK_DURATION_MS).toBe(1_920);
  });

  it("splits at 43 and 84 bytes and refuses beyond", () => {
    expect(blocksForBytes(0)).toBe(0);
    expect(blocksForBytes(1)).toBe(1);
    expect(blocksForBytes(43)).toBe(1);
    expect(blocksForBytes(44)).toBe(2);
    expect(blocksForBytes(84)).toBe(2);
    expect(blocksForBytes(85)).toBeNull();
    expect(blocksForBytes(1_000)).toBeNull();
  });
});

describe("measureMessage", () => {
  it("treats an empty note as nothing to send, not as a zero-length block", () => {
    const budget = measureMessage("");
    expect(budget).toMatchObject({ characters: 0, bytes: 0, blocks: 0, fits: false });
    expect(budget.transmitMs).toBe(0);
  });

  it("prices a single-block note at one block of sound", () => {
    const budget = measureMessage("hi");
    expect(budget).toMatchObject({ bytes: 2, blocks: 1, fits: true, singleBlock: true });
    expect(budget.transmitMs).toBe(BLOCK_DURATION_MS);
  });

  it("crosses to two blocks at 44 bytes and says so", () => {
    expect(measureMessage("a".repeat(43))).toMatchObject({ blocks: 1, singleBlock: true });
    expect(measureMessage("a".repeat(44))).toMatchObject({ blocks: 2, singleBlock: false });
    expect(measureMessage("a".repeat(44)).transmitMs).toBe(2 * BLOCK_DURATION_MS);
  });

  it("marks exactly 84 bytes as at the cap, and 85 as over it", () => {
    const atCap = measureMessage("a".repeat(84));
    expect(atCap).toMatchObject({ bytes: 84, blocks: 2, fits: true, atCap: true });
    expect(atCap.remainingBytes).toBe(0);
    const over = measureMessage("a".repeat(85));
    expect(over).toMatchObject({ bytes: 85, fits: false, atCap: false });
    expect(over.remainingBytes).toBe(-1);
    expect(over.blocks).toBe(0);
    expect(over.transmitMs).toBe(0);
  });

  it("counts UTF-8 bytes, not UTF-16 code units", () => {
    // 42 two-byte characters is exactly 84 bytes: at the cap, in 42 characters.
    const accented = measureMessage("é".repeat(42));
    expect(accented).toMatchObject({ characters: 42, bytes: 84, blocks: 2, fits: true });
    // One more is one byte over.
    expect(measureMessage("é".repeat(43))).toMatchObject({ bytes: 86, fits: false });
    // A four-byte emoji costs four bytes but is one character, so `maxLength`
    // on the textarea would be wrong in both directions at once.
    const emoji = measureMessage("\u{1F600}".repeat(21));
    expect(emoji).toMatchObject({ characters: 21, bytes: 84, fits: true });
  });

  it("counts astral characters once, so a paste cannot smuggle past the counter", () => {
    // A lone surrogate half is what an emoji paste looks like mid-edit; it is
    // encoded as the replacement character (3 bytes) and must not read as one.
    const budget = measureMessage("\uD83D");
    expect(budget.characters).toBe(1);
    expect(budget.bytes).toBe(3);
    expect(budget.fits).toBe(true);
  });

  it("counts a newline as the one byte it is", () => {
    expect(measureMessage("a\nb")).toMatchObject({ bytes: 3, characters: 3, blocks: 1 });
  });
});

describe("secondsLabel", () => {
  it("rounds a measured millisecond figure to one decimal and pluralises once", () => {
    expect(secondsLabel(1_920)).toBe("1.9 seconds");
    expect(secondsLabel(3_840)).toBe("3.8 seconds");
    expect(secondsLabel(1_000)).toBe("1 second");
    expect(secondsLabel(2_220)).toBe("2.2 seconds");
  });
});

describe("agreement with the wire layer's own verdict", () => {
  /** What the protocol does with exactly these bytes: blocks, or a refusal. */
  async function protocolAccepts(text: string): Promise<boolean> {
    try {
      const frames = await wire.buildMessageFrames(encoder.encode(text), 1);
      return frames.length >= 1;
    } catch (error) {
      if (error instanceof MessageTooLongError) return false;
      throw error;
    }
  }

  it("predicts the wire layer's verdict at every boundary", async () => {
    const probes: readonly string[] = [
      "",
      "a",
      "a".repeat(43),
      "a".repeat(44),
      "a".repeat(84),
      "a".repeat(85),
      "é".repeat(42),
      "é".repeat(43),
      "\u{1F600}".repeat(21),
      "\u{1F600}".repeat(22),
    ];
    for (const text of probes) {
      const budget = measureMessage(text);
      if (budget.bytes === 0) continue;
      const accepted = await protocolAccepts(text);
      expect(accepted, `disagreement at ${budget.bytes} bytes`).toBe(budget.fits);
    }
  });

  it("refuses a 1-byte body: the empty-after-header frame the protocol rejects", async () => {
    // `MessageTooLongError` is not the only refusal the wire layer makes, so the
    // probe above only asserts agreement on the *cap*. An empty body is a
    // different refusal, and the composer must not offer to send it.
    expect(measureMessage("").fits).toBe(false);
  });

  it("prices a note that is one byte over the cap as unsendable, not as two blocks", () => {
    const over = measureMessage("a".repeat(85));
    expect(over.fits).toBe(false);
    expect(over.blocks).toBe(0);
    expect(over.transmitMs).toBe(0);
    expect(over.remainingBytes).toBe(-1);
  });
});
