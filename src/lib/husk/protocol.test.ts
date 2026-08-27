import { describe, expect, it } from "vitest";
import { parseServerMessage } from "./protocol";

const VALID_WELCOME = {
  t: "welcome",
  you: "p1",
  participants: [{ id: "p1", joinedAt: 1 }],
  seq: 0,
  expiresAt: 999,
};

const VALID_RELAY = {
  t: "relay",
  seq: 3,
  senderId: "p2",
  localId: "m1",
  ts: 42,
  payload: { iv: "aXY", ct: "Y3Q" },
};

describe("parseServerMessage", () => {
  it("parses every valid tag", () => {
    expect(parseServerMessage(JSON.stringify(VALID_WELCOME))).toEqual(VALID_WELCOME);
    expect(parseServerMessage(JSON.stringify(VALID_RELAY))).toEqual(VALID_RELAY);
    expect(
      parseServerMessage(
        JSON.stringify({ t: "presence", event: "join", who: "p2", participants: [] }),
      ),
    ).toEqual({ t: "presence", event: "join", who: "p2", participants: [] });
    expect(parseServerMessage(JSON.stringify({ t: "ack", localId: "m1", seq: 1 }))).toEqual({
      t: "ack",
      localId: "m1",
      seq: 1,
    });
    expect(parseServerMessage(JSON.stringify({ t: "pong" }))).toEqual({ t: "pong" });
    expect(parseServerMessage(JSON.stringify({ t: "closed", reason: "expired" }))).toEqual({
      t: "closed",
      reason: "expired",
    });
    expect(parseServerMessage(JSON.stringify({ t: "error", code: "room_full" }))).toEqual({
      t: "error",
      code: "room_full",
    });
  });

  it("rejects unparseable input and unknown tags", () => {
    expect(parseServerMessage("not json")).toBeNull();
    expect(parseServerMessage("42")).toBeNull();
    expect(parseServerMessage(JSON.stringify({ t: "nope" }))).toBeNull();
    expect(parseServerMessage(JSON.stringify({}))).toBeNull();
  });

  it("rejects a relay with a missing or malformed payload instead of blind-casting", () => {
    expect(parseServerMessage(JSON.stringify({ ...VALID_RELAY, payload: undefined }))).toBeNull();
    expect(
      parseServerMessage(JSON.stringify({ ...VALID_RELAY, payload: { iv: "aXY" } })),
    ).toBeNull();
    expect(
      parseServerMessage(JSON.stringify({ ...VALID_RELAY, payload: { iv: 1, ct: "Y3Q" } })),
    ).toBeNull();
  });

  it("rejects wrong-typed scalar fields per tag", () => {
    expect(parseServerMessage(JSON.stringify({ ...VALID_RELAY, seq: "3" }))).toBeNull();
    expect(parseServerMessage(JSON.stringify({ ...VALID_RELAY, senderId: null }))).toBeNull();
    expect(
      parseServerMessage(JSON.stringify({ ...VALID_WELCOME, expiresAt: undefined })),
    ).toBeNull();
    expect(parseServerMessage(JSON.stringify({ t: "ack", localId: "m1" }))).toBeNull();
  });

  it("rejects malformed participant lists", () => {
    expect(
      parseServerMessage(JSON.stringify({ ...VALID_WELCOME, participants: "nope" })),
    ).toBeNull();
    expect(
      parseServerMessage(JSON.stringify({ ...VALID_WELCOME, participants: [{ id: "p1" }] })),
    ).toBeNull();
    expect(
      parseServerMessage(
        JSON.stringify({ ...VALID_WELCOME, participants: [{ id: 1, joinedAt: 1 }] }),
      ),
    ).toBeNull();
  });

  it("rejects out-of-range enum fields", () => {
    expect(parseServerMessage(JSON.stringify({ t: "closed", reason: "whatever" }))).toBeNull();
    expect(parseServerMessage(JSON.stringify({ t: "error", code: "whatever" }))).toBeNull();
    expect(
      parseServerMessage(JSON.stringify({ t: "presence", event: "vanished", who: "p" })),
    ).toBeNull();
  });
});