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

const SERVER_TAGS = ["welcome", "relay", "presence", "ack", "pong", "closed", "error"] as const;

/**
 * Boundary parser for frames arriving from the relay. Returns null for
 * anything that is not a recognised server frame, so callers never branch on
 * raw representations.
 */
export function parseServerMessage(raw: string): ServerMessage | null {
  let decoded: { t?: string } | null = null;
  try {
    // SAFETY: the shape is validated on the next line before any use.
    decoded = JSON.parse(raw) as { t?: string };
  } catch {
    return null;
  }
  // SAFETY: the assertion only narrows the string for the membership check
  // below; a value outside the tag list is rejected on the next line.
  if (decoded === null || !SERVER_TAGS.includes(decoded.t as (typeof SERVER_TAGS)[number])) {
    return null;
  }
  // SAFETY: the discriminant tag was checked against the known frame tags.
  return decoded as ServerMessage;
}
