import { describe, expect, it } from "vitest";
import {
  isActive,
  transition,
  type TransportEvent,
  type TransportState,
} from "./transport-machine";

const STATES: readonly TransportState[] = [
  "idle",
  "listening",
  "transmitting",
  "awaiting_turn",
  "awaiting_ack",
  "backoff",
  "error",
  "module_error",
];

const EVENTS: readonly TransportEvent[] = [
  { type: "START" },
  { type: "STOP" },
  { type: "PEER_STARTED_TRANSMITTING" },
  { type: "CHANNEL_QUIET" },
  { type: "TRANSMIT_BEGIN" },
  { type: "TRANSMIT_DONE" },
  { type: "ACK_RECEIVED" },
  { type: "ACK_TIMEOUT" },
  { type: "BACKOFF_EXPIRED" },
  { type: "MESSAGE_DECODED" },
  { type: "MODULE_DIED" },
  { type: "RECOVERABLE_ERROR" },
  { type: "RESTART" },
];

/**
 * The complete transition table, in `STATES` order for every event. Anything
 * the machine does that is not in this table is a bug; this is asserted
 * exhaustively below.
 */
const TABLE: Record<TransportEvent["type"], readonly TransportState[]> = {
  //             idle        listening     transmitting  awaiting_turn awaiting_ack  backoff       error       module_error
  START: [
    "listening",
    "listening",
    "transmitting",
    "awaiting_turn",
    "awaiting_ack",
    "backoff",
    "listening",
    "module_error",
  ],
  STOP: ["idle", "idle", "idle", "idle", "idle", "idle", "idle", "module_error"],
  PEER_STARTED_TRANSMITTING: [
    "idle",
    "awaiting_turn",
    "transmitting",
    "awaiting_turn",
    "awaiting_ack",
    "backoff",
    "error",
    "module_error",
  ],
  CHANNEL_QUIET: [
    "idle",
    "listening",
    "transmitting",
    "listening",
    "awaiting_ack",
    "backoff",
    "error",
    "module_error",
  ],
  TRANSMIT_BEGIN: [
    "idle",
    "transmitting",
    "transmitting",
    "awaiting_turn",
    "awaiting_ack",
    "transmitting",
    "error",
    "module_error",
  ],
  TRANSMIT_DONE: [
    "idle",
    "listening",
    "awaiting_ack",
    "awaiting_turn",
    "awaiting_ack",
    "backoff",
    "error",
    "module_error",
  ],
  ACK_RECEIVED: [
    "idle",
    "listening",
    "transmitting",
    "awaiting_turn",
    "listening",
    "backoff",
    "error",
    "module_error",
  ],
  ACK_TIMEOUT: [
    "idle",
    "listening",
    "transmitting",
    "awaiting_turn",
    "backoff",
    "backoff",
    "error",
    "module_error",
  ],
  BACKOFF_EXPIRED: [
    "idle",
    "listening",
    "transmitting",
    "awaiting_turn",
    "awaiting_ack",
    "listening",
    "error",
    "module_error",
  ],
  MESSAGE_DECODED: [
    "idle",
    "listening",
    "transmitting",
    "awaiting_turn",
    "awaiting_ack",
    "backoff",
    "error",
    "module_error",
  ],
  MODULE_DIED: STATES.map(() => "module_error"),
  RECOVERABLE_ERROR: ["idle", "error", "error", "error", "error", "error", "error", "module_error"],
  RESTART: [
    "idle",
    "listening",
    "transmitting",
    "awaiting_turn",
    "awaiting_ack",
    "backoff",
    "idle",
    "idle",
  ],
};

describe("transport state machine", () => {
  it("walks the happy send path", () => {
    let state: TransportState = "idle";
    state = transition(state, { type: "START" });
    expect(state).toBe("listening");
    state = transition(state, { type: "TRANSMIT_BEGIN" });
    expect(state).toBe("transmitting");
    state = transition(state, { type: "TRANSMIT_DONE" });
    expect(state).toBe("awaiting_ack");
    state = transition(state, { type: "ACK_RECEIVED" });
    expect(state).toBe("listening");
  });

  it("yields the channel when the peer transmits first", () => {
    const yielded = transition("listening", { type: "PEER_STARTED_TRANSMITTING" });
    expect(yielded).toBe("awaiting_turn");
    expect(transition(yielded, { type: "CHANNEL_QUIET" })).toBe("listening");
  });

  it("backs off after a missed acknowledgement and retries", () => {
    let state = transition("awaiting_ack", { type: "ACK_TIMEOUT" });
    expect(state).toBe("backoff");
    state = transition(state, { type: "BACKOFF_EXPIRED" });
    expect(state).toBe("listening");
    expect(transition(state, { type: "TRANSMIT_BEGIN" })).toBe("transmitting");
  });

  it("treats a decoded message as activity, not a transition", () => {
    expect(transition("listening", { type: "MESSAGE_DECODED" })).toBe("listening");
  });

  it("treats module death as reachable from every state and unrecoverable without RESTART", () => {
    for (const state of STATES) {
      expect(transition(state, { type: "MODULE_DIED" })).toBe("module_error");
    }
    expect(transition("module_error", { type: "START" })).toBe("module_error");
    expect(transition("module_error", { type: "STOP" })).toBe("module_error");
    expect(transition("module_error", { type: "TRANSMIT_BEGIN" })).toBe("module_error");
    expect(transition("module_error", { type: "RESTART" })).toBe("idle");
    expect(transition(transition("module_error", { type: "RESTART" }), { type: "START" })).toBe(
      "listening",
    );
  });

  it("separates recoverable errors (START again) from module death (RESTART)", () => {
    const failed = transition("listening", { type: "RECOVERABLE_ERROR" });
    expect(failed).toBe("error");
    expect(transition(failed, { type: "START" })).toBe("listening");
    // A recoverable error never hijacks a clean idle session.
    expect(transition("idle", { type: "RECOVERABLE_ERROR" })).toBe("idle");
  });

  it("never lets STOP erase module_error", () => {
    expect(transition("module_error", { type: "STOP" })).toBe("module_error");
  });

  it("classifies active states", () => {
    expect(isActive("listening")).toBe(true);
    expect(isActive("backoff")).toBe(true);
    expect(isActive("idle")).toBe(false);
    expect(isActive("module_error")).toBe(false);
  });

  it("matches the full transition table for every state x event pair", () => {
    for (const event of EVENTS) {
      STATES.forEach((state, index) => {
        const expected = TABLE[event.type][index];
        expect(transition(state, event), `${state} + ${event.type}`).toBe(expected);
      });
    }
  });
});
