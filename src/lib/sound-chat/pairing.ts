/**
 * Sound Chat pairing: the small explicit state machine behind the handshake,
 * plus the honest copy for every way it can fail.
 *
 * The flow (master plan Section 7, Phase 2), one acoustic frame each way:
 *
 * 1. the **displayer** shows a generated code and listens;
 * 2. the **enterer** types the code; if it validates it puts its own PAIR frame
 *    on the air (its random session salt plus a key-confirmation HMAC) and then
 *    listens;
 * 3. the displayer verifies that HMAC — a *key check*, never an identity check
 *    (P7) — learns the enterer's salt, and answers with its own PAIR frame;
 * 4. the enterer verifies the answer. Both sides are now `paired` and hold a
 *    nonce salt per direction.
 *
 * Pairing is deliberately *not* a transport state: the transport machine still
 * describes what the radio is doing (listening, transmitting), while this machine
 * describes where the handshake is. Both are explicit and table-tested; neither
 * is inferred from a scattered boolean. The pairing code itself never goes on the
 * air (P7) — only the salt and the HMAC over it do.
 */

import type { PeerId } from "./crypto";

export type PairingRole = "displayer" | "enterer";

/** The displayer is peer 0; the enterer is peer 1. Roles are in every frame. */
export function roleToPeerId(role: PairingRole): PeerId {
  return role === "displayer" ? 0 : 1;
}

export type PairingFailureReason = "wrong-code" | "no-peer" | "no-confirmation";

export type PairingState =
  | { kind: "idle" }
  | { kind: "waiting-for-peer"; code: string; role: PairingRole }
  | { kind: "awaiting-confirmation"; code: string; role: PairingRole }
  | { kind: "paired"; code: string; role: PairingRole; peerSalt: Uint8Array }
  | { kind: "failed"; code: string; role: PairingRole; reason: PairingFailureReason };

export type PairingEvent =
  | { type: "BEGIN_DISPLAY"; code: string }
  | { type: "BEGIN_ENTER"; code: string }
  /** The peer's PAIR frame passed its key check. */
  | { type: "PEER_CONFIRMED"; salt: Uint8Array }
  /** The peer's PAIR frame failed its key check: a different code. */
  | { type: "PEER_REJECTED" }
  /** The displayer waited and heard nothing. */
  | { type: "PEER_TIMEOUT" }
  /** The enterer got no answer to its own PAIR frame. */
  | { type: "CONFIRM_TIMEOUT" }
  | { type: "CANCEL" };

/**
 * Every transition, exhaustively. A stray event in a state that cannot act on it
 * is a no-op, so nothing about pairing can be moved by a frame that arrives at
 * the wrong moment — including a *replayed* PAIR frame after pairing, which
 * deliberately cannot move the nonce space (see `FrameCodec.adoptPeerSalt`).
 */
export function pairingTransition(state: PairingState, event: PairingEvent): PairingState {
  switch (event.type) {
    case "BEGIN_DISPLAY":
      return state.kind === "idle" || state.kind === "failed"
        ? { kind: "waiting-for-peer", code: event.code, role: "displayer" }
        : state;
    case "BEGIN_ENTER":
      return state.kind === "idle" || state.kind === "failed"
        ? { kind: "awaiting-confirmation", code: event.code, role: "enterer" }
        : state;
    case "PEER_CONFIRMED":
      return state.kind === "waiting-for-peer" || state.kind === "awaiting-confirmation"
        ? { kind: "paired", code: state.code, role: state.role, peerSalt: event.salt }
        : state;
    case "PEER_REJECTED":
      return state.kind === "waiting-for-peer" || state.kind === "awaiting-confirmation"
        ? { kind: "failed", code: state.code, role: state.role, reason: "wrong-code" }
        : state;
    case "PEER_TIMEOUT":
      return state.kind === "waiting-for-peer"
        ? { kind: "failed", code: state.code, role: state.role, reason: "no-peer" }
        : state;
    case "CONFIRM_TIMEOUT":
      return state.kind === "awaiting-confirmation"
        ? { kind: "failed", code: state.code, role: state.role, reason: "no-confirmation" }
        : state;
    case "CANCEL":
      return state.kind === "idle" ? state : { kind: "idle" };
    default:
      return state;
  }
}

export function isPaired(state: PairingState): boolean {
  return state.kind === "paired";
}

/**
 * What the user is told. Every failure mode gets its own sentence, and none of
 * them claims more than the handshake actually proved (master plan constraint 5
 * and Section 10.2 P7): a confirmation says "this device and that one share the
 * code", never "that is who you think it is".
 */
export function describePairingFailure(reason: PairingFailureReason): string {
  switch (reason) {
    case "wrong-code":
      return "A device answered, but it is using a different pairing code. Check the code and try again.";
    case "no-peer":
      // Same honesty rule as `no-confirmation`, applied to the one sentence that
      // had been missed: "no paired device was heard" is the fact, but "make sure
      // the other device is listening" names a cause nothing here can observe —
      // and it is wrong precisely when *this* device's own input is dead.
      return "No paired device was heard. Check that both devices are on and in the same room, then start again.";
    case "no-confirmation":
      // No distance claim and one action. Nothing in Sound Chat measures range:
      // the wait is a wall-clock timer, so the only fact it can report is that
      // nothing was heard in time — which is what a wrong code, a device that
      // never started, and a device too far away all look like.
      return "The other device did not answer. Check the code on both devices, then start again.";
    default:
      return "Pairing did not complete.";
  }
}

/** What a successful pairing proves — and, on purpose, what it does not. */
export const PAIRING_CONFIRMATION_COPY =
  "Paired: the two devices share the same code and can hear each other right now. This confirms the " +
  "code, not who is holding the other device.";
