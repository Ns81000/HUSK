import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ConnectionHandlers, RoomConnection } from "./connection";
import type { JoinResult } from "./api";
import { PING_INTERVAL_MS, PONG_TIMEOUT_MS } from "./config";
import type { ServerMessage } from "./protocol";

/** Minimal stand-in for the browser WebSocket global. */
class FakeWebSocket {
  static OPEN = 1;
  static instances: FakeWebSocket[] = [];
  readyState = 0;
  sent: string[] = [];
  private readonly listeners = new Map<string, ((event?: unknown) => void)[]>();

  constructor(readonly url: string) {
    FakeWebSocket.instances.push(this);
  }

  addEventListener(type: string, listener: (event?: unknown) => void): void {
    const list = this.listeners.get(type) ?? [];
    list.push(listener);
    this.listeners.set(type, list);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.readyState = 3;
    this.emit("close");
  }

  emit(type: string, event?: unknown): void {
    if (type === "open") {
      this.readyState = 1;
    }
    if (type === "close") {
      this.readyState = 3;
    }
    for (const listener of this.listeners.get(type) ?? []) {
      listener(event);
    }
  }
}

type Events = {
  statuses: string[];
  ended: string[];
  messages: ServerMessage[];
  malformed: number;
};

function makeHandlers(grant: JoinResult = { ok: true, roomId: "123456", joinToken: "tok" }) {
  const events: Events = { statuses: [], ended: [], messages: [], malformed: 0 };
  const handlers: ConnectionHandlers = {
    onMessage: (message) => {
      events.messages.push(message);
    },
    onStatus: (status) => {
      events.statuses.push(status);
    },
    onEnded: (reason) => {
      events.ended.push(reason);
    },
    onMalformed: () => {
      events.malformed += 1;
    },
    fetchJoinToken: async () => grant,
  };
  return { handlers, events };
}

function lastSocket(): FakeWebSocket {
  const socket = FakeWebSocket.instances.at(-1);
  if (socket === undefined) {
    throw new Error("no socket created");
  }
  return socket;
}

/**
 * Imports the connection module fresh so it reads the stubbed
 * VITE_WORKER_URL (config.ts reads import.meta.env at module load).
 */
async function makeConnection(handlers: ConnectionHandlers): Promise<RoomConnection> {
  const { RoomConnection: Ctor } = await import("./connection");
  return new Ctor("123456", handlers);
}

describe("RoomConnection", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    FakeWebSocket.instances = [];
    vi.stubGlobal("WebSocket", FakeWebSocket);
    vi.stubEnv("VITE_WORKER_URL", "https://relay.example");
    vi.resetModules();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.useRealTimers();
  });

  it("ends for good when the join is refused as unavailable", async () => {
    const { handlers, events } = makeHandlers({ ok: false, failure: "unavailable" });
    const connection = await makeConnection(handlers);
    connection.connect();
    await vi.advanceTimersByTimeAsync(0);
    expect(events.ended).toEqual(["join_refused_unavailable"]);
    expect(events.statuses.at(-1)).toBe("closed");
    expect(FakeWebSocket.instances.length).toBe(0);
  });

  it("ends for good when the join is refused as rate limited", async () => {
    const { handlers, events } = makeHandlers({ ok: false, failure: "rate_limited" });
    const connection = await makeConnection(handlers);
    connection.connect();
    await vi.advanceTimersByTimeAsync(0);
    expect(events.ended).toEqual(["join_refused_rate_limited"]);
  });

  it("gives up with attempts_exhausted once the reconnect budget is spent", async () => {
    const { handlers, events } = makeHandlers();
    const connection = await makeConnection(handlers);
    connection.connect();
    await vi.advanceTimersByTimeAsync(0);
    // Each socket opens and then drops: a blip, retried until the attempt cap
    // is hit. (Sockets that never open end via the handshake-failure path.)
    let guard = 0;
    while (events.ended.length === 0 && guard < 100) {
      guard += 1;
      const socket = lastSocket();
      socket.emit("open");
      socket.emit("close");
      await vi.advanceTimersByTimeAsync(16_000);
    }
    expect(events.ended).toEqual(["attempts_exhausted"]);
    // Initial attempt plus exactly RECONNECT_MAX_ATTEMPTS reconnects.
    expect(FakeWebSocket.instances.length).toBe(11);
    const sockets = FakeWebSocket.instances.length;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(FakeWebSocket.instances.length).toBe(sockets);
  });

  it("maps repeated post-token handshake failures to a terminal not-found", async () => {
    const { handlers, events } = makeHandlers();
    const connection = await makeConnection(handlers);
    connection.connect();
    await vi.advanceTimersByTimeAsync(0);
    while (events.ended.length === 0) {
      lastSocket().emit("close");
      await vi.advanceTimersByTimeAsync(16_000);
    }
    expect(events.ended).toEqual(["join_refused_unavailable"]);
    expect(FakeWebSocket.instances.length).toBe(3);
  });

  it("does not treat a handshake failure after a successful open as terminal", async () => {
    const { handlers, events } = makeHandlers();
    const connection = await makeConnection(handlers);
    connection.connect();
    await vi.advanceTimersByTimeAsync(0);
    const socket = lastSocket();
    socket.emit("open");
    expect(events.statuses).toContain("open");
    // A drop after being open is a blip: backoff reconnects, no end signal.
    socket.emit("close");
    await vi.advanceTimersByTimeAsync(16_000);
    expect(events.ended).toEqual([]);
    expect(FakeWebSocket.instances.length).toBe(2);
  });

  it("counts malformed frames instead of dropping them silently", async () => {
    const { handlers, events } = makeHandlers();
    const connection = await makeConnection(handlers);
    connection.connect();
    await vi.advanceTimersByTimeAsync(0);
    const socket = lastSocket();
    socket.emit("open");
    socket.emit("message", { data: "not json" });
    socket.emit("message", { data: JSON.stringify({ t: "relay", seq: "x" }) });
    expect(events.malformed).toBe(2);
    expect(events.messages).toEqual([]);
    socket.emit("message", {
      data: JSON.stringify({
        t: "relay",
        seq: 1,
        senderId: "p",
        localId: "m",
        ts: 1,
        payload: { iv: "i", ct: "c" },
      }),
    });
    expect(events.messages.length).toBe(1);
  });

  it("caps the outbox at 50 frames and drops the oldest", async () => {
    const { handlers } = makeHandlers();
    const connection = await makeConnection(handlers);
    for (let index = 0; index < 60; index += 1) {
      connection.send(`f${index}`, { iv: "i", ct: "c" });
    }
    connection.connect();
    await vi.advanceTimersByTimeAsync(0);
    lastSocket().emit("open");
    const sent = lastSocket().sent.map(
      (frame) => (JSON.parse(frame) as { localId: string }).localId,
    );
    expect(sent.length).toBe(50);
    expect(sent[0]).toBe("f10");
    expect(sent.at(-1)).toBe("f59");
  });

  it("drops buffered frames older than the room expiry before flushing", async () => {
    const { handlers } = makeHandlers();
    const connection = await makeConnection(handlers);
    connection.connect();
    await vi.advanceTimersByTimeAsync(0);
    const first = lastSocket();
    first.emit("open");
    first.emit("message", {
      data: JSON.stringify({
        t: "welcome",
        you: "p",
        participants: [],
        seq: 0,
        expiresAt: Date.now() + 1_000,
      }),
    });
    first.emit("close");
    await vi.advanceTimersByTimeAsync(2_000);
    connection.send("stale", { iv: "i", ct: "c" });
    // Reconnect past the expiry and open: the stale frame must not be sent.
    await vi.advanceTimersByTimeAsync(16_000);
    const second = lastSocket();
    second.emit("open");
    expect(second.sent).toEqual([]);
    // A fresh welcome extends the expiry; a new frame survives the next cycle.
    second.emit("message", {
      data: JSON.stringify({
        t: "welcome",
        you: "p",
        participants: [],
        seq: 0,
        expiresAt: Date.now() + 60_000,
      }),
    });
    second.emit("close");
    connection.send("fresh", { iv: "i", ct: "c" });
    await vi.advanceTimersByTimeAsync(16_000);
    const third = lastSocket();
    third.emit("open");
    const localIds = third.sent.map((frame) => (JSON.parse(frame) as { localId: string }).localId);
    expect(localIds).toEqual(["fresh"]);
  });

  it("resets the reconnect budget and reconnects immediately", async () => {
    const { handlers, events } = makeHandlers();
    const connection = await makeConnection(handlers);
    connection.connect();
    await vi.advanceTimersByTimeAsync(0);
    lastSocket().emit("close");
    // Without resetBackoff this would wait out the backoff delay.
    connection.resetBackoff();
    await vi.advanceTimersByTimeAsync(0);
    const socket = lastSocket();
    socket.emit("open");
    expect(events.statuses.at(-1)).toBe("open");
  });

  it("pings after the idle interval and keeps a socket that answers alive", async () => {
    const { handlers, events } = makeHandlers();
    const connection = await makeConnection(handlers);
    connection.connect();
    await vi.advanceTimersByTimeAsync(0);
    const socket = lastSocket();
    socket.emit("open");
    // Three idle cycles, each ping answered by a pong: the socket lives.
    for (let cycle = 0; cycle < 3; cycle += 1) {
      await vi.advanceTimersByTimeAsync(PING_INTERVAL_MS);
      expect(socket.sent.some((frame) => (JSON.parse(frame) as { t: string }).t === "ping")).toBe(
        true,
      );
      socket.emit("message", { data: JSON.stringify({ t: "pong" }) });
      await vi.advanceTimersByTimeAsync(1_000);
    }
    expect(FakeWebSocket.instances.length).toBe(1);
    expect(events.statuses.filter((status) => status === "reconnecting")).toEqual([]);
  });

  it("closes a half-open socket that never answers the ping and reconnects", async () => {
    const { handlers, events } = makeHandlers();
    const connection = await makeConnection(handlers);
    connection.connect();
    await vi.advanceTimersByTimeAsync(0);
    const socket = lastSocket();
    socket.emit("open");
    await vi.advanceTimersByTimeAsync(PING_INTERVAL_MS);
    expect(socket.sent.some((frame) => (JSON.parse(frame) as { t: string }).t === "ping")).toBe(
      true,
    );
    // No pong within the window: the client itself closes the zombie socket,
    // which hands over to the standard reconnect flow.
    await vi.advanceTimersByTimeAsync(PONG_TIMEOUT_MS);
    expect(socket.readyState).toBe(3);
    await vi.advanceTimersByTimeAsync(16_000);
    expect(FakeWebSocket.instances.length).toBe(2);
    expect(events.statuses).toContain("reconnecting");
    expect(events.ended).toEqual([]);
  });

  it("treats any server frame, not only pong, as proof of liveness", async () => {
    const { handlers } = makeHandlers();
    const connection = await makeConnection(handlers);
    connection.connect();
    await vi.advanceTimersByTimeAsync(0);
    const socket = lastSocket();
    socket.emit("open");
    await vi.advanceTimersByTimeAsync(15_000);
    socket.emit("message", {
      data: JSON.stringify({
        t: "relay",
        seq: 1,
        senderId: "p",
        localId: "m",
        ts: 1,
        payload: { iv: "i", ct: "c" },
      }),
    });
    // 30s after open without this frame the socket would already be dead.
    await vi.advanceTimersByTimeAsync(15_000);
    expect(FakeWebSocket.instances.length).toBe(1);
    // The post-frame ping fires at t=35s; its unanswered pong window ends at t=45s.
    await vi.advanceTimersByTimeAsync(20_000);
    expect(FakeWebSocket.instances.length).toBe(2);
  });

  it("does not spawn a second connect while the join grant is in flight", async () => {
    let resolveJoin: ((grant: JoinResult) => void) | undefined;
    const events: Events = { statuses: [], ended: [], messages: [], malformed: 0 };
    const handlers: ConnectionHandlers = {
      onMessage: () => {},
      onStatus: (status) => {
        events.statuses.push(status);
      },
      onEnded: () => {},
      onMalformed: () => {},
      fetchJoinToken: () =>
        new Promise<JoinResult>((resolve) => {
          resolveJoin = resolve;
        }),
    };
    const connection = await makeConnection(handlers);
    connection.connect();
    await vi.advanceTimersByTimeAsync(0);
    // resetBackoff (e.g. the browser coming back online) while the join is
    // still pending must not start a parallel connect.
    connection.resetBackoff();
    resolveJoin?.({ ok: true, roomId: "123456", joinToken: "tok" });
    await vi.advanceTimersByTimeAsync(0);
    expect(FakeWebSocket.instances.length).toBe(1);
    lastSocket().emit("open");
    expect(events.statuses.at(-1)).toBe("open");
    expect(events.ended).toEqual([]);
  });

  it("closing a superseded socket never starts a parallel reconnect", async () => {
    const { handlers, events } = makeHandlers();
    const connection = await makeConnection(handlers);
    connection.connect();
    await vi.advanceTimersByTimeAsync(0);
    const first = lastSocket();
    first.emit("open");
    // A second connect() supersedes the live socket: open() closes it.
    connection.connect();
    await vi.advanceTimersByTimeAsync(0);
    expect(FakeWebSocket.instances.length).toBe(2);
    // The old socket's close event fires, but the new socket owns the flow.
    first.emit("close");
    await vi.advanceTimersByTimeAsync(60_000);
    expect(FakeWebSocket.instances.length).toBe(2);
    expect(events.ended).toEqual([]);
  });
});
