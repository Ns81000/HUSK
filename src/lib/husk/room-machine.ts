/**
 * Explicit room state machine.
 *
 * Every transition the UI can make is enumerated here, so no screen state is
 * inferred from scattered booleans. Illegal transitions return the current
 * state unchanged, which makes the machine safe to drive from network events.
 */

export type RoomState =
  | "idle"
  | "creating"
  | "joining"
  | "waiting_for_peer"
  | "active"
  | "peer_disconnected_grace"
  | "reconnecting"
  | "closed_by_host"
  | "closed_expired"
  | "closed_full"
  | "closed_not_found"
  | "closed_rate_limited";

export type RoomEvent =
  | { type: "CREATE" }
  | { type: "JOIN" }
  | { type: "CONNECTED"; peers: number }
  | { type: "PEER_JOINED" }
  | { type: "PEER_LEFT"; peers: number }
  | { type: "GRACE_EXPIRED"; peers: number }
  | { type: "DISCONNECTED" }
  | { type: "RECONNECTED"; peers: number }
  | { type: "ROOM_FULL" }
  | { type: "ROOM_NOT_FOUND" }
  | { type: "RATE_LIMITED" }
  | { type: "EXPIRED" }
  | { type: "LEAVE" };

export const TERMINAL_STATES: readonly RoomState[] = [
  "closed_by_host",
  "closed_expired",
  "closed_full",
  "closed_not_found",
  "closed_rate_limited",
];

export function isTerminal(state: RoomState): boolean {
  return TERMINAL_STATES.includes(state);
}

function connectedState(peers: number): RoomState {
  return peers > 1 ? "active" : "waiting_for_peer";
}

export function transition(state: RoomState, event: RoomEvent): RoomState {
  if (isTerminal(state)) {
    return state;
  }

  switch (event.type) {
    case "CREATE":
      return state === "idle" ? "creating" : state;
    case "JOIN":
      return state === "idle" ? "joining" : state;
    case "CONNECTED":
      return state === "creating" || state === "joining"
        ? connectedState(event.peers)
        : state;
    case "PEER_JOINED":
      return state === "waiting_for_peer" ||
        state === "peer_disconnected_grace" ||
        state === "active"
        ? "active"
        : state;
    case "PEER_LEFT":
      if (state !== "active") {
        return state;
      }
      return event.peers > 1 ? "active" : "peer_disconnected_grace";
    case "GRACE_EXPIRED":
      return state === "peer_disconnected_grace"
        ? connectedState(event.peers)
        : state;
    case "DISCONNECTED":
      return "reconnecting";
    case "RECONNECTED":
      return state === "reconnecting" ? connectedState(event.peers) : state;
    case "ROOM_FULL":
      return "closed_full";
    case "ROOM_NOT_FOUND":
      return "closed_not_found";
    case "RATE_LIMITED":
      return "closed_rate_limited";
    case "EXPIRED":
      return "closed_expired";
    case "LEAVE":
      return "closed_by_host";
    default:
      return state;
  }
}
