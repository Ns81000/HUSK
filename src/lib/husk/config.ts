/**
 * Shared configuration constants for Husk.
 *
 * These values are also mirrored by the Cloudflare Worker (worker/src/config.ts).
 * Keep the two files in sync; both are intentionally free of magic numbers at
 * call sites.
 */

export const PIN_LENGTH = 6;
export const MAX_PARTICIPANTS = 10;

/** Grace window before a peer disconnect becomes user-visible. */
export const PEER_GRACE_MS = 8_000;

/** Reconnect backoff bounds for the client WebSocket. */
export const RECONNECT_MIN_MS = 1_000;
export const RECONNECT_MAX_MS = 15_000;
/** Failed reconnect attempts before connecting is given up for good. */
export const RECONNECT_MAX_ATTEMPTS = 10;
/**
 * Consecutive socket handshakes that fail without opening. The join endpoint
 * keeps minting tokens, so a token that never upgrades means the room is gone.
 */
export const RECONNECT_HANDSHAKE_FAILURES = 3;
/**
 * A connection that stayed open at least this long resets the reconnect
 * budget; anything shorter counts as another failed attempt, so a flapping
 * link cannot retry forever.
 */
export const RECONNECT_STABLE_MS = 10_000;

/** Time a sent message waits for the server ack before showing as failed. */
export const ACK_TIMEOUT_MS = 10_000;
/** Maximum frames buffered while disconnected; the oldest is dropped. */
export const MAX_OUTBOX_FRAMES = 50;

/**
 * Files are encrypted and uploaded in fixed 1 MiB chunks; each chunk is one
 * storage row in the room's Durable Object. Mirrors worker/src/config.ts.
 */
export const FILE_CHUNK_BYTES = 1 * 1024 * 1024;
export const MAX_FILE_BYTES = 25 * 1024 * 1024;
export const MAX_ROOM_FILE_BYTES = 100 * 1024 * 1024;

/** Room key length in bytes (AES-256). */
export const ROOM_KEY_BYTES = 32;
/** AES-GCM IV length in bytes. */
export const IV_BYTES = 12;

export const WORKER_URL: string = (import.meta.env["VITE_WORKER_URL"] ?? "").replace(/\/$/, "");
