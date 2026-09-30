/**
 * Deterministic test payloads for the Phase 0 harness.
 *
 * Payloads follow the locked wire format (master plan Section 4):
 * `ver | msgId | fromPeerId | len | ciphertext+tag | zero padding` in one fixed
 * 64-byte block. The "ciphertext" here is a deterministic pseudo-random byte
 * pattern and the trailing 16 bytes stand in for the AEAD tag, not real crypto
 * — Phase 2 owns that — but it exercises the same binary-safety surface (every
 * byte value, including 0x00 and >= 0x80) at the real measured capacity.
 */

import { CODEC_PAYLOAD_LENGTH } from "../spike/codec";

/** Section 4 byte offsets, counted from the measured single-block budget. */
const HEADER_BYTES = 5;
/** 64 - 5 header bytes - 16 AEAD tag bytes, measured in Phase 2. */
const SINGLE_BLOCK_PLAINTEXT_BYTES = CODEC_PAYLOAD_LENGTH - HEADER_BYTES - 16;

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

/** Peer ids are 0 and 1 (`PeerId`); the locked layout has no other values. */
const DISPLAYER_PEER_ID = 0x0;
const ENTERER_PEER_ID = 0x1;

/**
 * 64-byte block for `tag`: msgId = tag, 43 bytes of body, then 16 bytes that
 * stand in for the AEAD tag. Body bytes come from a small LCG so any payload is
 * reproducible anywhere.
 */
export function wireBlock(tag: number, bodyBytes = SINGLE_BLOCK_PLAINTEXT_BYTES): Uint8Array {
  const block = new Uint8Array(CODEC_PAYLOAD_LENGTH);
  block[0] = 1; // version
  block[1] = (tag >> 8) & 0xff; // msgId hi
  block[2] = tag & 0xff; // msgId lo
  // Real peer ids, not 0x0a/0x0b: these blocks are the obvious fixture for a
  // Phase 3/4 protocol test, and `FrameCodec.parse` rejects any other value as
  // `bad-peer` (P2V finding 18).
  block[3] = tag % 2 === 0 ? DISPLAYER_PEER_ID : ENTERER_PEER_ID; // fromPeerId
  block[4] = bodyBytes; // plaintext length, as protocol.ts writes it
  let state = (tag * 2654435761) >>> 0;
  for (let i = 0; i < bodyBytes && 5 + i < block.length; i += 1) {
    state = (Math.imul(state, 1103515245) + 12345) >>> 0;
    // 0xff is forced in so the top of the byte range is always covered.
    block[5 + i] = i === 0 ? 0xff : (state >> 16) & 0xff;
  }
  return block;
}

export function payload(tag: number, bodyBytes = SINGLE_BLOCK_PLAINTEXT_BYTES): TestPayload {
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
