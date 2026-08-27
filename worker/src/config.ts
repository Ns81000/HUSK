/** Server-side counterpart of src/lib/husk/config.ts. No magic numbers inline. */

export const MAX_PARTICIPANTS = 10;

/** Hard maximum lifetime of a room, even while active. */
export const ROOM_MAX_LIFETIME_MS = 24 * 60 * 60 * 1000;

/** Idle timeout with zero connected participants. */
export const ROOM_IDLE_TIMEOUT_MS = 30 * 60 * 1000;

/** Alarm cadence used to evaluate expiry conditions. */
export const ALARM_INTERVAL_MS = 60 * 1000;

/** Join rate limiting. */
export const JOIN_WINDOW_SECONDS = 5 * 60;
export const JOIN_MAX_ATTEMPTS = 10;
export const JOIN_BACKOFF_BASE_SECONDS = 60;
export const JOIN_BACKOFF_MAX_SECONDS = 60 * 60;

/** File upload limits. */
export const MAX_FILE_BYTES = 100 * 1024 * 1024;
/** Signed upload/download tickets expire quickly and are single-use. */
export const TICKET_TTL_SECONDS = 300;
