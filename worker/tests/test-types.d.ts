/// <reference types="@cloudflare/vitest-pool-workers/types" />

/**
 * Minimal global declarations so the "cloudflare:test" module types resolve
 * without pulling the full @cloudflare/workers-types package into the worker
 * build (worker src keeps its own ambient bindings in src/types.ts).
 */

declare interface Fetcher {
  fetch(request: Request): Promise<Response>;
}

declare class DurableObject {}

declare interface DurableObjectStub<O = unknown> {
  fetch(request: Request): Promise<Response>;
}

declare type DurableObjectId = { toString(): string };

declare interface DurableObjectNamespace<T = unknown> {
  idFromName(name: string): DurableObjectId;
  get(id: DurableObjectId): DurableObjectStub;
}

declare interface DurableObjectState {
  storage: {
    get<T>(key: string): Promise<T | undefined>;
    put<T>(key: string, value: T): Promise<void>;
    delete(key: string | string[]): Promise<boolean | number>;
    list<T>(options?: { prefix?: string }): Promise<Map<string, T>>;
    deleteAll(): Promise<void>;
    setAlarm(scheduledTime: number): Promise<void>;
    getAlarm(): Promise<number | null>;
  };
}

declare namespace Cloudflare {
  interface Env {
    HUSK_ROOMS: DurableObjectNamespace;
    HUSK_GATE: DurableObjectNamespace;
    HUSK_TICKET_SECRET: string;
    ALLOWED_ORIGINS: string;
  }
}

interface Response {
  readonly webSocket: WebSocket | null;
}
