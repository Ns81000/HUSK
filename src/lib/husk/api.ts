/** HTTP calls to the Husk Worker. The room key is never a parameter here. */

import { WORKER_URL } from "./config";
import { generatePin } from "./pin";

export class WorkerNotConfiguredError extends Error {
  constructor() {
    super("Worker URL is not configured");
    this.name = "WorkerNotConfiguredError";
  }
}

export type JoinFailure = "unavailable" | "rate_limited";

function assertConfigured(): void {
  if (WORKER_URL.length === 0) {
    throw new WorkerNotConfiguredError();
  }
}

/** Creates a room, transparently regenerating the PIN on a collision. */
export async function createRoom(maxAttempts = 5): Promise<string> {
  assertConfigured();
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const pin = generatePin();
    const response = await fetch(`${WORKER_URL}/room/create`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ pin }),
    });
    if (response.ok) {
      return pin;
    }
    if (response.status !== 409) {
      throw new Error("Could not create a room");
    }
  }
  throw new Error("Could not allocate a free PIN");
}

export async function joinRoom(pin: string): Promise<JoinFailure | null> {
  assertConfigured();
  const response = await fetch(`${WORKER_URL}/room/join`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ pin }),
  });
  if (response.ok) {
    return null;
  }
  return response.status === 429 ? "rate_limited" : "unavailable";
}
