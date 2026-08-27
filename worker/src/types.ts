/**
 * Minimal ambient typings for the Cloudflare runtime bindings this Worker uses.
 * Kept local so the project does not need to vendor the full workers-types
 * package into the frontend build.
 */

export type KVNamespace = {
  get(key: string, type?: "text"): Promise<string | null>;
  put(
    key: string,
    value: string,
    options?: { expirationTtl?: number },
  ): Promise<void>;
  delete(key: string): Promise<void>;
};

export type R2Object = {
  body: ReadableStream | null;
  size: number;
};

export type R2Bucket = {
  put(key: string, value: ReadableStream | ArrayBuffer): Promise<void>;
  get(key: string): Promise<R2Object | null>;
  delete(key: string): Promise<void>;
};

export type DurableObjectId = { toString(): string };

export type DurableObjectStub = {
  fetch(request: Request): Promise<Response>;
};

export type DurableObjectNamespace = {
  idFromName(name: string): DurableObjectId;
  get(id: DurableObjectId): DurableObjectStub;
};

export type DurableObjectStorage = {
  get<T>(key: string): Promise<T | undefined>;
  put<T>(key: string, value: T): Promise<void>;
  deleteAll(): Promise<void>;
  setAlarm(scheduledTime: number): Promise<void>;
};

export type DurableObjectState = {
  storage: DurableObjectStorage;
  acceptWebSocket(socket: WebSocket, tags?: string[]): void;
  getWebSockets(tag?: string): WebSocket[];
  blockConcurrencyWhile<T>(callback: () => Promise<T>): Promise<T>;
};

export type Env = {
  HUSK_ROOMS: DurableObjectNamespace;
  HUSK_FILES: R2Bucket;
  HUSK_RATE_LIMIT: KVNamespace;
  HUSK_TICKET_SECRET: string;
  ALLOWED_ORIGINS: string;
};
