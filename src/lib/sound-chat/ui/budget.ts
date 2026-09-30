/**
 * What the composer is allowed to promise, derived from the measured medium
 * rather than from an estimate typed by a human.
 *
 * Every number here comes from `protocol.ts` and `session.ts`, which own the
 * measurement (Phase 2, `capacity.test.ts`): a 64-byte fixed block minus a
 * 5-byte header and a 16-byte AEAD tag is 43 bytes of plaintext, and a
 * two-block message spends one more byte per block on the `seq` field, so the
 * cap is 2 x 42 = 84 bytes. At `AUDIBLE_FASTEST` a block is 90 frames x 1024 /
 * 48000 Hz = 1.92 s of audio, so a note is 1.92 s or 3.84 s of sound.
 *
 * The composer's whole job is to be able to say "about two seconds" and "84
 * bytes" *before* the user hits send, and to refuse the same messages the
 * protocol refuses. That last half is the part worth guarding: this module
 * encodes the cap with `TextEncoder`, exactly as `session.send()` does, so a
 * prediction and the verdict it predicts can never drift apart. `budget.test.ts`
 * asserts that agreement over the whole boundary surface, including non-Latin
 * text, where characters and bytes are not the same number.
 *
 * It counts UTF-8 *bytes*, never UTF-16 code units. A `maxLength` on the
 * textarea would count code units and be wrong in both directions at once: 84
 * emoji is 168 code units but 336 bytes (three times over the cap), while 42
 * accented letters is 84 code units and exactly 84 bytes (exactly at the cap).
 */

import {
  MAX_MESSAGE_BLOCKS,
  MAX_MESSAGE_PLAINTEXT_BYTES,
  SINGLE_BLOCK_PLAINTEXT_BYTES,
} from "../protocol";
import { BLOCK_DURATION_MS } from "../session";

export { MAX_MESSAGE_PLAINTEXT_BYTES, SINGLE_BLOCK_PLAINTEXT_BYTES, BLOCK_DURATION_MS };

/** Longest message the protocol will split into blocks at all. */
export const MAX_MESSAGE_BLOCKS_ALLOWED = MAX_MESSAGE_BLOCKS;

const encoder = new TextEncoder();

export type MessageBudget = {
  /** Code points, so one emoji counts once rather than twice. */
  readonly characters: number;
  /** What the protocol actually carries: UTF-8 bytes. */
  readonly bytes: number;
  readonly capBytes: number;
  /** Negative when the note is over the cap. */
  readonly remainingBytes: number;
  /** 0 for an empty note; the blocks it needs if it fits. */
  readonly blocks: number;
  readonly fits: boolean;
  /** Exactly at the cap and not one byte over. */
  readonly atCap: boolean;
  /** 0 when the note cannot be sent at all. */
  readonly transmitMs: number;
  /** True when one block carries it, which is the fast path worth showing. */
  readonly singleBlock: boolean;
};

export function measureMessage(text: string): MessageBudget {
  const bytes = encoder.encode(text).length;
  // `Array.from` rather than a spread: both iterate code points, and the spread
  // form is flagged for splitting a string into code units, which is the exact
  // mistake this function exists to avoid.
  const characters = Array.from(text).length;
  const blocks = blocksForBytes(bytes);
  const fits = bytes > 0 && blocks !== null;
  return {
    characters,
    bytes,
    capBytes: MAX_MESSAGE_PLAINTEXT_BYTES,
    remainingBytes: MAX_MESSAGE_PLAINTEXT_BYTES - bytes,
    blocks: fits ? blocks : 0,
    fits,
    atCap: bytes === MAX_MESSAGE_PLAINTEXT_BYTES,
    transmitMs: fits ? blocks * BLOCK_DURATION_MS : 0,
    singleBlock: fits && blocks === 1,
  };
}

/**
 * How many 64-byte blocks `bytes` of plaintext needs, or `null` when it cannot
 * fit inside the two-block cap. The two-block path carries one byte less per
 * block than the single-block path, which is why 43 and 84 are the two
 * interesting boundaries rather than 43 and 86.
 */
export function blocksForBytes(bytes: number): number | null {
  if (bytes <= 0) return 0;
  if (bytes <= SINGLE_BLOCK_PLAINTEXT_BYTES) return 1;
  if (bytes <= MAX_MESSAGE_PLAINTEXT_BYTES) return MAX_MESSAGE_BLOCKS;
  return null;
}

/**
 * "about 2 seconds", from a measured millisecond figure. Deliberately coarse:
 * the honest claim is an estimate from our own schedule, never a measurement of
 * what the other device has actually decoded.
 */
export function secondsLabel(milliseconds: number): string {
  const seconds = milliseconds / 1000;
  const rounded = Math.round(seconds * 10) / 10;
  const text = Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
  return `${text} second${rounded === 1 ? "" : "s"}`;
}
