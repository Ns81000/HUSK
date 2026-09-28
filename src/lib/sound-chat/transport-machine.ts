/**
 * Explicit Sound Chat transport state machine.
 *
 * Same discipline as `src/lib/husk/room-machine.ts`: every transition the
 * driver can make is enumerated here, so no transport state is inferred from
 * scattered booleans. Illegal transitions return the current state unchanged,
 * which makes the machine safe to drive from audio callbacks and timers.
 *
 * Phase 1 defined the states; Phase 2 added the four the protocol actually needs
 * and nothing more: `hidden_hold` (a send held because the tab went hidden), the
 * un-acked transmit completion (a PAIR frame is fire-and-forget),
 * `COLLISION_DETECTED`, and `HEARD_UNREADABLE` (a block the codec decoded but
 * this pairing cannot read — Section 10.2 P6).
 *
 * State meanings:
 * - `idle` — nothing started; no AudioContext, no codec.
 * - `listening` — Rx feed live and decoding; ready to transmit. The Rx path
 *   stays in this shape for the whole session (a receiver that starts
 *   mid-transmission never decodes that transmission).
 * - `transmitting` — playing blocks; the Rx mic feed is paused for the exact
 *   transmit window plus a tail, so we never decode ourselves.
 * - `awaiting_turn` — the peer is transmitting; our own send waits.
 * - `awaiting_ack` — our block is out; waiting for the peer's acknowledgement.
 * - `backoff` — an ACK timed out or a collision happened; wait, then retry.
 * - `hidden_hold` — a send is held because the page is hidden. Only `VISIBLE`
 *   leaves it, and `TRANSMIT_BEGIN` is refused here, so the machine itself
 *   cannot put audio on the air while hidden (Section 10.2 P11). The Rx feed
 *   keeps running while hidden: whole capture chunks are never torn.
 * - `error` — recoverable failure (microphone denied, wrong device rate, ...);
 *   the user can fix the cause and START again.
 * - `module_error` — the codec module died; unrecoverable for the page
 *   session. Only RESTART (full teardown, then START) leaves this state.
 */

export type TransportState =
  | "idle"
  | "listening"
  | "transmitting"
  | "awaiting_turn"
  | "awaiting_ack"
  | "backoff"
  | "hidden_hold"
  | "error"
  | "module_error";

export type TransportEvent =
  | { type: "START" }
  | { type: "STOP" }
  | { type: "PEER_STARTED_TRANSMITTING" }
  | { type: "CHANNEL_QUIET" }
  | { type: "TRANSMIT_BEGIN" }
  | { type: "TRANSMIT_DONE" }
  /** A transmission nobody acknowledges (the pairing frames). */
  | { type: "TRANSMIT_DONE_UNACKED" }
  | { type: "ACK_RECEIVED" }
  | { type: "ACK_TIMEOUT" }
  | { type: "BACKOFF_EXPIRED" }
  | { type: "MESSAGE_DECODED" }
  /** The codec produced a block, but it is not ours to read. */
  | { type: "HEARD_UNREADABLE" }
  | { type: "COLLISION_DETECTED" }
  | { type: "HIDDEN" }
  | { type: "VISIBLE" }
  | { type: "MODULE_DIED" }
  | { type: "RECOVERABLE_ERROR" }
  | { type: "RESTART" };

const ACTIVE_STATES: readonly TransportState[] = [
  "listening",
  "transmitting",
  "awaiting_turn",
  "awaiting_ack",
  "backoff",
  "hidden_hold",
];

/** States in which a send can be started, resumed, or is already under way. */
const SEND_STATES: readonly TransportState[] = [
  "listening",
  "transmitting",
  "awaiting_turn",
  "awaiting_ack",
  "backoff",
  "hidden_hold",
];

export function isActive(state: TransportState): boolean {
  return ACTIVE_STATES.includes(state);
}

export function transition(state: TransportState, event: TransportEvent): TransportState {
  switch (event.type) {
    case "START":
      return state === "idle" || state === "error" ? "listening" : state;
    case "STOP":
      return state === "module_error" || state === "idle" ? state : "idle";
    case "PEER_STARTED_TRANSMITTING":
      // While awaiting our own ACK, a peer transmission means the peer did not
      // hear us: the collision this medium can never report directly.
      if (state === "listening") return "awaiting_turn";
      if (state === "awaiting_ack") return "backoff";
      return state;
    case "CHANNEL_QUIET":
      return state === "awaiting_turn" ? "listening" : state;
    case "TRANSMIT_BEGIN":
      // The only way to start audio: from listening or backoff. It is refused in
      // hidden_hold by omission, which is the machine-level "never transmit while
      // hidden" guard (Section 10.2 P11).
      return state === "listening" || state === "backoff" ? "transmitting" : state;
    case "TRANSMIT_DONE":
      return state === "transmitting" ? "awaiting_ack" : state;
    case "TRANSMIT_DONE_UNACKED":
      return state === "transmitting" ? "listening" : state;
    case "ACK_RECEIVED":
      return state === "awaiting_ack" ? "listening" : state;
    case "ACK_TIMEOUT":
      return state === "awaiting_ack" ? "backoff" : state;
    case "BACKOFF_EXPIRED":
      return state === "backoff" ? "listening" : state;
    case "MESSAGE_DECODED":
    case "HEARD_UNREADABLE":
      // Diagnostics, not transitions: the driver uses them for UI copy and to
      // extend its own ACK deadline, never to infer transport state.
      return state;
    case "COLLISION_DETECTED":
      return SEND_STATES.includes(state) && state !== "hidden_hold" ? "backoff" : state;
    case "HIDDEN":
      return SEND_STATES.includes(state) ? "hidden_hold" : state;
    case "VISIBLE":
      return state === "hidden_hold" ? "listening" : state;
    case "MODULE_DIED":
      return state === "module_error" ? state : "module_error";
    case "RECOVERABLE_ERROR":
      return state === "module_error" || state === "idle" ? state : "error";
    case "RESTART":
      return state === "module_error" || state === "error" ? "idle" : state;
    default:
      return state;
  }
}
