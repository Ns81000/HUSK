import { describe, expect, it } from "vitest";
import { isTerminal, transition, type RoomState } from "./room-machine";

describe("room state machine", () => {
  it("walks the happy path", () => {
    let state: RoomState = "idle";
    state = transition(state, { type: "CREATE" });
    expect(state).toBe("creating");
    state = transition(state, { type: "CONNECTED", peers: 1 });
    expect(state).toBe("waiting_for_peer");
    state = transition(state, { type: "PEER_JOINED" });
    expect(state).toBe("active");
  });

  it("enters the grace window when the last peer leaves", () => {
    const graced = transition("active", { type: "PEER_LEFT", peers: 1 });
    expect(graced).toBe("peer_disconnected_grace");
    expect(transition(graced, { type: "PEER_JOINED" })).toBe("active");
    expect(transition(graced, { type: "GRACE_EXPIRED", peers: 1 })).toBe("waiting_for_peer");
  });

  it("stays active when other peers remain", () => {
    expect(transition("active", { type: "PEER_LEFT", peers: 3 })).toBe("active");
  });

  it("handles a network drop and reconnect", () => {
    const dropped = transition("active", { type: "DISCONNECTED" });
    expect(dropped).toBe("reconnecting");
    expect(transition(dropped, { type: "RECONNECTED", peers: 2 })).toBe("active");
    expect(transition(dropped, { type: "RECONNECTED", peers: 1 })).toBe("waiting_for_peer");
  });

  it("resolves capacity rejection to a terminal state", () => {
    expect(transition("joining", { type: "ROOM_FULL" })).toBe("closed_full");
  });

  it("resolves expiry and rate limiting to terminal states", () => {
    expect(transition("active", { type: "EXPIRED" })).toBe("closed_expired");
    expect(transition("active", { type: "IDLE_CLOSED" })).toBe("closed_idle");
    expect(transition("joining", { type: "RATE_LIMITED" })).toBe("closed_rate_limited");
    expect(transition("joining", { type: "ROOM_NOT_FOUND" })).toBe("closed_not_found");
  });

  it("resolves an exhausted reconnect budget to a terminal disconnected state", () => {
    expect(transition("active", { type: "CONNECTION_LOST" })).toBe("closed_disconnected");
    expect(transition("reconnecting", { type: "CONNECTION_LOST" })).toBe("closed_disconnected");
  });

  it("never leaves a terminal state", () => {
    for (const state of [
      "closed_by_host",
      "closed_expired",
      "closed_idle",
      "closed_full",
      "closed_not_found",
      "closed_rate_limited",
      "closed_disconnected",
    ] as const) {
      expect(isTerminal(state)).toBe(true);
      expect(transition(state, { type: "PEER_JOINED" })).toBe(state);
      expect(transition(state, { type: "CONNECTED", peers: 2 })).toBe(state);
    }
  });

  it("ignores illegal transitions instead of inventing states", () => {
    expect(transition("idle", { type: "PEER_JOINED" })).toBe("idle");
    expect(transition("waiting_for_peer", { type: "CREATE" })).toBe("waiting_for_peer");
  });
});
