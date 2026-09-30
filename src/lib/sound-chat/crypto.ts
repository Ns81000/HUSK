/**
 * Sound Chat crypto: the pairing code, the key schedule, and the per-block AEAD
 * that is this feature's *only* integrity signal (ggwave cannot tell "silence"
 * from "corrupted transmission" — `GGWAVE_DEEP_DIVE.md` §3.1).
 *
 * Entropy budget of the manual pairing code (master plan Section 10.2 P8), stated
 * as arithmetic because it is the feature's weakest link:
 * - alphabet: 32 symbols (`23456789A-Z` minus `I` and `O`, so nothing is
 *   confusable with `0`/`1`), `log2(32) = 5` bits per character;
 * - length: 8 characters → `8 * 5 = 40` bits ≈ 1.1e12 codes;
 * - KDF: PBKDF2-HMAC-SHA256, 600000 iterations (OWASP's 2023 PBKDF2-SHA256
 *   figure), fixed domain-separated salt — the two peers share nothing but the
 *   code, so there is no per-pairing salt to use;
 * - measured on this machine (Node 24, `crypto.subtle`): one derivation is
 *   ~150 ms, which is why 600000 iterations is affordable here but *not* raised
 *   further (the derivation runs once per pairing, on the user's own gesture).
 * - honest limit: an attacker who records a transmission can brute-force the
 *   code offline. 2^40 candidates at ~1.6e4 candidates/s on one modern GPU (600k
 *   PBKDF2 iterations) is ~2 years per GPU, and ~26 days on a 30-GPU farm. The
 *   code is a same-room, transcribed-in-person secret that is worth little after
 *   the session ends; this is a documented limit, not a claim of strength.
 *
 * Key schedule (P1: per-direction keys, P2: no key+nonce reuse across sessions):
 * - `master` = PBKDF2(code) — identical on both peers, never used for AEAD;
 * - `directionKey(senderId)` = HKDF-SHA256(master, info="…/direction/<senderId>"),
 *   so each direction of the conversation uses a *different* AES-256 key and a
 *   confused-direction decode fails its tag;
 * - `mac` = HKDF-SHA256(master, info="…/keycheck") — the pairing handshake's
 *   key-confirmation HMAC (never AEAD, so the bootstrap cannot reuse a nonce);
 * - nonces are 12 bytes: the sender's own 16-byte random session salt (8 bytes),
 *   the frame kind, the 16-bit msgId and the block `seq`. Within one direction
 *   that is unique by construction (monotonic msgIds, at most two blocks per
 *   message, one kind per frame set) and across sessions it is fresh because the
 *   salt is fresh. A retry re-transmits the *identical* cached frame bytes, so
 *   its nonce is reused with the identical plaintext — never with different
 *   plaintext, which is the only case AES-GCM fails catastrophically.
 */

/** 32 symbols, `I`/`O` removed so `0`/`1` are never confusable with a code. */
export const PAIRING_CODE_ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";
export const PAIRING_CODE_LENGTH = 8;
/** `PAIRING_CODE_LENGTH * log2(32)` — the code's real entropy budget. */
export const PAIRING_CODE_BITS = 40;

export const PBKDF2_ITERATIONS = 600_000;
export const MASTER_KEY_BYTES = 32;
/** Bytes of the per-session random salt each side sends in its PAIR frame. */
export const SESSION_SALT_BYTES = 16;
/** AES-GCM nonce length: the only length WebCrypto accepts without truncation. */
export const AEAD_NONCE_BYTES = 12;
/** AES-GCM tag length: 128 bits, the locked 16 bytes of the wire format. */
export const AEAD_TAG_BYTES = 16;
/** Truncated HMAC-SHA256 key-confirmation tag length. */
export const KEY_CHECK_BYTES = 16;

/** The only two peers a Sound Chat pairing has. */
export type PeerId = 0 | 1;

/** Injectable randomness, so a test can supply a hostile or fixed source. */
export type RandomSource = (bytes: Uint8Array) => Uint8Array;

/** Our own misuse: caught before it can reach WebCrypto. */
export class CryptoUsageError extends Error {
  override readonly name = "CryptoUsageError";
}

/** A pairing code the user typed that cannot be a code at all (fail closed). */
export class PairingCodeError extends Error {
  override readonly name = "PairingCodeError";
}

/** No WebCrypto in this context (insecure origin, or a hostile environment). */
export class CryptoUnavailableError extends Error {
  override readonly name = "CryptoUnavailableError";
}

function cryptoApi(): Crypto {
  const api = globalThis.crypto;
  if (api === undefined || api.subtle === undefined) {
    throw new CryptoUnavailableError(
      "this browser or context does not expose WebCrypto (crypto.subtle), so Sound Chat cannot encrypt anything",
    );
  }
  return api;
}

function randomBytes(bytes: Uint8Array): Uint8Array {
  return cryptoApi().getRandomValues(bytes);
}

const encoder = new TextEncoder();

function ascii(text: string): Uint8Array {
  return encoder.encode(text);
}

/**
 * SAFETY: every byte array handed to WebCrypto here is a freshly allocated
 * `Uint8Array` (from `TextEncoder`, `getRandomValues`, `subtle.encrypt/decrypt`
 * or an explicit `new Uint8Array(...)`), which is a valid `BufferSource`. The
 * cast exists only because TypeScript types a bare `Uint8Array` parameter as
 * possibly `SharedArrayBuffer`-backed; nothing here is.
 */
function asBufferSource(bytes: Uint8Array): BufferSource {
  return bytes as BufferSource;
}

/** HKDF `salt` argument: fixed, because the peers share only the code. */
const KDF_SALT = ascii("husk-sound-chat/v1/kdf");
const DIRECTION_INFO_PREFIX = "husk-sound-chat/v1/direction/";
const KEY_CHECK_INFO = "husk-sound-chat/v1/keycheck";

/** A fresh 16-byte session salt. The receiver learns it from the PAIR frame. */
export function generateSessionSalt(random: RandomSource = randomBytes): Uint8Array {
  const salt = random(new Uint8Array(SESSION_SALT_BYTES));
  if (salt.length !== SESSION_SALT_BYTES) {
    throw new CryptoUsageError(
      `the random source returned ${salt.length} bytes, expected ${SESSION_SALT_BYTES}`,
    );
  }
  return salt;
}

/**
 * A code from the locked alphabet. `256 % 32 === 0`, so the modulo is uniform
 * with no rejection sampling.
 */
export function generatePairingCode(random: RandomSource = randomBytes): string {
  const bytes = random(new Uint8Array(PAIRING_CODE_LENGTH));
  if (bytes.length !== PAIRING_CODE_LENGTH) {
    throw new CryptoUsageError(
      `the random source returned ${bytes.length} bytes, expected ${PAIRING_CODE_LENGTH}`,
    );
  }
  let code = "";
  for (const byte of bytes) {
    code += PAIRING_CODE_ALPHABET[byte % PAIRING_CODE_ALPHABET.length];
  }
  return code;
}

/** Case- and separator-insensitive form of what the user typed. */
export function normalisePairingCode(input: string): string {
  return input.toUpperCase().replace(/[\s-]/g, "");
}

/**
 * Fail-closed validation of a typed code. The message never contains the code
 * itself (P9): only the length, and the one character that cannot be part of any
 * code. `0`, `1`, `I` and `O` are deliberately absent from the alphabet, so
 * typing one is a typo we can name instead of a handshake that mysteriously
 * fails.
 */
export function validatePairingCode(input: string): string {
  const code = normalisePairingCode(input);
  if (code.length !== PAIRING_CODE_LENGTH) {
    throw new PairingCodeError(
      `A Sound Chat pairing code is exactly ${PAIRING_CODE_LENGTH} characters; that one has ${code.length}.`,
    );
  }
  for (const character of code) {
    if (!PAIRING_CODE_ALPHABET.includes(character)) {
      throw new PairingCodeError(
        `"${character}" cannot appear in a Sound Chat pairing code. The characters are ${PAIRING_CODE_ALPHABET}.`,
      );
    }
  }
  return code;
}

/**
 * Everything a session needs from one pairing code. The master bits stay in this
 * closure — the returned object exposes non-extractable AES/HMAC keys and a
 * memoised per-direction derivation, never a key anyone could read or log (P9).
 */
export type PairingKeys = {
  /** Derives (once per sender id) the AES-256-GCM key of that direction. */
  directionKey(senderId: PeerId): Promise<CryptoKey>;
  /** HMAC-SHA256 key for the pairing key-confirmation frame. */
  readonly mac: CryptoKey;
};

export async function derivePairingKeys(code: string): Promise<PairingKeys> {
  const api = cryptoApi();
  const normalised = validatePairingCode(code);
  const material = await api.subtle.importKey(
    "raw",
    asBufferSource(ascii(normalised)),
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  const masterBits = await api.subtle.deriveBits(
    {
      name: "PBKDF2",
      salt: asBufferSource(KDF_SALT),
      iterations: PBKDF2_ITERATIONS,
      hash: "SHA-256",
    },
    material,
    MASTER_KEY_BYTES * 8,
  );
  const hkdf = await api.subtle.importKey("raw", masterBits, "HKDF", false, ["deriveBits"]);

  const mac = await api.subtle.importKey(
    "raw",
    await api.subtle.deriveBits(
      {
        name: "HKDF",
        hash: "SHA-256",
        salt: asBufferSource(KDF_SALT),
        info: asBufferSource(ascii(KEY_CHECK_INFO)),
      },
      hkdf,
      MASTER_KEY_BYTES * 8,
    ),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );

  const cache = new Map<PeerId, CryptoKey>();
  return {
    mac,
    async directionKey(senderId: PeerId): Promise<CryptoKey> {
      assertPeerId(senderId);
      const cached = cache.get(senderId);
      if (cached !== undefined) return cached;
      const bits = await api.subtle.deriveBits(
        {
          name: "HKDF",
          hash: "SHA-256",
          salt: asBufferSource(KDF_SALT),
          info: asBufferSource(ascii(`${DIRECTION_INFO_PREFIX}${senderId}`)),
        },
        hkdf,
        MASTER_KEY_BYTES * 8,
      );
      const key = await api.subtle.importKey("raw", bits, { name: "AES-GCM" }, false, [
        "encrypt",
        "decrypt",
      ]);
      cache.set(senderId, key);
      return key;
    },
  };
}

/** A peer id is exactly `0` or `1`; anything else is our own misuse. */
export function assertPeerId(value: number): asserts value is PeerId {
  if (value !== 0 && value !== 1) {
    throw new CryptoUsageError(`peer id ${value} is not one of the two Sound Chat peers`);
  }
}

export type NonceParts = {
  /** The sender's own session salt (only its first 8 bytes are used). */
  salt: Uint8Array;
  frameKind: number;
  msgId: number;
  seq: number;
};

/**
 * `salt[0..8) | kind | msgId(2) | seq(1)` — 12 bytes. Every part is validated
 * here, so a nonsense value fails as our own misuse rather than as a WebCrypto
 * error that would read like a decryption failure.
 */
export function buildNonce(parts: NonceParts): Uint8Array {
  const { salt, frameKind, msgId, seq } = parts;
  if (salt.length < 8) {
    throw new CryptoUsageError(`session salt of ${salt.length} bytes is shorter than 8`);
  }
  assertByte("frame kind", frameKind);
  assertByte("seq", seq);
  if (!Number.isInteger(msgId) || msgId < 0 || msgId > 0xffff) {
    throw new CryptoUsageError(`msgId ${msgId} is not a 16-bit unsigned integer`);
  }
  const nonce = new Uint8Array(AEAD_NONCE_BYTES);
  nonce.set(salt.subarray(0, 8), 0);
  nonce[8] = frameKind;
  nonce[9] = (msgId >> 8) & 0xff;
  nonce[10] = msgId & 0xff;
  nonce[11] = seq;
  return nonce;
}

function assertByte(what: string, value: number): void {
  if (!Number.isInteger(value) || value < 0 || value > 0xff) {
    throw new CryptoUsageError(`${what} ${value} is not a single byte`);
  }
}

/** AES-256-GCM seal. Returns `ciphertext || tag` exactly as WebCrypto emits it. */
export async function sealBlock(
  key: CryptoKey,
  nonce: Uint8Array,
  aad: Uint8Array,
  plaintext: Uint8Array,
): Promise<Uint8Array> {
  assertNonce(nonce);
  if (plaintext.length === 0) {
    throw new CryptoUsageError("refusing to seal an empty block: a frame always carries a body");
  }
  const sealed = await cryptoApi().subtle.encrypt(
    {
      name: "AES-GCM",
      iv: asBufferSource(nonce),
      additionalData: asBufferSource(aad),
      tagLength: AEAD_TAG_BYTES * 8,
    },
    key,
    asBufferSource(plaintext),
  );
  return new Uint8Array(sealed);
}

/** Why a block did not open. Both cases mean "nothing decoded" (P5). */
export type OpenFailure = "shape" | "tag";

export type OpenOutcome = { ok: true; plaintext: Uint8Array } | { ok: false; reason: OpenFailure };

/**
 * AES-256-GCM open. A failed tag is an *outcome*, not an exception: the master
 * plan requires a tag failure to behave exactly like "nothing decoded yet", so
 * the caller must not be able to confuse it with a programming error (P5). Our
 * own misuse (a wrong-length nonce, a key of the wrong type) still throws, so it
 * cannot be mistaken for a tampered transmission.
 */
export async function openBlock(
  key: CryptoKey,
  nonce: Uint8Array,
  aad: Uint8Array,
  ciphertextAndTag: Uint8Array,
): Promise<OpenOutcome> {
  assertNonce(nonce);
  if (ciphertextAndTag.length < AEAD_TAG_BYTES) {
    return { ok: false, reason: "shape" };
  }
  try {
    const opened = await cryptoApi().subtle.decrypt(
      {
        name: "AES-GCM",
        iv: asBufferSource(nonce),
        additionalData: asBufferSource(aad),
        tagLength: AEAD_TAG_BYTES * 8,
      },
      key,
      asBufferSource(ciphertextAndTag),
    );
    return { ok: true, plaintext: new Uint8Array(opened) };
  } catch {
    return { ok: false, reason: "tag" };
  }
}

function assertNonce(nonce: Uint8Array): void {
  if (nonce.length !== AEAD_NONCE_BYTES) {
    throw new CryptoUsageError(
      `nonce of ${nonce.length} bytes is not the ${AEAD_NONCE_BYTES}-byte AES-GCM length`,
    );
  }
}

/**
 * The pairing handshake's per-session challenge: random bytes the *initiator*
 * invents and the responder must echo back. It exists because a recorded PAIR
 * frame from an earlier session with the same pairing code is otherwise a
 * permanent, replayable credential — the key check only proves "someone who
 * knows the code, ever", and a fresh receiver has no way to tell a recording
 * from a live peer (P2V finding 2).
 */
export const PAIR_CHALLENGE_BYTES = 8;

/** A fresh challenge. Never derived from the code, so it leaks nothing. */
export function generatePairChallenge(random: RandomSource = randomBytes): Uint8Array {
  const challenge = random(new Uint8Array(PAIR_CHALLENGE_BYTES));
  if (challenge.length !== PAIR_CHALLENGE_BYTES) {
    throw new CryptoUsageError(
      `the random source returned ${challenge.length} bytes, expected ${PAIR_CHALLENGE_BYTES}`,
    );
  }
  return Uint8Array.from(challenge);
}

function keyCheckMessage(salt: Uint8Array, challenge: Uint8Array, senderId: PeerId): Uint8Array {
  const message = new Uint8Array(KEY_CHECK_INFO.length + salt.length + challenge.length + 1);
  message.set(ascii(KEY_CHECK_INFO), 0);
  message.set(salt, KEY_CHECK_INFO.length);
  message.set(challenge, KEY_CHECK_INFO.length + salt.length);
  message[message.length - 1] = senderId;
  return message;
}

/**
 * The pairing handshake's key confirmation: a 16-byte truncated HMAC over the
 * salt, the session challenge and the sender's role. It proves "the same code,
 * answering a challenge nobody recorded" — never identity, and never over a
 * channel anyone in the room cannot also record (P7).
 */
export async function keyCheckTag(
  mac: CryptoKey,
  salt: Uint8Array,
  challenge: Uint8Array,
  senderId: PeerId,
): Promise<Uint8Array> {
  assertPeerId(senderId);
  if (salt.length !== SESSION_SALT_BYTES) {
    throw new CryptoUsageError(`salt of ${salt.length} bytes, expected ${SESSION_SALT_BYTES}`);
  }
  if (challenge.length !== PAIR_CHALLENGE_BYTES) {
    throw new CryptoUsageError(
      `challenge of ${challenge.length} bytes, expected ${PAIR_CHALLENGE_BYTES}`,
    );
  }
  const signature = await cryptoApi().subtle.sign(
    { name: "HMAC" },
    mac,
    asBufferSource(keyCheckMessage(salt, challenge, senderId)),
  );
  return new Uint8Array(signature).subarray(0, KEY_CHECK_BYTES);
}

/**
 * Verification of a received key confirmation. WebCrypto's HMAC `verify` wants
 * the *full* signature, and ours is truncated to 16 bytes, so the comparison is
 * done here with a branch-free XOR accumulate instead.
 */
export async function verifyKeyCheck(
  mac: CryptoKey,
  salt: Uint8Array,
  challenge: Uint8Array,
  senderId: PeerId,
  tag: Uint8Array,
): Promise<boolean> {
  assertPeerId(senderId);

  if (
    salt.length !== SESSION_SALT_BYTES ||
    challenge.length !== PAIR_CHALLENGE_BYTES ||
    tag.length !== KEY_CHECK_BYTES
  ) {
    return false;
  }
  const expected = await keyCheckTag(mac, salt, challenge, senderId);
  let difference = 0;
  for (let index = 0; index < KEY_CHECK_BYTES; index += 1) {
    difference |= (expected[index] ?? 0) ^ (tag[index] ?? 0);
  }
  return difference === 0;
}
