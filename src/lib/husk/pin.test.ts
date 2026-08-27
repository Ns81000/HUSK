import { describe, expect, it } from "vitest";
import { formatPin, generatePin, isValidPin } from "./pin";

describe("pin", () => {
  it("always produces a valid six digit PIN", () => {
    for (let index = 0; index < 500; index += 1) {
      expect(isValidPin(generatePin())).toBe(true);
    }
  });

  it("rejects malformed PINs", () => {
    expect(isValidPin("012345")).toBe(false);
    expect(isValidPin("12345")).toBe(false);
    expect(isValidPin("1234567")).toBe(false);
    expect(isValidPin("12a456")).toBe(false);
  });

  it("spreads across the range rather than clustering", () => {
    const seen = new Set<string>();
    for (let index = 0; index < 2000; index += 1) {
      seen.add(generatePin());
    }
    expect(seen.size).toBeGreaterThan(1900);
  });

  it("uses rejection sampling for uniformity", () => {
    const values = [0xff, 0xff, 0xff, 0xff, 0x00, 0x00, 0x00, 0x01];
    let cursor = 0;
    const pin = generatePin((length) => {
      const bytes = new Uint8Array(length);
      for (let index = 0; index < length; index += 1) {
        bytes[index] = values[cursor] ?? 0;
        cursor += 1;
      }
      return bytes;
    });
    expect(pin).toBe("100001");
  });

  it("formats for display without changing digits", () => {
    expect(formatPin("482910")).toBe("482 910");
  });
});
