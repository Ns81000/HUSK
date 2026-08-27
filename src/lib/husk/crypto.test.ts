import { describe, expect, it } from "vitest";
import {
  DecryptionFailedError,
  fromBase64Url,
  generateRoomKeyBytes,
  generateRoomKeyFragment,
  importRoomKey,
  open,
  seal,
  sealBytes,
  openBytes,
  toBase64Url,
} from "./crypto";
import { ROOM_KEY_BYTES } from "./config";

describe("crypto", () => {
  it("round-trips base64url", () => {
    const bytes = generateRoomKeyBytes();
    expect(fromBase64Url(toBase64Url(bytes))).toEqual(bytes);
  });

  it("generates 256-bit keys", () => {
    expect(fromBase64Url(generateRoomKeyFragment()).byteLength).toBe(ROOM_KEY_BYTES);
  });

  it("rejects a key of the wrong length", async () => {
    await expect(importRoomKey(toBase64Url(new Uint8Array(16)))).rejects.toThrow();
  });

  it("round-trips a JSON payload", async () => {
    const key = await importRoomKey(generateRoomKeyFragment());
    const sealed = await seal(key, { kind: "text", text: "hello husk" });
    const opened = await open<{ text: string }>(key, sealed);
    expect(opened.text).toBe("hello husk");
  });

  it("uses a fresh IV per payload", async () => {
    const key = await importRoomKey(generateRoomKeyFragment());
    const first = await seal(key, { text: "same" });
    const second = await seal(key, { text: "same" });
    expect(first.iv).not.toBe(second.iv);
    expect(first.ct).not.toBe(second.ct);
  });

  it("fails to decrypt under a different key", async () => {
    const key = await importRoomKey(generateRoomKeyFragment());
    const other = await importRoomKey(generateRoomKeyFragment());
    const sealed = await seal(key, { text: "secret" });
    await expect(open(other, sealed)).rejects.toBeInstanceOf(DecryptionFailedError);
  });

  it("rejects tampered ciphertext via the GCM auth tag", async () => {
    const key = await importRoomKey(generateRoomKeyFragment());
    const plaintext = new TextEncoder().encode("tamper me");
    const { iv, ciphertext } = await sealBytes(key, plaintext);
    const tampered = new Uint8Array(ciphertext);
    tampered[0] = (tampered[0] ?? 0) ^ 0xff;
    await expect(openBytes(key, iv, tampered)).rejects.toBeInstanceOf(DecryptionFailedError);
  });
});
