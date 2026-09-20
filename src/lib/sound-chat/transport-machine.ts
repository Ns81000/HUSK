/**
 * Explicit Sound Chat transport state machine.
 *
 * Same discipline as `src/lib/husk/room-machine.ts`: every transition the
 * driver can make is enumerated here, so no transport state is inferred from
 * scattered booleans. Illegal transitions return the current state unchanged,
 * which makes the machine safe to drive from audio callbacks and timers.
 *
 * Phase 1 defines and tests the states; the Phase 2 protocol is what will
 * actually emit PEER_STARTED_TRANSMITTING / ACK_* / CHANNEL_QUIET events.
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
  | "error"
  | "module_error";

export type TransportEvent =
  | { type: "START" }
  | { type: "STOP" }
  | { type: "PEER_STARTED_TRANSMITTING" }
  | { type: "CHANNEL_QUIET" }
  | { type: "TRANSMIT_BEGIN" }
  | { type: "TRANSMIT_DONE" }
  | { type: "ACK_RECEIVED" }
  | { type: "ACK_TIMEOUT" }
  | { type: "BACKOFF_EXPIRED" }
  | { type: "MESSAGE_DECODED" }
  | { type: "MODULE_DIED" }
  | { type: "RECOVERABLE_ERROR" }
  | { type: "RESTART" };

const ACTIVE_STATES: readonly TransportState[] = [
  "listening",
  "transmitting",
  "awaiting_turn",
  "awaiting_ack",
  "backoff",
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
      return state === "listening" ? "awaiting_turn" : state;
    case "CHANNEL_QUIET":
      return state === "awaiting_turn" ? "listening" : state;
    case "TRANSMIT_BEGIN":
      return state === "listening" || state === "backoff" ? "transmitting" : state;
    case "TRANSMIT_DONE":
      return state === "transmitting" ? "awaiting_ack" : state;
    case "ACK_RECEIVED":
      return state === "awaiting_ack" ? "listening" : state;
    case "ACK_TIMEOUT":
      return state === "awaiting_ack" ? "backoff" : state;
    case "BACKOFF_EXPIRED":
      return state === "backoff" ? "listening" : state;
    case "MESSAGE_DECODED":
      return state;
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
