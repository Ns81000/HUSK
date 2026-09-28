/**
 * Pairing machine tests — master plan Section 10.1 (class 12) and Section 10.2
 * P7. The transition table is asserted exhaustively, exactly like
 * `transport-machine.test.ts`, and the copy is checked to claim no more than the
 * handshake proves.
 */
import { describe, expect, it } from "vitest";
import {
  describePairingFailure,
  isPaired,
  PAIRING_CONFIRMATION_COPY,
  pairingTransition,
  roleToPeerId,
  type PairingEvent,
  type PairingState,
} from "./pairing";

const CODE = "ABCD2345";
const SALT = new Uint8Array(16).fill(7);

const STATES: readonly PairingState[] = [
  { kind: "idle" },
  { kind: "waiting-for-peer", code: CODE, role: "displayer" },
  { kind: "awaiting-confirmation", code: CODE, role: "enterer" },
  { kind: "paired", code: CODE, role: "displayer", peerSalt: SALT },
  { kind: "failed", code: CODE, role: "enterer", reason: "wrong-code" },
];

const EVENTS: readonly PairingEvent[] = [
  { type: "BEGIN_DISPLAY", code: CODE },
  { type: "BEGIN_ENTER", code: CODE },
  { type: "PEER_CONFIRMED", salt: SALT },
  { type: "PEER_REJECTED" },
  { type: "PEER_TIMEOUT" },
  { type: "CONFIRM_TIMEOUT" },
  { type: "CANCEL" },
];

/** A comparable label, so the table stays readable and exhaustive. */
function label(state: PairingState): string {
  switch (state.kind) {
    case "idle":
      return "idle";
    case "waiting-for-peer":
      return `waiting-for-peer:${state.role}`;
    case "awaiting-confirmation":
      return `awaiting-confirmation:${state.role}`;
    case "paired":
      return `paired:${state.role}:${state.peerSalt[0]}`;
    case "failed":
      return `failed:${state.role}:${state.reason}`;
    default:
      return "unknown";
  }
}

const TABLE: Record<PairingEvent["type"], readonly string[]> = {
  //  idle   waiting-for-peer:displayer        awaiting-confirmation:enterer   paired:displayer:7        failed:enterer:wrong-code
  BEGIN_DISPLAY: [
    "waiting-for-peer:displayer",
    "waiting-for-peer:displayer",
    "awaiting-confirmation:enterer",
    "paired:displayer:7",
    "waiting-for-peer:displayer",
  ],
  BEGIN_ENTER: [
    "awaiting-confirmation:enterer",
    "waiting-for-peer:displayer",
    "awaiting-confirmation:enterer",
    "paired:displayer:7",
    "awaiting-confirmation:enterer",
  ],
  PEER_CONFIRMED: [
    "idle",
    "paired:displayer:7",
    "paired:enterer:7",
    "paired:displayer:7",
    "failed:enterer:wrong-code",
  ],
  PEER_REJECTED: [
    "idle",
    "failed:displayer:wrong-code",
    "failed:enterer:wrong-code",
    "paired:displayer:7",
    "failed:enterer:wrong-code",
  ],
  PEER_TIMEOUT: [
    "idle",
    "failed:displayer:no-peer",
    "awaiting-confirmation:enterer",
    "paired:displayer:7",
    "failed:enterer:wrong-code",
  ],
  CONFIRM_TIMEOUT: [
    "idle",
    "waiting-for-peer:displayer",
    "failed:enterer:no-confirmation",
    "paired:displayer:7",
    "failed:enterer:wrong-code",
  ],
  CANCEL: ["idle", "idle", "idle", "idle", "idle"],
};

describe("pairing machine", () => {
  it("maps roles to peer ids", () => {
    expect(roleToPeerId("displayer")).toBe(0);
    expect(roleToPeerId("enterer")).toBe(1);
  });

  it("matches the full transition table for every state x event pair", () => {
    for (const event of EVENTS) {
      STATES.forEach((state, index) => {
        const expected = TABLE[event.type][index];
        expect(label(pairingTransition(state, event)), `${state.kind} + ${event.type}`).toBe(
          expected,
        );
      });
    }
  });

  it("walks both sides of the handshake to the same key check", () => {
    const displayer = pairingTransition({ kind: "idle" }, { type: "BEGIN_DISPLAY", code: CODE });
    const enterer = pairingTransition({ kind: "idle" }, { type: "BEGIN_ENTER", code: CODE });
    expect(displayer.kind).toBe("waiting-for-peer");
    expect(enterer.kind).toBe("awaiting-confirmation");
    // The enterer hears the displayer's answer; the displayer hears the enterer.
    const entererPaired = pairingTransition(enterer, { type: "PEER_CONFIRMED", salt: SALT });
    const displayerPaired = pairingTransition(displayer, { type: "PEER_CONFIRMED", salt: SALT });
    expect(isPaired(entererPaired)).toBe(true);
    expect(isPaired(displayerPaired)).toBe(true);
  });

  it("cannot be moved by an event that arrives at the wrong moment", () => {
    const paired: PairingState = { kind: "paired", code: CODE, role: "displayer", peerSalt: SALT };
    // A replayed PAIR frame after pairing must not re-open or un-pair anything.
    expect(pairingTransition(paired, { type: "PEER_CONFIRMED", salt: SALT })).toBe(paired);
    expect(pairingTransition(paired, { type: "PEER_REJECTED" })).toBe(paired);
    expect(pairingTransition(paired, { type: "PEER_TIMEOUT" })).toBe(paired);
    expect(pairingTransition(paired, { type: "CONFIRM_TIMEOUT" })).toBe(paired);
    // The wrong timeout for the current side is a no-op.
    expect(
      pairingTransition(
        { kind: "waiting-for-peer", code: CODE, role: "displayer" },
        {
          type: "CONFIRM_TIMEOUT",
        },
      ).kind,
    ).toBe("waiting-for-peer");
    expect(
      pairingTransition(
        { kind: "awaiting-confirmation", code: CODE, role: "enterer" },
        {
          type: "PEER_TIMEOUT",
        },
      ).kind,
    ).toBe("awaiting-confirmation");
  });

  it("gives every failure its own sentence, and claims no identity", () => {
    const wrong = describePairingFailure("wrong-code");
    const none = describePairingFailure("no-peer");
    const confirm = describePairingFailure("no-confirmation");
    expect(new Set([wrong, none, confirm]).size).toBe(3);
    expect(wrong).toContain("different pairing code");
    expect(PAIRING_CONFIRMATION_COPY).toContain("not who is holding the other device");
  });
});
