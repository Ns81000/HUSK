/**
 * WebSocket client for a room's Durable Object.
 *
 * Responsibilities: connect, auto-reconnect with bounded exponential backoff,
 * buffer outbound frames while offline, and surface every server frame to the
 * caller. It never sees the room key: callers hand it ciphertext.
 */

import { WORKER_URL } from "./config";
import {
  parseServerMessage,
  type ClientMessage,
  type SealedEnvelope,
  type ServerMessage,
} from "./protocol";
import { backoffDelay } from "./backoff";

export type ConnectionStatus = "connecting" | "open" | "reconnecting" | "closed";

export type ConnectionHandlers = {
  readonly onMessage: (message: ServerMessage) => void;
  readonly onStatus: (status: ConnectionStatus) => void;
};

export function roomSocketUrl(pin: string): string {
  const base = WORKER_URL;
  if (base.length === 0) {
    throw new Error("VITE_WORKER_URL is not configured");
  }
  const url = new URL(`${base}/room/${pin}/socket`);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.toString();
}

export class RoomConnection {
  private socket: WebSocket | null = null;
  private attempt = 0;
  private disposed = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private readonly outbox: ClientMessage[] = [];

  constructor(
    private readonly pin: string,
    private readonly handlers: ConnectionHandlers,
  ) {}

  connect(): void {
    if (this.disposed) {
      return;
    }
    this.handlers.onStatus(this.attempt === 0 ? "connecting" : "reconnecting");

    const socket = new WebSocket(roomSocketUrl(this.pin));
    this.socket = socket;

    socket.addEventListener("open", () => {
      this.attempt = 0;
      this.handlers.onStatus("open");
      this.flush();
    });

    socket.addEventListener("message", (event) => {
      const message = parseServerMessage(String(event.data));
      if (message !== null) {
        this.handlers.onMessage(message);
      }
    });

    socket.addEventListener("close", () => {
      if (this.disposed) {
        return;
      }
      this.handlers.onStatus("reconnecting");
      this.scheduleReconnect();
    });

    socket.addEventListener("error", () => {
      socket.close();
    });
  }

  private scheduleReconnect(): void {
    const delay = backoffDelay(this.attempt);
    this.attempt += 1;
    this.timer = setTimeout(() => this.connect(), delay);
  }

  private flush(): void {
    while (this.outbox.length > 0 && this.socket?.readyState === WebSocket.OPEN) {
      const next = this.outbox.shift();
      if (next) {
        this.socket.send(JSON.stringify(next));
      }
    }
  }

  /** Queues a sealed payload; returns false when it had to be buffered. */
  send(localId: string, payload: SealedEnvelope): boolean {
    const frame: ClientMessage = { t: "send", localId, payload };
    if (this.socket?.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify(frame));
      return true;
    }
    this.outbox.push(frame);
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
    }
    this.socket?.close();
    this.handlers.onStatus("closed");
  }
}
