/** Server-side counterpart of src/lib/husk/config.ts. No magic numbers inline. */

export const MAX_PARTICIPANTS = 10;

/** Hard maximum lifetime of a room, even while active. */
export const ROOM_MAX_LIFETIME_MS = 24 * 60 * 60 * 1000;

/** Idle timeout with zero connected participants. */
export const ROOM_IDLE_TIMEOUT_MS = 30 * 60 * 1000;

/** Alarm cadence used to evaluate expiry conditions. */
export const ALARM_INTERVAL_MS = 60 * 1000;

/** The single PIN shape accepted by every room route. */
export const PIN_PATTERN = /^[1-9][0-9]{5}$/;

/** Join rate limiting. */
export const JOIN_WINDOW_SECONDS = 5 * 60;
export const JOIN_MAX_ATTEMPTS = 10;
export const JOIN_BACKOFF_BASE_SECONDS = 60;
export const JOIN_BACKOFF_MAX_SECONDS = 60 * 60;

/**
 * File transfer limits. One file is stored as ceil(size / FILE_CHUNK_BYTES)
 * rows in the room's SQLite Durable Object storage; each row (key + value)
 * must stay under the 2 MB per-row ceiling, which 1 MiB chunks clear with
 * room to spare.
 */
export const MAX_FILE_BYTES = 25 * 1024 * 1024;
export const MAX_ROOM_FILE_BYTES = 100 * 1024 * 1024;
export const FILE_CHUNK_BYTES = 1024 * 1024;

/** Storage key shapes for file rows inside the room Durable Object. */
export const FILE_ROW_PREFIX = "file:";
export const FILE_META_PREFIX = "file-meta:";
export const FILE_BYTES_USED_KEY = "file-bytes-used";

/** Persisted room existence/lifecycle state; survives isolate eviction. */
export const ROOM_STATE_KEY = "room-state";

/** Chunk upload tickets expire quickly; download tickets live until room expiry. */
export const TICKET_TTL_SECONDS = 300;

/**
 * AES-GCM appends a 128-bit authentication tag to each sealed chunk, so the
 * ciphertext of a full 1 MiB plaintext chunk is 16 bytes larger than the
 * plaintext. The per-PUT body cap must allow for it.
 */
export const CIPHER_OVERHEAD_BYTES = 16;

/** One-time join token that a successful /room/join mints for the socket route. */
export const JOIN_TOKEN_TTL_SECONDS = 60;
