/** Cloudflare runtime extensions used by the room Durable Object. */

interface WebSocket {
  serializeAttachment<T>(value: T): void;
  deserializeAttachment<T>(): T | null;
  accept(): void;
}

declare class WebSocketPair {
  0: WebSocket;
  1: WebSocket;
}

interface ResponseInit {
  webSocket?: WebSocket | null;
}
