/**
 * Client-side cryptography for Husk.
 *
 * Web Crypto only. AES-256-GCM with a fresh random IV per payload. The room key
 * never leaves the browser: it is generated here and carried in the URL
 * fragment, which browsers never transmit to a server.
 */

import { IV_BYTES, ROOM_KEY_BYTES } from "./config";

export type Sealed = {
  readonly iv: string;
  readonly ct: string;
};

export class DecryptionFailedError extends Error {
  constructor() {
    super("Message could not be verified");
    this.name = "DecryptionFailedError";
  }
}

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

export function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function fromBase64Url(value: string): Uint8Array {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

/** Generates a fresh 256-bit room key as raw bytes. */
export function generateRoomKeyBytes(): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(ROOM_KEY_BYTES));
}

export function generateRoomKeyFragment(): string {
  return toBase64Url(generateRoomKeyBytes());
}

export async function importRoomKey(fragment: string): Promise<CryptoKey> {
  const raw = fromBase64Url(fragment);
  if (raw.byteLength !== ROOM_KEY_BYTES) {
    throw new Error("Invalid room key length");
  }
  // SAFETY: raw is a freshly allocated Uint8Array, which is a valid BufferSource.
  return crypto.subtle.importKey("raw", raw as BufferSource, { name: "AES-GCM" }, false, [
    "encrypt",
    "decrypt",
  ]);
}

export async function sealBytes(
  key: CryptoKey,
  plaintext: Uint8Array,
): Promise<{ iv: Uint8Array<ArrayBuffer>; ciphertext: Uint8Array<ArrayBuffer> }> {
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  // SAFETY: both values are Uint8Array instances, which are valid BufferSources.
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: iv as BufferSource },
    key,
    plaintext as BufferSource,
  );
  return { iv, ciphertext: new Uint8Array(ciphertext) };
}

export async function openBytes(
  key: CryptoKey,
  iv: Uint8Array,
  ciphertext: Uint8Array,
): Promise<Uint8Array<ArrayBuffer>> {
  try {
    // SAFETY: both values are Uint8Array instances, which are valid BufferSources.
    const plaintext = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: iv as BufferSource },
      key,
      ciphertext as BufferSource,
    );
    return new Uint8Array(plaintext);
  } catch {
    throw new DecryptionFailedError();
  }
}

/** Encrypts a JSON-serialisable payload into transport-safe base64url strings. */
export async function seal<T>(key: CryptoKey, payload: T): Promise<Sealed> {
  const plaintext = textEncoder.encode(JSON.stringify(payload));
  const { iv, ciphertext } = await sealBytes(key, plaintext);
  return { iv: toBase64Url(iv), ct: toBase64Url(ciphertext) };
}

/**
 * Decrypts a sealed payload. Throws DecryptionFailedError when the GCM
 * authentication tag does not verify, so callers can surface a explicit
 * "could not be verified" state instead of dropping the message silently.
 */
export async function open<T>(key: CryptoKey, sealed: Sealed): Promise<T> {
  const plaintext = await openBytes(key, fromBase64Url(sealed.iv), fromBase64Url(sealed.ct));
  try {
    // SAFETY: the GCM tag verified above, so this plaintext was produced by a
    // holder of the room key and carries the agreed payload shape.
    return JSON.parse(textDecoder.decode(plaintext)) as T;
  } catch {
    throw new DecryptionFailedError();
  }
}
