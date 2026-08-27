/**
 * HuskRoom Durable Object.
 *
 * One instance per active PIN. Holds every piece of room state in memory:
 * participants, the monotonic sequence counter and the room's deadlines. It
 * relays opaque ciphertext between sockets and can never decrypt anything,
 * because the room key is never sent to the server.
 *
 * Closure is driven only by the alarm below — never by a client-side cleanup
 * call — so a crashed host cannot leave a room alive.
 */

import {
  ALARM_INTERVAL_MS,
  MAX_PARTICIPANTS,
  ROOM_IDLE_TIMEOUT_MS,
  ROOM_MAX_LIFETIME_MS,
} from "./config";
import type { DurableObjectState, Env } from "./types";

type Participant = { id: string; joinedAt: number };

type Attachment = { id: string; joinedAt: number };

type ClientFrame =
  | { t: "ping" }
  | { t: "send"; localId: string; payload: { iv: string; ct: string } };

/** Boundary parser for frames arriving from a browser. */
function parseClientFrame(data: string | ArrayBuffer): ClientFrame | null {
  let decoded: { t?: string; localId?: string; payload?: { iv?: string; ct?: string } };
  try {
    // SAFETY: every field is validated below before the frame is used.
    decoded = JSON.parse(String(data)) as typeof decoded;
  } catch {
    return null;
  }
  if (decoded.t === "ping") {
    return { t: "ping" };
  }
  const localId = String(decoded.localId ?? "");
  const iv = String(decoded.payload?.iv ?? "");
  const ct = String(decoded.payload?.ct ?? "");
  if (decoded.t !== "send" || localId === "" || iv === "" || ct === "") {
    return null;
  }
  return { t: "send", localId, payload: { iv, ct } };
}

export class HuskRoom {
  private seq = 0;
  private createdAt = 0;
  private emptySince = 0;
  private exists = false;

  constructor(
    private readonly state: DurableObjectState,
    private readonly env: Env,
  ) {}

  private participants(): Participant[] {
    return this.state
      .getWebSockets()
      .map((socket) => {
        const raw = socket.deserializeAttachment<Attachment>();
        return raw === null ? null : { id: raw.id, joinedAt: raw.joinedAt };
      })
      .filter((value): value is Participant => value !== null);
  }

  private broadcast<T>(payload: T, except?: WebSocket): void {
    const body = JSON.stringify(payload);
    for (const socket of this.state.getWebSockets()) {
      if (socket === except) {
        continue;
      }
      try {
        socket.send(body);
      } catch {
        // A dead socket is closed by the runtime; nothing to recover here.
      }
    }
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname.endsWith("/create") || url.pathname.endsWith("/join")) {
      const creating = url.pathname.endsWith("/create");
      if (creating && this.exists) {
        return Response.json({ error: "pin_taken" }, { status: 409 });
      }
      if (!creating && !this.exists) {
        // Generic error: never reveal whether a PIN exists.
        return Response.json({ error: "unavailable" }, { status: 404 });
      }
      if (creating) {
        this.exists = true;
        this.createdAt = Date.now();
        this.emptySince = Date.now();
        await this.state.storage.setAlarm(Date.now() + ALARM_INTERVAL_MS);
      }
      if (this.participants().length >= MAX_PARTICIPANTS) {
        return Response.json({ error: "unavailable" }, { status: 403 });
      }
      return Response.json({ ok: true, expiresAt: this.expiresAt() });
    }

    if (url.pathname.endsWith("/socket")) {
      if (request.headers.get("Upgrade") !== "websocket") {
        return new Response("Expected websocket", { status: 426 });
      }
      if (!this.exists) {
        return new Response("unavailable", { status: 404 });
      }
      if (this.participants().length >= MAX_PARTICIPANTS) {
        // Atomic: the check and the accept happen in the same synchronous
        // handler inside a single-threaded Durable Object.
        return new Response("room_full", { status: 403 });
      }

      const pair = new WebSocketPair();
      const client = pair[0];
      const server = pair[1];
      const id = crypto.randomUUID();
      const joinedAt = Date.now();

      this.state.acceptWebSocket(server);
      server.serializeAttachment({ id, joinedAt } satisfies Attachment);
      this.emptySince = 0;

      server.send(
        JSON.stringify({
          t: "welcome",
          you: id,
          participants: this.participants(),
          seq: this.seq,
          expiresAt: this.expiresAt(),
        }),
      );
      this.broadcast(
        {
          t: "presence",
          event: "join",
          who: id,
          participants: this.participants(),
        },
        server,
      );

      return new Response(null, { status: 101, webSocket: client });
    }

    return new Response("not_found", { status: 404 });
  }

  private expiresAt(): number {
    return this.createdAt + ROOM_MAX_LIFETIME_MS;
  }

  async webSocketMessage(socket: WebSocket, data: string | ArrayBuffer) {
    const frame = parseClientFrame(data);
    if (frame === null) {
      socket.send(JSON.stringify({ t: "error", code: "bad_request" }));
      return;
    }

    if (frame.t === "ping") {
      socket.send(JSON.stringify({ t: "pong" }));
      return;
    }

    const attachment = socket.deserializeAttachment<Attachment>();
    if (attachment === null) {
      return;
    }

    this.seq += 1;
    const relay = {
      t: "relay",
      seq: this.seq,
      senderId: attachment.id,
      localId: frame.localId,
      ts: Date.now(),
      payload: frame.payload,
    };
    this.broadcast(relay);
    socket.send(JSON.stringify({ t: "ack", localId: frame.localId, seq: this.seq }));
  }

  async webSocketClose(socket: WebSocket) {
    const attachment = socket.deserializeAttachment<Attachment>();
    const remaining = this.participants().filter(
      (participant) => participant.id !== attachment?.id,
    );
    if (remaining.length === 0) {
      this.emptySince = Date.now();
    }
    this.broadcast({
      t: "presence",
      event: "leave",
      who: attachment?.id ?? "unknown",
      participants: remaining,
    });
  }

  async webSocketError(socket: WebSocket) {
    await this.webSocketClose(socket);
  }

  /**
   * The single mechanism that closes a room. Runs regardless of whether any
   * client behaved well, which is what makes crashed hosts safe.
   */
  async alarm(): Promise<void> {
    const now = Date.now();
    const expired = now >= this.expiresAt();
    const idle =
      this.participants().length === 0 &&
      this.emptySince > 0 &&
      now - this.emptySince >= ROOM_IDLE_TIMEOUT_MS;

    if (expired || idle) {
      this.broadcast({ t: "closed", reason: expired ? "expired" : "idle" });
      for (const socket of this.state.getWebSockets()) {
        try {
          socket.close(1000, "room_closed");
        } catch {
          // Already gone.
        }
      }
      this.exists = false;
      this.seq = 0;
      await this.state.storage.deleteAll();
      return;
    }

    await this.state.storage.setAlarm(now + ALARM_INTERVAL_MS);
  }
}
