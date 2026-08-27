/**
 * Wire protocol shared by the browser client and the room Durable Object.
 *
 * Everything the server sees is either routing metadata or opaque ciphertext.
 * No field in this file ever carries plaintext content or the room key.
 */

export type SealedEnvelope = {
  readonly iv: string;
  readonly ct: string;
};

export type ClientMessage =
  | { readonly t: "send"; readonly localId: string; readonly payload: SealedEnvelope }
  | { readonly t: "cancel"; readonly fileId: string }
  | { readonly t: "ping" };

export type Participant = {
  readonly id: string;
  readonly joinedAt: number;
};

export type ServerMessage =
  | {
      readonly t: "welcome";
      readonly you: string;
      readonly participants: readonly Participant[];
      readonly seq: number;
      readonly expiresAt: number;
    }
  | {
      readonly t: "relay";
      readonly seq: number;
      readonly senderId: string;
      readonly localId: string;
      readonly ts: number;
      readonly payload: SealedEnvelope;
    }
  | {
      readonly t: "presence";
      readonly event: "join" | "leave";
      readonly who: string;
      readonly participants: readonly Participant[];
    }
  | { readonly t: "ack"; readonly localId: string; readonly seq: number }
  | { readonly t: "pong" }
  | { readonly t: "closed"; readonly reason: RoomCloseReason }
  | { readonly t: "error"; readonly code: RoomErrorCode };

export type RoomCloseReason = "host_closed" | "expired" | "idle";
export type RoomErrorCode = "room_full" | "room_not_found" | "rate_limited" | "bad_request";

/** Plaintext body of a sealed envelope. Only ever exists inside a browser. */
export type SealedBody =
  | {
      readonly kind: "text";
      readonly text: string;
      readonly sentAt: number;
    }
  | {
      readonly kind: "file";
      readonly name: string;
      readonly size: number;
      readonly mime: string;
      /** Server-side id of the stored ciphertext. */
      readonly fileId: string;
      readonly chunks: number;
      readonly ivs: readonly string[];
      readonly lengths: readonly number[];
      /**
       * Signed download capability for the stored ciphertext. It travels only
       * inside this encrypted body and expires when the room's storage does.
       */
      readonly exp: number;
      readonly sig: string;
      readonly sentAt: number;
    };

const CLOSE_REASONS = ["host_closed", "expired", "idle"] as const;
const ERROR_CODES = ["room_full", "room_not_found", "rate_limited", "bad_request"] as const;

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null;
}

function parseParticipants(value: unknown): Participant[] | null {
  if (!Array.isArray(value)) {
    return null;
  }
  const participants: Participant[] = [];
  for (const entry of value) {
    if (!isRecord(entry)) {
      return null;
    }
    const id = entry["id"];
    const joinedAt = entry["joinedAt"];
    if (typeof id !== "string" || typeof joinedAt !== "number") {
      return null;
    }
    participants.push({ id, joinedAt });
  }
  return participants;
}

function parseEnvelope(value: unknown): SealedEnvelope | null {
  if (!isRecord(value)) {
    return null;
  }
  const iv = value["iv"];
  const ct = value["ct"];
  if (typeof iv !== "string" || typeof ct !== "string") {
    return null;
  }
  return { iv, ct };
}

/**
 * Boundary parser for frames arriving from the relay. Every field of every tag
 * is validated; any shape mismatch — including a valid tag with missing or
 * wrongly-typed fields — returns null, so callers never branch on raw
 * representations or half-typed frames.
 */
export function parseServerMessage(raw: string): ServerMessage | null {
  let decoded: unknown;
  try {
    decoded = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isRecord(decoded)) {
    return null;
  }
  switch (decoded["t"]) {
    case "welcome": {
      const you = decoded["you"];
      const seq = decoded["seq"];
      const expiresAt = decoded["expiresAt"];
      if (typeof you !== "string" || typeof seq !== "number" || typeof expiresAt !== "number") {
        return null;
      }
      const participants = parseParticipants(decoded["participants"]);
      if (participants === null) {
        return null;
      }
      return { t: "welcome", you, participants, seq, expiresAt };
    }
    case "relay": {
      const seq = decoded["seq"];
      const senderId = decoded["senderId"];
      const localId = decoded["localId"];
      const ts = decoded["ts"];
      if (
        typeof seq !== "number" ||
        typeof senderId !== "string" ||
        typeof localId !== "string" ||
        typeof ts !== "number"
      ) {
        return null;
      }
      const payload = parseEnvelope(decoded["payload"]);
      if (payload === null) {
        return null;
      }
      return { t: "relay", seq, senderId, localId, ts, payload };
    }
    case "presence": {
      const event = decoded["event"];
      const who = decoded["who"];
      if ((event !== "join" && event !== "leave") || typeof who !== "string") {
        return null;
      }
      const participants = parseParticipants(decoded["participants"]);
      if (participants === null) {
        return null;
      }
      return { t: "presence", event, who, participants };
    }
    case "ack": {
      const localId = decoded["localId"];
      const seq = decoded["seq"];
      if (typeof localId !== "string" || typeof seq !== "number") {
        return null;
      }
      return { t: "ack", localId, seq };
    }
    case "pong":
      return { t: "pong" };
    case "closed": {
      const reason = decoded["reason"];
      if (!CLOSE_REASONS.includes(reason as (typeof CLOSE_REASONS)[number])) {
        return null;
      }
      return { t: "closed", reason: reason as RoomCloseReason };
    }
    case "error": {
      const code = decoded["code"];
      if (!ERROR_CODES.includes(code as (typeof ERROR_CODES)[number])) {
        return null;
      }
      return { t: "error", code: code as RoomErrorCode };
    }
    default:
      return null;
  }
}
