/**
 * Short-lived, single-use signed tickets for R2 uploads and downloads.
 *
 * Signed with HMAC-SHA256 over the object key, the operation and the expiry.
 * The ticket never carries the room key; it authorises byte transfer of
 * ciphertext only.
 */

const encoder = new TextEncoder();

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export async function signTicket(
  secret: string,
  operation: "put" | "get",
  objectKey: string,
  expiresAt: number,
): Promise<string> {
  const key = await hmacKey(secret);
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    encoder.encode(`${operation}:${objectKey}:${expiresAt}`),
  );
  return base64Url(new Uint8Array(signature));
}

export async function verifyTicket(
  secret: string,
  operation: "put" | "get",
  objectKey: string,
  expiresAt: number,
  signature: string,
  now: number,
): Promise<boolean> {
  if (Number.isNaN(expiresAt) || expiresAt * 1000 < now) {
    return false;
  }
  const expected = await signTicket(secret, operation, objectKey, expiresAt);
  if (expected.length !== signature.length) {
    return false;
  }
  let diff = 0;
  for (let index = 0; index < expected.length; index += 1) {
    diff |= expected.charCodeAt(index) ^ signature.charCodeAt(index);
  }
  return diff === 0;
}
