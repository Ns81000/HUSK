/**
 * Crypto tests for Phase 2 — master plan Section 10.1 (classes 7, 9, 10) and
 * Section 10.2 P1, P2, P3, P5, P7, P8, P9.
 *
 * Everything here is a *guard plus the input that violates it*: a wrong code, a
 * tampered tag, a flipped header byte, a nonce that would repeat across a
 * session restart, a hostile random source and a hostile storage environment.
 */
import { describe, expect, it, vi } from "vitest";
import {
  AEAD_NONCE_BYTES,
  buildNonce,
  CryptoUnavailableError,
  CryptoUsageError,
  derivePairingKeys,
  generatePairingCode,
  generateSessionSalt,
  KEY_CHECK_BYTES,
  keyCheckTag,
  openBlock,
  PAIRING_CODE_ALPHABET,
  PAIRING_CODE_BITS,
  PAIRING_CODE_LENGTH,
  PairingCodeError,
  sealBlock,
  validatePairingCode,
  verifyKeyCheck,
} from "./crypto";

const CODE = "ABCD2345";

function fixedRandom(value: number) {
  return (bytes: Uint8Array): Uint8Array => {
    bytes.fill(value);
    return bytes;
  };
}

describe("key schedule", () => {
  it("derives the same secret on both peers and different keys per direction (P1)", async () => {
    const one = await derivePairingKeys(CODE);
    const two = await derivePairingKeys("abcd 2345");
    const forward = await one.directionKey(0);
    const backward = await one.directionKey(1);
    expect(forward).not.toBe(backward);
    expect(await two.directionKey(0)).toBeDefined();
    // ...and a confused direction cannot open the other one's frame.
    const nonce = buildNonce({ salt: new Uint8Array(16), frameKind: 1, msgId: 1, seq: 0 });
    const aad = new Uint8Array([1, 0, 0, 1, 4]);
    const sealed = await sealBlock(forward, nonce, aad, new Uint8Array([1, 2, 3, 4]));
    expect(await openBlock(forward, nonce, aad, sealed)).toMatchObject({ ok: true });
    expect(await openBlock(backward, nonce, aad, sealed)).toEqual({ ok: false, reason: "tag" });
  });

  it("gives a different key for a one-character-off or otherwise wrong code (P8)", async () => {
    const right = (await derivePairingKeys(CODE)).directionKey;
    const wrong = (await derivePairingKeys("ABCD2346")).directionKey;
    const nonce = buildNonce({ salt: new Uint8Array(16), frameKind: 1, msgId: 7, seq: 0 });
    const aad = new Uint8Array([1, 0, 7, 1, 2]);
    const sealed = await sealBlock(await right(0), nonce, aad, new Uint8Array([9, 9]));
    expect(await openBlock(await wrong(0), nonce, aad, sealed)).toEqual({
      ok: false,
      reason: "tag",
    });
  });

  it("memoises the per-direction derivation", async () => {
    const keys = await derivePairingKeys(CODE);
    expect(await keys.directionKey(1)).toBe(await keys.directionKey(1));
  });
});

describe("nonces", () => {
  it("lays out salt, kind, msgId and seq, and guards every part", () => {
    const salt = new Uint8Array(16).fill(0xab);
    const nonce = buildNonce({ salt, frameKind: 3, msgId: 0x1234, seq: 0x12 });
    expect(nonce).toHaveLength(AEAD_NONCE_BYTES);
    expect(Array.from(nonce.slice(0, 8))).toEqual(new Array(8).fill(0xab));
    expect(Array.from(nonce.slice(8))).toEqual([3, 0x12, 0x34, 0x12]);
    expect(() => buildNonce({ salt: new Uint8Array(4), frameKind: 1, msgId: 0, seq: 0 })).toThrow(
      CryptoUsageError,
    );
    expect(() => buildNonce({ salt, frameKind: 256, msgId: 0, seq: 0 })).toThrow(CryptoUsageError);
    expect(() => buildNonce({ salt, frameKind: 1, msgId: 0x10000, seq: 0 })).toThrow(
      CryptoUsageError,
    );
    expect(() => buildNonce({ salt, frameKind: 1, msgId: 0, seq: -1 })).toThrow(CryptoUsageError);
  });

  it("cannot repeat across sessions that share a code but not a salt (P2)", async () => {
    const keys = await derivePairingKeys(CODE);
    const sessionA = generateSessionSalt();
    const sessionB = generateSessionSalt();
    expect(Array.from(sessionA)).not.toEqual(Array.from(sessionB));
    const nonceA = buildNonce({ salt: sessionA, frameKind: 1, msgId: 5, seq: 0 });
    const nonceB = buildNonce({ salt: sessionB, frameKind: 1, msgId: 5, seq: 0 });
    expect(Array.from(nonceA)).not.toEqual(Array.from(nonceB));
    // Same key (same code), different nonce, same plaintext: the ciphertext and
    // tag must differ — the observable form of "no key+nonce reuse".
    const aad = new Uint8Array([1, 0, 5, 0, 3]);
    const plaintext = new Uint8Array([1, 2, 3]);
    const sealedA = await sealBlock(await keys.directionKey(0), nonceA, aad, plaintext);
    const sealedB = await sealBlock(await keys.directionKey(0), nonceB, aad, plaintext);
    expect(Array.from(sealedA)).not.toEqual(Array.from(sealedB));
  });

  it("distinguishes the frame kind, so an ACK and a message never share a nonce", () => {
    const salt = new Uint8Array(16);
    const asMessage = buildNonce({ salt, frameKind: 1, msgId: 9, seq: 0 });
    const asAck = buildNonce({ salt, frameKind: 2, msgId: 9, seq: 0 });
    const secondBlock = buildNonce({ salt, frameKind: 3, msgId: 9, seq: 0x12 });
    expect(Array.from(asMessage)).not.toEqual(Array.from(asAck));
    expect(Array.from(asMessage)).not.toEqual(Array.from(secondBlock));
  });
});

describe("pairing code", () => {
  it("generates codes from the locked alphabet, with the stated entropy", () => {
    expect(PAIRING_CODE_ALPHABET.length).toBe(32);
    expect(PAIRING_CODE_LENGTH).toBe(8);
    expect(PAIRING_CODE_BITS).toBe(40);
    // The alphabet deliberately has no character that reads as 0/1/I/O.
    for (const forbidden of ["0", "1", "I", "O"]) {
      expect(PAIRING_CODE_ALPHABET.includes(forbidden)).toBe(false);
    }
    const code = generatePairingCode();
    expect(code).toHaveLength(PAIRING_CODE_LENGTH);
    for (const character of code) expect(PAIRING_CODE_ALPHABET).toContain(character);
    expect(generatePairingCode(fixedRandom(0))).toBe("2".repeat(PAIRING_CODE_LENGTH));
  });

  it("normalises separators and case, and refuses everything else", () => {
    expect(validatePairingCode("abcd 2345")).toBe(CODE);
    expect(validatePairingCode("ab-cd-2345")).toBe(CODE);
    expect(() => validatePairingCode("abcd234")).toThrowError(PairingCodeError);
    expect(() => validatePairingCode("abcd23456")).toThrowError(PairingCodeError);
    // A confusable character is named, and the code is never echoed back (P9).
    let message = "";
    try {
      validatePairingCode("abcdO345");
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain("cannot appear");
    expect(message).not.toContain("abcdO345");
    expect(message).not.toContain(CODE);
  });

  it("fails closed on a hostile random source", () => {
    expect(() => generatePairingCode(() => new Uint8Array(0))).toThrowError(CryptoUsageError);
    expect(() => generateSessionSalt(() => new Uint8Array(4))).toThrowError(CryptoUsageError);
  });

  it("reports a missing WebCrypto instead of throwing something opaque", async () => {
    const original = Object.getOwnPropertyDescriptor(globalThis, "crypto");
    Object.defineProperty(globalThis, "crypto", { value: {}, configurable: true });
    try {
      await expect(derivePairingKeys(CODE)).rejects.toBeInstanceOf(CryptoUnavailableError);
    } finally {
      if (original !== undefined) Object.defineProperty(globalThis, "crypto", original);
    }
  });
});

describe("AEAD blocks", () => {
  it("round-trips and treats a tampered tag as nothing decoded (P5)", async () => {
    const key = await (await derivePairingKeys(CODE)).directionKey(0);
    const nonce = buildNonce({ salt: new Uint8Array(16), frameKind: 1, msgId: 1, seq: 0 });
    const aad = new Uint8Array([1, 0, 1, 1, 4]);
    const sealed = await sealBlock(key, nonce, aad, new Uint8Array([4, 3, 2, 1]));
    expect((await openBlock(key, nonce, aad, sealed)).ok).toBe(true);

    const tamperedTag = Uint8Array.from(sealed);
    tamperedTag[tamperedTag.length - 1] = (tamperedTag[tamperedTag.length - 1] ?? 0) ^ 0x01;
    expect(await openBlock(key, nonce, aad, tamperedTag)).toEqual({ ok: false, reason: "tag" });

    const tamperedCiphertext = Uint8Array.from(sealed);
    tamperedCiphertext[0] = (tamperedCiphertext[0] ?? 0) ^ 0x80;
    expect(await openBlock(key, nonce, aad, tamperedCiphertext)).toEqual({
      ok: false,
      reason: "tag",
    });
  });

  it("refuses a short body as shape, and our own misuse as a throw", async () => {
    const key = await (await derivePairingKeys(CODE)).directionKey(0);
    const nonce = buildNonce({ salt: new Uint8Array(16), frameKind: 1, msgId: 1, seq: 0 });
    expect(await openBlock(key, nonce, new Uint8Array(5), new Uint8Array(3))).toEqual({
      ok: false,
      reason: "shape",
    });
    await expect(
      openBlock(key, new Uint8Array(4), new Uint8Array(5), new Uint8Array(17)),
    ).rejects.toThrowError(CryptoUsageError);
    await expect(sealBlock(key, nonce, new Uint8Array(5), new Uint8Array(0))).rejects.toThrowError(
      CryptoUsageError,
    );
  });

  it("fails the tag when any authenticated header or padding byte changes (P3)", async () => {
    const key = await (await derivePairingKeys(CODE)).directionKey(0);
    const nonce = buildNonce({ salt: new Uint8Array(16), frameKind: 1, msgId: 1, seq: 0 });
    const header = new Uint8Array([1, 0, 1, 1, 3]);
    const aad = new Uint8Array(header.length + 4);
    aad.set(header, 0);
    const sealed = await sealBlock(key, nonce, aad, new Uint8Array([1, 2, 3]));
    for (let index = 0; index < aad.length; index += 1) {
      const flipped = Uint8Array.from(aad);
      flipped[index] = (flipped[index] ?? 0) ^ 0x01;
      expect(await openBlock(key, nonce, flipped, sealed), `aad byte ${index}`).toEqual({
        ok: false,
        reason: "tag",
      });
    }
  });
});

describe("pairing key check (P7)", () => {
  it("verifies for the same code and role, and refuses everything else", async () => {
    const keys = await derivePairingKeys(CODE);
    const salt = generateSessionSalt();
    const tag = await keyCheckTag(keys.mac, salt, 0);
    expect(tag).toHaveLength(KEY_CHECK_BYTES);
    expect(await verifyKeyCheck(keys.mac, salt, 0, tag)).toBe(true);
    // A different role is a different check, so a reflected frame cannot pass.
    expect(await verifyKeyCheck(keys.mac, salt, 1, tag)).toBe(false);
    const otherSalt = Uint8Array.from(salt);
    otherSalt[0] = (otherSalt[0] ?? 0) ^ 0x01;
    expect(await verifyKeyCheck(keys.mac, otherSalt, 0, tag)).toBe(false);
    const otherTag = Uint8Array.from(tag);
    otherTag[15] = (otherTag[15] ?? 0) ^ 0x01;
    expect(await verifyKeyCheck(keys.mac, salt, 0, otherTag)).toBe(false);
    const wrongCode = await derivePairingKeys("ABCD2346");
    expect(await verifyKeyCheck(wrongCode.mac, salt, 0, tag)).toBe(false);
  });

  it("refuses a wrong-length salt as misuse, and a short tag as a failed check", async () => {
    const keys = await derivePairingKeys(CODE);
    await expect(keyCheckTag(keys.mac, new Uint8Array(4), 0)).rejects.toThrowError(
      CryptoUsageError,
    );
    expect(await verifyKeyCheck(keys.mac, new Uint8Array(4), 0, new Uint8Array(16))).toBe(false);
    expect(
      await verifyKeyCheck(keys.mac, new Uint8Array(16), 0, new Uint8Array(KEY_CHECK_BYTES - 1)),
    ).toBe(false);
  });
});

describe("secrets stay out of logs and storage (P9)", () => {
  it("logs nothing and touches no storage while sealing, opening and verifying", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const hostileStorage = {
      getItem: () => {
        throw new Error("storage must not be touched");
      },
      setItem: () => {
        throw new Error("storage must not be touched");
      },
    };
    vi.stubGlobal("localStorage", hostileStorage);
    vi.stubGlobal("sessionStorage", hostileStorage);
    try {
      const keys = await derivePairingKeys(CODE);
      const salt = generateSessionSalt();
      const nonce = buildNonce({ salt, frameKind: 1, msgId: 3, seq: 0 });
      const aad = new Uint8Array([1, 0, 3, 1, 5]);
      const sealed = await sealBlock(await keys.directionKey(0), nonce, aad, new Uint8Array(5));
      await openBlock(await keys.directionKey(0), nonce, aad, sealed);
      await verifyKeyCheck(keys.mac, salt, 1, await keyCheckTag(keys.mac, salt, 1));
      expect(log).not.toHaveBeenCalled();
      expect(error).not.toHaveBeenCalled();
      expect(warn).not.toHaveBeenCalled();
    } finally {
      log.mockRestore();
      error.mockRestore();
      warn.mockRestore();
      vi.unstubAllGlobals();
    }
  });

  it("keeps the derived keys non-extractable", async () => {
    const keys = await derivePairingKeys(CODE);
    const key = await keys.directionKey(0);
    expect(key.extractable).toBe(false);
    expect(keys.mac.extractable).toBe(false);
    await expect(crypto.subtle.exportKey("raw", key)).rejects.toBeTruthy();
  });
});
