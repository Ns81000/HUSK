/**
 * Minimal ambient typings for the Cloudflare runtime bindings this Worker uses.
 * Kept local so the project does not need to vendor the full workers-types
 * package into the frontend build.
 */

export type DurableObjectId = { toString(): string };

export type DurableObjectStub = {
  fetch(request: Request): Promise<Response>;
};

export type DurableObjectNamespace = {
  idFromName(name: string): DurableObjectId;
  get(id: DurableObjectId): DurableObjectStub;
};

export type DurableObjectStorageListOptions = {
  prefix?: string;
  limit?: number;
  startAfter?: string;
};

export type DurableObjectStorage = {
  get<T>(key: string): Promise<T | undefined>;
  put<T>(key: string, value: T): Promise<void>;
  delete(keys: string | readonly string[]): Promise<boolean | number>;
  list<T>(options?: DurableObjectStorageListOptions): Promise<Map<string, T>>;
  deleteAll(): Promise<void>;
  setAlarm(scheduledTime: number): Promise<void>;
  getAlarm(): Promise<number | null>;
};

export type DurableObjectState = {
  storage: DurableObjectStorage;
  acceptWebSocket(socket: WebSocket, tags?: string[]): void;
  getWebSockets(tag?: string): WebSocket[];
  blockConcurrencyWhile<T>(callback: () => Promise<T>): Promise<T>;
};

export type Env = {
  HUSK_ROOMS: DurableObjectNamespace;
  HUSK_GATE: DurableObjectNamespace;
  HUSK_TICKET_SECRET: string;
  ALLOWED_ORIGINS: string;
};
