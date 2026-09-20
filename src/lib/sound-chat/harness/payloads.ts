/**
 * Deterministic test payloads for the Phase 0 harness.
 *
 * Payloads are modelled on the locked wire format (master plan Section 4):
 * `ver | msgId | fromPeerId | len | ciphertext+tag | zero padding` in one fixed
 * 64-byte block. The "ciphertext" here is a deterministic pseudo-random byte
 * pattern, not real crypto — Phase 2 owns that — but it exercises the same
 * binary-safety surface (every byte value, including 0x00 and >= 0x80).
 */

import { CODEC_PAYLOAD_LENGTH } from "../spike/codec";

export type TestPayload = {
  id: string;
  bytes: Uint8Array;
  hex: string;
};

export function toHex(bytes: Uint8Array): string {
  let hex = "";
  for (let i = 0; i < bytes.length; i += 1) {
    hex += (bytes[i] ?? 0).toString(16).padStart(2, "0");
  }
  return hex;
}

/**
 * 64-byte block for `tag`: msgId = tag, 39 bytes of body, zero padding.
 * Body bytes come from a small LCG so any payload is reproducible anywhere.
 */
export function wireBlock(tag: number, bodyBytes = 39): Uint8Array {
  const block = new Uint8Array(CODEC_PAYLOAD_LENGTH);
  block[0] = 1; // version
  block[1] = (tag >> 8) & 0xff; // msgId hi
  block[2] = tag & 0xff; // msgId lo
  block[3] = tag % 2 === 0 ? 0x0a : 0x0b; // fromPeerId
  block[4] = bodyBytes; // ciphertext length
  let state = (tag * 2654435761) >>> 0;
  for (let i = 0; i < bodyBytes && 5 + i < block.length; i += 1) {
    state = (Math.imul(state, 1103515245) + 12345) >>> 0;
    // 0xff is forced in so the top of the byte range is always covered.
    block[5 + i] = i === 0 ? 0xff : (state >> 16) & 0xff;
  }
  return block;
}

export function payload(tag: number, bodyBytes = 39): TestPayload {
  const bytes = wireBlock(tag, bodyBytes);
  return { id: `block-${tag}-${bodyBytes}b`, bytes, hex: toHex(bytes) };
}

/** The single block most variants transmit. */
export const PRIMARY_PAYLOAD = payload(0x1234);

/** Used as the "someone else in the room" second transmission. */
export const FOREIGN_PAYLOAD = payload(0x5678);

/** Three back-to-back transmissions, for the dedupe/long-session variant. */
export const SEQUENCE_PAYLOADS = [payload(0x0001), payload(0x0002), payload(0x0003)];

export function fromHex(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i += 1) {
    bytes[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}
