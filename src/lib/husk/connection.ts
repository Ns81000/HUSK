/**
 * WebSocket client for a room's Durable Object.
 *
 * Responsibilities: connect, auto-reconnect with bounded exponential backoff,
 * buffer outbound frames while offline, and surface every server frame to the
 * caller. It never sees the room key: callers hand it ciphertext.
 *
 * Connecting is guaranteed to terminate: a refused join, a token that
 * repeatedly fails to upgrade, or an exhausted reconnect budget all end in a
 * one-time `onEnded` signal instead of an infinite loop.
 */

import type { JoinResult } from "./api";
import {
  MAX_OUTBOX_FRAMES,
  RECONNECT_HANDSHAKE_FAILURES,
  RECONNECT_MAX_ATTEMPTS,
  RECONNECT_STABLE_MS,
  WORKER_URL,
} from "./config";
import { backoffDelay } from "./backoff";
import {
  parseServerMessage,
  type ClientMessage,
  type SealedEnvelope,
  type ServerMessage,
} from "./protocol";

export type ConnectionStatus = "connecting" | "open" | "reconnecting" | "closed";

/** Why connecting has permanently failed. The connection is disposed after. */
export type ConnectionEndReason =
  | "join_refused_unavailable"
  | "join_refused_rate_limited"
  | "attempts_exhausted";

export type ConnectionHandlers = {
  readonly onMessage: (message: ServerMessage) => void;
  readonly onStatus: (status: ConnectionStatus) => void;
  /** Called exactly once, when connecting has permanently failed. */
  readonly onEnded: (reason: ConnectionEndReason) => void;
  /** Called for every received frame that failed shape validation. */
  readonly onMalformed: () => void;
  /**
   * Mints a one-time join token from /room/join. A non-ok result (room gone,
   * full, or throttled) ends connecting for good.
   */
  readonly fetchJoinToken: () => Promise<JoinResult>;
};

export function roomSocketUrl(pin: string, joinToken: string): string {
  const base = WORKER_URL;
  if (base.length === 0) {
    throw new Error("VITE_WORKER_URL is not configured");
  }
  const url = new URL(`${base}/room/${pin}/socket`);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.searchParams.set("jt", joinToken);
  return url.toString();
}

type OutboxEntry = { readonly frame: ClientMessage; readonly queuedAt: number };

export class RoomConnection {
  private socket: WebSocket | null = null;
  private attempt = 0;
  private disposed = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private openedThisConnect = false;
  private openedAt = 0;
  private handshakeFailures = 0;
  private expiresAt = Number.POSITIVE_INFINITY;
  private readonly outbox: OutboxEntry[] = [];

  constructor(
    private readonly pin: string,
    private readonly handlers: ConnectionHandlers,
  ) {}

  connect(): void {
    if (this.disposed) {
      return;
    }
    this.openedThisConnect = false;
    this.handlers.onStatus(this.attempt === 0 ? "connecting" : "reconnecting");
    void this.handlers
      .fetchJoinToken()
      .then((grant) => {
        if (this.disposed) {
          return;
        }
        if (!grant.ok) {
          // Join refused: the room is gone, full, or the caller is throttled.
          // Retrying can never succeed, so stop here for good.
          this.end(
            grant.failure === "rate_limited"
              ? "join_refused_rate_limited"
              : "join_refused_unavailable",
          );
          return;
        }
        this.open(grant.joinToken);
      })
      .catch(() => {
        if (this.disposed) {
          return;
        }
        // The join endpoint itself is unreachable: a network blip, retried
        // within the reconnect budget.
        this.scheduleReconnect();
      });
  }

  /**
   * Resets the reconnect budget and reconnects immediately, e.g. when the
   * browser comes back online. No-op once ended.
   */
  resetBackoff(): void {
    if (this.disposed) {
      return;
    }
    this.attempt = 0;
    this.handshakeFailures = 0;
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.socket === null || this.socket.readyState !== WebSocket.OPEN) {
      this.socket?.close();
      this.connect();
    }
  }

  private open(joinToken: string): void {
    const socket = new WebSocket(roomSocketUrl(this.pin, joinToken));
    this.socket = socket;

    socket.addEventListener("open", () => {
      this.openedThisConnect = true;
      this.openedAt = Date.now();
      this.handshakeFailures = 0;
      this.handlers.onStatus("open");
      this.flush();
    });

    socket.addEventListener("message", (event) => {
      const message = parseServerMessage(String(event.data));
      if (message === null) {
        this.handlers.onMalformed();
        return;
      }
      if (message.t === "welcome") {
        this.expiresAt = message.expiresAt;
      }
      this.handlers.onMessage(message);
    });

    socket.addEventListener("close", () => {
      if (this.disposed) {
        return;
      }
      if (!this.openedThisConnect) {
        // The token mint succeeded but the upgrade failed. Once that repeats,
        // the room is gone (or unreachable for this caller) — not a blip.
        this.handshakeFailures += 1;
        if (this.handshakeFailures >= RECONNECT_HANDSHAKE_FAILURES) {
          this.end("join_refused_unavailable");
          return;
        }
      } else if (Date.now() - this.openedAt >= RECONNECT_STABLE_MS) {
        // A long-lived connection that dropped earns a fresh budget.
        this.attempt = 0;
      }
      this.handlers.onStatus("reconnecting");
      this.scheduleReconnect();
    });

    socket.addEventListener("error", () => {
      socket.close();
    });
  }

  private scheduleReconnect(): void {
    if (this.attempt >= RECONNECT_MAX_ATTEMPTS) {
      this.end("attempts_exhausted");
      return;
    }
    const delay = backoffDelay(this.attempt);
    this.attempt += 1;
    this.timer = setTimeout(() => this.connect(), delay);
  }

  private end(reason: ConnectionEndReason): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.handlers.onStatus("closed");
    this.handlers.onEnded(reason);
  }

  private pruneExpired(): void {
    while (this.outbox.length > 0) {
      const first = this.outbox[0];
      if (first === undefined || first.queuedAt <= this.expiresAt) {
        return;
      }
      this.outbox.shift();
    }
  }

  private flush(): void {
    this.pruneExpired();
    while (this.outbox.length > 0 && this.socket?.readyState === WebSocket.OPEN) {
      const next = this.outbox.shift();
      if (next) {
        this.socket.send(JSON.stringify(next.frame));
      }
    }
  }

  private enqueue(frame: ClientMessage): void {
    this.pruneExpired();
    if (this.outbox.length >= MAX_OUTBOX_FRAMES) {
      this.outbox.shift();
    }
    this.outbox.push({ frame, queuedAt: Date.now() });
  }

  /** Queues a sealed payload; returns false when it had to be buffered. */
  send(localId: string, payload: SealedEnvelope): boolean {
    const frame: ClientMessage = { t: "send", localId, payload };
    if (this.socket?.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify(frame));
      return true;
    }
    this.enqueue(frame);
    return false;
  }

  /**
   * Sends a control frame (never ciphertext) on the live socket only. A cancel
   * for a failed upload has no meaning once disconnected, so it is dropped.
   */
  sendControl(frame: Extract<ClientMessage, { t: "cancel" }>): boolean {
    if (this.socket?.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify(frame));
      return true;
    }
    return false;
  }

  close(): void {
    this.disposed = true;
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.socket?.close();
    this.handlers.onStatus("closed");
  }
}
