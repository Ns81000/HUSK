/** HTTP calls to the Husk Worker. The room key is never a parameter here. */

import { ROOM_ID_CHARS, ROOM_ID_LENGTH, WORKER_URL } from "./config";

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

/**
 * Room ids are 8 lowercase alphanumeric characters drawn from a CSPRNG with
 * rejection sampling, so every id is equally likely.
 */
export function generateRoomId(
  randomBytes: (length: number) => Uint8Array = (length) =>
    crypto.getRandomValues(new Uint8Array(length)),
): string {
  const range = ROOM_ID_CHARS.length;
  const limit = Math.floor(0x100000000 / range) * range;
  let id = "";
  while (id.length < ROOM_ID_LENGTH) {
    const bytes = randomBytes(4);
    const value =
      (((bytes[0] ?? 0) << 24) |
        ((bytes[1] ?? 0) << 16) |
        ((bytes[2] ?? 0) << 8) |
        (bytes[3] ?? 0)) >>>
      0;
    if (value < limit) {
      id += ROOM_ID_CHARS[value % range];
    }
  }
  return id;
}

/** Creates a room, transparently regenerating the id on a collision. */
export async function createRoom(maxAttempts = 5): Promise<string> {
  assertConfigured();
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const roomId = generateRoomId();
    const response = await fetch(`${WORKER_URL}/room/create`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ roomId }),
    });
    if (response.ok) {
      return roomId;
    }
    if (response.status !== 409) {
      throw new Error("Could not create a room");
    }
  }
  throw new Error("Could not allocate a free room id");
}

export type JoinResult =
  | { readonly ok: true; readonly roomId: string; readonly joinToken: string }
  | { readonly ok: false; readonly failure: JoinFailure };

export async function joinRoom(roomId: string): Promise<JoinResult> {
  assertConfigured();
  const response = await fetch(`${WORKER_URL}/room/join`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ roomId }),
  });
  if (response.ok) {
    // SAFETY: this route is our own Worker and returns this exact shape.
    const body = (await response.json()) as { joinToken?: unknown };
    if (typeof body.joinToken === "string" && body.joinToken.length > 0) {
      return { ok: true, roomId, joinToken: body.joinToken };
    }
    return { ok: false, failure: "unavailable" };
  }
  return {
    ok: false,
    failure: response.status === 429 ? "rate_limited" : "unavailable",
  };
}
