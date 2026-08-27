/**
 * Room PIN helpers. PINs are 6 digits drawn from a CSPRNG with rejection
 * sampling, so every value in the 900,000-wide range is equally likely.
 */

import { PIN_LENGTH } from "./config";

const MIN_PIN = 10 ** (PIN_LENGTH - 1);
const MAX_PIN = 10 ** PIN_LENGTH - 1;
const RANGE = MAX_PIN - MIN_PIN + 1;

export function isValidPin(value: string): boolean {
  return new RegExp(`^[1-9][0-9]{${PIN_LENGTH - 1}}$`).test(value);
}

export function generatePin(
  randomBytes: (length: number) => Uint8Array = (length) =>
    crypto.getRandomValues(new Uint8Array(length)),
): string {
  const limit = Math.floor(0x100000000 / RANGE) * RANGE;
  for (;;) {
    const bytes = randomBytes(4);
    const value =
      ((bytes[0] ?? 0) << 24) |
      ((bytes[1] ?? 0) << 16) |
      ((bytes[2] ?? 0) << 8) |
      (bytes[3] ?? 0);
    const unsigned = value >>> 0;
    if (unsigned < limit) {
      return String(MIN_PIN + (unsigned % RANGE));
    }
  }
}

export function formatPin(pin: string): string {
  return `${pin.slice(0, 3)} ${pin.slice(3)}`;
}
