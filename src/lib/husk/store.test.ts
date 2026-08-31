import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { generateRoomKeyFragment, importRoomKey, seal } from "./crypto";
import type { ConnectionHandlers } from "./connection";
import { orderedEntries, type ChatEntry, type ConnectionLike } from "./store";
import type { SealedBody, SealedEnvelope, ServerMessage } from "./protocol";

const FRAGMENT = generateRoomKeyFragment();

/** Stand-in connection replicating the real RoomConnection lifecycle signals. */
class FakeConnection implements ConnectionLike {
  static instances: FakeConnection[] = [];
  readonly sent: { localId: string; payload: SealedEnvelope }[] = [];
  closed = false;
  resetBackoffCalls = 0;

  constructor(
    readonly roomId: string,
    readonly handlers: ConnectionHandlers,
  ) {
    FakeConnection.instances.push(this);
  }

  connect(): void {
    void this.handlers.fetchJoinToken().then((grant) => {
      if (this.closed) {
        return;
      }
      if (grant.ok) {
        this.handlers.onStatus("open");
      } else {
        this.handlers.onStatus("closed");
        this.handlers.onEnded(
          grant.failure === "rate_limited"
            ? "join_refused_rate_limited"
            : "join_refused_unavailable",
        );
      }
    });
  }

  close(): void {
    this.closed = true;
    this.handlers.onStatus("closed");
  }

  resetBackoff(): void {
    this.resetBackoffCalls += 1;
    this.handlers.onStatus("open");
  }

  send(localId: string, payload: SealedEnvelope): boolean {
    this.sent.push({ localId, payload });
    return true;
  }

  sendControl(): boolean {
    return false;
  }
}

function stubJoinEndpoint(status: number, body: Record<string, unknown> = {}): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(JSON.stringify(body), { status })),
  );
}

function lastConn(): FakeConnection {
  const conn = FakeConnection.instances.at(-1);
  if (conn === undefined) {
    throw new Error("no connection created");
  }
  return conn;
}

/**
 * Lets an in-flight async decrypt (and the guard check after it) complete.
 * WebCrypto resolves on the host's thread pool rather than the fake-timer
 * queue, so under load it can take more event-loop turns than the async
 * timer advances alone guarantee; yield generously (bounded, so a genuinely
 * broken insert still fails the test instead of masking).
 */
async function flushDecrypt(): Promise<void> {
  for (let index = 0; index < 100; index += 1) {
    await vi.advanceTimersByTimeAsync(1);
  }
}

async function makeStore() {
  const { createRoomStore } = await import("./store");
  return createRoomStore((roomId, handlers) => new FakeConnection(roomId, handlers));
}

async function connectedStore() {
  stubJoinEndpoint(200, { joinToken: "tok" });
  const store = await makeStore();
  await store.getState().connect("123456", FRAGMENT);
  await vi.advanceTimersByTimeAsync(0);
  return store;
}

function welcome(conn: FakeConnection): void {
  conn.handlers.onMessage({
    t: "welcome",
    you: "me",
    participants: [
      { id: "me", joinedAt: 1 },
      { id: "p2", joinedAt: 2 },
    ],
    seq: 0,
    expiresAt: Date.now() + 60_000,
  });
}

function peerRelay(
  conn: FakeConnection,
  payload: SealedEnvelope,
  overrides: Partial<Extract<ServerMessage, { t: "relay" }>> = {},
): void {
  conn.handlers.onMessage({
    t: "relay",
    seq: 1,
    senderId: "p2",
    localId: "r1",
    ts: 1,
    payload,
    ...overrides,
  });
}

describe("room store", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    FakeConnection.instances = [];
    vi.stubEnv("VITE_WORKER_URL", "https://relay.example");
    vi.resetModules();
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("a server closed frame applies the terminal state and disposes the connection", async () => {
    const store = await connectedStore();
    const conn = lastConn();
    conn.handlers.onMessage({ t: "closed", reason: "expired" });
    expect(store.getState().state).toBe("closed_expired");
    expect(store.getState().status).toBe("closed");
    expect(conn.closed).toBe(true);
  });

  it("a refused join lands in closed_not_found", async () => {
    stubJoinEndpoint(404);
    const store = await makeStore();
    await store.getState().connect("123456", FRAGMENT);
    await vi.advanceTimersByTimeAsync(0);
    expect(store.getState().state).toBe("closed_not_found");
    expect(store.getState().status).toBe("closed");
  });

  it("a throttled join lands in closed_rate_limited", async () => {
    stubJoinEndpoint(429);
    const store = await makeStore();
    await store.getState().connect("123456", FRAGMENT);
    await vi.advanceTimersByTimeAsync(0);
    expect(store.getState().state).toBe("closed_rate_limited");
  });

  it("an exhausted reconnect budget lands in closed_disconnected and retry() reconnects", async () => {
    const store = await connectedStore();
    lastConn().handlers.onEnded("attempts_exhausted");
    expect(store.getState().state).toBe("closed_disconnected");
    const before = FakeConnection.instances.length;
    await store.getState().retry();
    expect(FakeConnection.instances.length).toBe(before + 1);
    expect(store.getState().state).toBe("joining");
  });

  it("an unacked message flips to failed after 10s and retryMessage resends the same localId", async () => {
    const store = await connectedStore();
    await store.getState().sendText("hello");
    const conn = lastConn();
    expect(conn.sent.length).toBe(1);
    const sent = conn.sent[0];
    if (sent === undefined) {
      throw new Error("frame missing");
    }
    const localId = sent.localId;
    expect(store.getState().entries[0]?.id).toBe(localId);
    expect(store.getState().entries[0]?.delivery).toBe("sending");

    await vi.advanceTimersByTimeAsync(10_000);
    expect(store.getState().entries[0]?.delivery).toBe("failed");

    await store.getState().retryMessage(localId);
    expect(conn.sent.length).toBe(2);
    expect(conn.sent[1]?.localId).toBe(localId);
    expect(store.getState().entries[0]?.delivery).toBe("sending");
  });

  it("an ack resolves the message and clears the failure timeout", async () => {
    const store = await connectedStore();
    await store.getState().sendText("hello");
    const localId = lastConn().sent[0]?.localId;
    if (localId === undefined) {
      throw new Error("frame missing");
    }
    lastConn().handlers.onMessage({ t: "ack", localId, seq: 7 });
    expect(store.getState().entries[0]?.delivery).toBe("sent");
    expect(store.getState().entries[0]?.seq).toBe(7);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(store.getState().entries[0]?.delivery).toBe("sent");
  });

  it("a duplicate relay with the same localId is inserted once", async () => {
    const store = await connectedStore();
    const conn = lastConn();
    welcome(conn);
    const key = await importRoomKey(FRAGMENT);
    const payload = await seal<SealedBody>(key, { kind: "text", text: "dup", sentAt: 1 });
    peerRelay(conn, payload);
    peerRelay(conn, payload, { seq: 2, ts: 2 });
    await flushDecrypt();
    expect(store.getState().entries.length).toBe(1);
    expect(store.getState().entries[0]?.body?.kind).toBe("text");
  });

  it("a duplicate own relay resolves instead of duplicating", async () => {
    const store = await connectedStore();
    const conn = lastConn();
    welcome(conn);
    await store.getState().sendText("mine");
    const localId = conn.sent[0]?.localId;
    if (localId === undefined) {
      throw new Error("frame missing");
    }
    conn.handlers.onMessage({
      t: "relay",
      seq: 3,
      senderId: "me",
      localId,
      ts: 1,
      payload: { iv: "i", ct: "c" },
    });
    conn.handlers.onMessage({
      t: "relay",
      seq: 4,
      senderId: "me",
      localId,
      ts: 2,
      payload: { iv: "i", ct: "c" },
    });
    expect(store.getState().entries.length).toBe(1);
    expect(store.getState().entries[0]?.seq).toBe(4);
    expect(store.getState().entries[0]?.delivery).toBe("sent");
  });

  it("the grace window follows the latest leave deadline, not the first timer", async () => {
    const store = await connectedStore();
    const conn = lastConn();
    welcome(conn);
    expect(store.getState().state).toBe("active");

    conn.handlers.onMessage({
      t: "presence",
      event: "leave",
      who: "p2",
      participants: [{ id: "me", joinedAt: 1 }],
    });
    expect(store.getState().state).toBe("peer_disconnected_grace");

    await vi.advanceTimersByTimeAsync(4_000);
    conn.handlers.onMessage({
      t: "presence",
      event: "join",
      who: "p2",
      participants: [
        { id: "me", joinedAt: 1 },
        { id: "p2", joinedAt: 3 },
      ],
    });
    expect(store.getState().state).toBe("active");
    expect(store.getState().lastLeaveAt).toBeNull();

    conn.handlers.onMessage({
      t: "presence",
      event: "leave",
      who: "p2",
      participants: [{ id: "me", joinedAt: 1 }],
    });
    // Four seconds into the second grace window the first timer would already
    // have fired; the deadline data keeps the window open.
    await vi.advanceTimersByTimeAsync(4_000);
    expect(store.getState().state).toBe("peer_disconnected_grace");
    await vi.advanceTimersByTimeAsync(4_100);
    expect(store.getState().state).toBe("waiting_for_peer");
    expect(store.getState().entries.some((entry) => entry.system !== undefined)).toBe(true);
  });

  it("a late decrypt after the room was left does not write", async () => {
    const store = await connectedStore();
    const conn = lastConn();
    welcome(conn);
    const key = await importRoomKey(FRAGMENT);
    const payload = await seal<SealedBody>(key, { kind: "text", text: "late", sentAt: 1 });
    conn.handlers.onMessage({
      t: "relay",
      seq: 1,
      senderId: "p2",
      localId: "late",
      ts: 1,
      payload,
    });
    store.getState().leave();
    await flushDecrypt();
    expect(store.getState().entries.length).toBe(0);
    expect(store.getState().state).toBe("closed_by_host");
  });

  it("malformed frames are counted, not silently dropped", async () => {
    const store = await connectedStore();
    const conn = lastConn();
    conn.handlers.onMalformed();
    conn.handlers.onMalformed();
    expect(store.getState().malformedCount).toBe(2);
  });

  it("an offline event marks the store offline", async () => {
    const store = await connectedStore();
    expect(store.getState().online).toBe(true);
    store.getState().notifyOffline();
    expect(store.getState().online).toBe(false);
  });

  it("coming back online resets the connection backoff immediately", async () => {
    const store = await connectedStore();
    const conn = lastConn();
    store.getState().notifyOffline();
    store.getState().notifyOnline();
    expect(store.getState().online).toBe(true);
    expect(conn.resetBackoffCalls).toBe(1);
  });

  it("coming back online reconnects a room that ended as disconnected", async () => {
    const store = await connectedStore();
    lastConn().handlers.onEnded("attempts_exhausted");
    expect(store.getState().state).toBe("closed_disconnected");
    const before = FakeConnection.instances.length;
    store.getState().notifyOnline();
    await vi.advanceTimersByTimeAsync(0);
    expect(FakeConnection.instances.length).toBe(before + 1);
    expect(store.getState().state).toBe("joining");
  });
});

describe("message ordering", () => {
  const entry = (overrides: Partial<ChatEntry>): ChatEntry => ({
    id: "e",
    seq: 0,
    mine: false,
    senderId: "p2",
    ts: 0,
    delivery: "sent",
    body: null,
    ...overrides,
  });

  it("orderedEntries sorts out-of-order input by seq", () => {
    const scrambled = [
      entry({ id: "c", seq: 3 }),
      entry({ id: "a", seq: 1 }),
      entry({ id: "b", seq: 2 }),
    ];
    expect(orderedEntries(scrambled).map((e) => e.id)).toEqual(["a", "b", "c"]);
  });

  it("orderedEntries breaks seq ties with ts", () => {
    const tied = [entry({ id: "late", seq: 7, ts: 200 }), entry({ id: "early", seq: 7, ts: 100 })];
    expect(orderedEntries(tied).map((e) => e.id)).toEqual(["early", "late"]);
  });

  it("orderedEntries always sorts system messages after real messages", () => {
    // System entries use MAX_SAFE_INTEGER seq regardless of their wall-clock ts.
    const mixed = [
      entry({ id: "sys", seq: Number.MAX_SAFE_INTEGER, ts: 1, system: "left" }),
      entry({ id: "m9", seq: 9, ts: 999 }),
      entry({ id: "m2", seq: 2, ts: 2 }),
    ];
    expect(orderedEntries(mixed).map((e) => e.id)).toEqual(["m2", "m9", "sys"]);
  });

  it("out-of-order relays render in seq order", async () => {
    vi.useFakeTimers();
    FakeConnection.instances = [];
    vi.stubEnv("VITE_WORKER_URL", "https://relay.example");
    vi.resetModules();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const store = await connectedStore();
      const conn = lastConn();
      welcome(conn);
      const key = await importRoomKey(FRAGMENT);
      const payload = await seal<SealedBody>(key, { kind: "text", text: "hi", sentAt: 1 });

      // Delivered out of order (network reordering), each fully processed
      // before the next arrives.
      peerRelay(conn, payload, { localId: "m3", seq: 3, ts: 3 });
      await flushDecrypt();
      peerRelay(conn, payload, { localId: "m1", seq: 1, ts: 1 });
      await flushDecrypt();
      peerRelay(conn, payload, { localId: "m2", seq: 2, ts: 2 });
      await flushDecrypt();

      // Arrival order is insertion order; the render path sorts via
      // orderedEntries (chat.tsx), which restores server seq order.
      expect(store.getState().entries.map((e) => e.id)).toEqual(["m3", "m1", "m2"]);
      expect(orderedEntries(store.getState().entries).map((e) => e.id)).toEqual(["m1", "m2", "m3"]);
    } finally {
      vi.unstubAllEnvs();
      vi.useRealTimers();
      vi.restoreAllMocks();
    }
  });
});
