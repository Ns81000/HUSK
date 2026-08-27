/**
 * Integration tests through the real Worker routes, running in workerd via
 * @cloudflare/vitest-pool-workers. These exercise what the browser actually
 * does: create/join, WebSocket relay, chunked file upload/download and the
 * abuse controls around them.
 */

import { SELF, env, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { signTicket } from "../src/tickets";
import type { DurableObjectNamespace } from "../src/types";

const TICKET_SECRET = "integration-test-secret";
const CHUNK_BYTES = 1024 * 1024;

/** Fresh PIN per test so every test gets its own Durable Object. */
let pinCounter = 100_000;
function freshPin(): string {
  pinCounter += 1;
  return String(pinCounter);
}

function api(path: string, init?: RequestInit): Promise<Response> {
  return SELF.fetch(new Request(`http://localhost${path}`, init));
}

/** Routes an absolute worker URL (e.g. a signed chunk URL) through SELF. */
function apiAbsolute(url: string, init?: RequestInit): Promise<Response> {
  const parsed = new URL(url);
  return SELF.fetch(new Request(`http://localhost${parsed.pathname}${parsed.search}`, init));
}

async function createRoom(pin: string): Promise<Response> {
  return api("/room/create", { method: "POST", body: JSON.stringify({ pin }) });
}

/** Unique caller IP per call so the join rate-limit budget is per-test. */
let ipCounter = 1;
async function joinRoom(pin: string): Promise<Response> {
  ipCounter += 1;
  return api("/room/join", {
    method: "POST",
    headers: { "CF-Connecting-IP": `10.0.0.${ipCounter}` },
    body: JSON.stringify({ pin }),
  });
}

type Frame = { t: string } & Record<string, unknown>;

/** Persists every incoming frame, so none is lost between awaits. */
class FrameQueue {
  private readonly frames: Frame[] = [];
  private readonly waiting: ((frame: Frame) => void)[] = [];

  constructor(ws: WebSocket) {
    ws.addEventListener("message", (event) => {
      const frame = JSON.parse(String(event.data)) as Frame;
      const resolve = this.waiting.shift();
      if (resolve !== undefined) {
        resolve(frame);
      } else {
        this.frames.push(frame);
      }
    });
  }

  next(): Promise<Frame> {
    const queued = this.frames.shift();
    if (queued !== undefined) {
      return Promise.resolve(queued);
    }
    return new Promise((resolve) => this.waiting.push(resolve));
  }
}

async function openSocket(
  pin: string,
): Promise<{ ws: WebSocket; member: string; frames: FrameQueue }> {
  const response = await api(`/room/${pin}/socket`, { headers: { Upgrade: "websocket" } });
  if (response.webSocket === null) {
    throw new Error(`socket handshake failed with HTTP ${response.status}`);
  }
  const ws = response.webSocket;
  const frames = new FrameQueue(ws);
  ws.accept();
  const welcome = await frames.next();
  if (welcome.t !== "welcome") {
    throw new Error(`expected welcome, got ${String(welcome.t)}`);
  }
  return { ws, member: String(welcome.you), frames };
}

/** Consumes the presence-join frame a socket receives when another peer connects. */
async function drainJoinPresence(frames: FrameQueue): Promise<void> {
  const frame = await frames.next();
  if (frame.t !== "presence" || frame.event !== "join") {
    throw new Error(`expected presence join, got ${JSON.stringify(frame)}`);
  }
}

type Grant = { fileId: string; chunkUrls: string[]; download: { exp: number; sig: string } };

async function requestGrant(pin: string, member: string, size: number): Promise<Response> {
  return api(`/room/${pin}/file`, {
    method: "POST",
    body: JSON.stringify({ size, member }),
  });
}

async function uploadVector(grant: Grant, vector: Uint8Array<ArrayBuffer>): Promise<void> {
  const chunks = Math.ceil(vector.byteLength / CHUNK_BYTES);
  for (let index = 0; index < chunks; index += 1) {
    const slice = vector.subarray(index * CHUNK_BYTES, (index + 1) * CHUNK_BYTES);
    const chunkUrl = grant.chunkUrls[index];
    if (chunkUrl === undefined) {
      throw new Error(`missing chunk URL for index ${index}`);
    }
    const response = await apiAbsolute(chunkUrl, {
      method: "PUT",
      body: slice,
    });
    expect(response.status).toBe(200);
  }
}

function randomBytes(total: number): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(total);
  let offset = 0;
  while (offset < total) {
    const fill = Math.min(65_536, total - offset);
    crypto.getRandomValues(out.subarray(offset, offset + fill));
    offset += fill;
  }
  return out;
}

function expectBytesEqual(actual: Uint8Array, expected: Uint8Array): void {
  expect(actual.byteLength).toBe(expected.byteLength);
  for (let index = 0; index < expected.length; index += 1) {
    if (actual[index] !== expected[index]) {
      throw new Error(`first differing byte at ${index}`);
    }
  }
}

let member = "";

beforeAll(async () => {
  const pin = freshPin();
  await createRoom(pin);
  await joinRoom(pin);
  const socket = await openSocket(pin);
  member = socket.member;
  socket.ws.close();
});

describe("room lifecycle and relay", () => {
  it("relays a sealed frame between two peers and acks the sender", async () => {
    const pin = freshPin();
    await createRoom(pin);
    await joinRoom(pin);
    const a = await openSocket(pin);
    const b = await openSocket(pin);
    await drainJoinPresence(a.frames);

    a.ws.send(JSON.stringify({ t: "send", localId: "m1", payload: { iv: "aXY", ct: "Y3Q" } }));

    const relay = await b.frames.next();
    expect(relay.t).toBe("relay");
    expect(relay.localId).toBe("m1");
    expect(relay.senderId).toBe(a.member);
    expect(relay.payload).toEqual({ iv: "aXY", ct: "Y3Q" });

    // The sender also receives its own relay broadcast before the ack.
    let ack: Frame = await a.frames.next();
    while (ack.t !== "ack") {
      ack = await a.frames.next();
    }
    expect(ack.localId).toBe("m1");
    expect(typeof ack.seq).toBe("number");
  });

  it("edge: simultaneous join at capacity is rejected", async () => {
    const pin = freshPin();
    await createRoom(pin);
    await joinRoom(pin);
    const sockets: WebSocket[] = [];
    for (let index = 0; index < 10; index += 1) {
      sockets.push((await openSocket(pin)).ws);
    }
    const eleventh = await api(`/room/${pin}/socket`, { headers: { Upgrade: "websocket" } });
    expect(eleventh.status).toBe(403);
    expect(eleventh.webSocket).toBeNull();
  });
});

describe("chunked file transfer", () => {
  it("PUTs and GETs a multi-chunk file with byte equality (11 MiB vector)", async () => {
    const pin = freshPin();
    await createRoom(pin);
    await joinRoom(pin);
    const socket = await openSocket(pin);

    const vector = randomBytes(11 * CHUNK_BYTES + 123);
    const grantResponse = await requestGrant(pin, socket.member, vector.byteLength);
    expect(grantResponse.status).toBe(200);
    const grant = (await grantResponse.json()) as Grant;
    expect(grant.chunkUrls.length).toBe(12);

    await uploadVector(grant, vector);

    const downloaded = await apiAbsolute(
      `http://localhost/room/${pin}/file/${grant.fileId}?exp=${grant.download.exp}&sig=${grant.download.sig}`,
    );
    expect(downloaded.status).toBe(200);
    expect(downloaded.headers.get("content-type")).toBe("application/octet-stream");
    expectBytesEqual(new Uint8Array(await downloaded.arrayBuffer()), vector);
    socket.ws.close();
  });

  it("rejects a chunk PUT with a forged signature", async () => {
    const pin = freshPin();
    await createRoom(pin);
    await joinRoom(pin);
    const socket = await openSocket(pin);
    const grant = (await (await requestGrant(pin, socket.member, 1024)).json()) as Grant;

    const forged = await apiAbsolute(
      `http://localhost/room/${pin}/file/${grant.fileId}/0?exp=${grant.download.exp}&sig=${"A".repeat(43)}`,
      { method: "PUT", body: randomBytes(1024) },
    );
    expect(forged.status).toBe(403);
    socket.ws.close();
  });

  it("rejects an expired chunk ticket", async () => {
    const pin = freshPin();
    await createRoom(pin);
    await joinRoom(pin);
    const socket = await openSocket(pin);
    const grant = (await (await requestGrant(pin, socket.member, 1024)).json()) as Grant;

    const expiredAt = Math.floor(Date.now() / 1000) - 10;
    const expiredSig = await signTicket(
      TICKET_SECRET,
      "chunk",
      `${pin}/${grant.fileId}/0`,
      expiredAt,
    );
    const response = await apiAbsolute(
      `http://localhost/room/${pin}/file/${grant.fileId}/0?exp=${expiredAt}&sig=${expiredSig}`,
      { method: "PUT", body: randomBytes(1024) },
    );
    expect(response.status).toBe(403);
    socket.ws.close();
  });

  it("rejects a replayed chunk PUT (single-use)", async () => {
    const pin = freshPin();
    await createRoom(pin);
    await joinRoom(pin);
    const socket = await openSocket(pin);
    const grant = (await (await requestGrant(pin, socket.member, 1024)).json()) as Grant;

    const firstChunkUrl = grant.chunkUrls[0];
    if (firstChunkUrl === undefined) {
      throw new Error("missing chunk URL 0");
    }
    const first = await apiAbsolute(firstChunkUrl, {
      method: "PUT",
      body: randomBytes(1024),
    });
    expect(first.status).toBe(200);

    const replay = await apiAbsolute(firstChunkUrl, {
      method: "PUT",
      body: randomBytes(1024),
    });
    expect(replay.status).toBe(409);
    socket.ws.close();
  });

  it("rejects a file grant without live room membership", async () => {
    const pin = freshPin();
    await createRoom(pin);
    await joinRoom(pin);
    const response = await requestGrant(pin, "00000000-0000-4000-8000-000000000000", 1024);
    expect(response.status).toBe(403);
  });

  it("enforces the per-room file byte budget", async () => {
    const pin = freshPin();
    await createRoom(pin);
    await joinRoom(pin);
    const socket = await openSocket(pin);

    // 4 x 25 MB exactly fills the 100 MB room budget; the 5th is refused.
    for (let index = 0; index < 4; index += 1) {
      const response = await requestGrant(pin, socket.member, 25 * 1024 * 1024);
      expect(response.status).toBe(200);
    }
    const fifth = await requestGrant(pin, socket.member, 25 * 1024 * 1024);
    expect(fifth.status).toBe(507);
    socket.ws.close();
  });

  it("rejects an unsigned file GET", async () => {
    const pin = freshPin();
    await createRoom(pin);
    await joinRoom(pin);
    const socket = await openSocket(pin);
    const grant = (await (await requestGrant(pin, socket.member, 1024)).json()) as Grant;

    const response = await api(`/room/${pin}/file/${grant.fileId}`);
    expect(response.status).toBe(403);
    socket.ws.close();
  });
});

describe("room closure", () => {
  it("alarm purge removes stored file rows and closes the room", async () => {
    const pin = freshPin();
    await createRoom(pin);
    await joinRoom(pin);
    const socket = await openSocket(pin);
    const grant = (await (await requestGrant(pin, socket.member, 4096)).json()) as Grant;
    await uploadVector(grant, randomBytes(4096));
    socket.ws.close();

    // Drive the room Durable Object's alarm directly: push the idle deadline
    // into the past inside the live instance, then run its real alarm handler.
    const rooms = (env as unknown as { HUSK_ROOMS: DurableObjectNamespace }).HUSK_ROOMS;
    const stub = rooms.get(rooms.idFromName(pin));
    await runInDurableObject(stub, (instance) => {
      (instance as unknown as { emptySince: number }).emptySince = Date.now() - 31 * 60 * 1000;
    });
    const ran = await runDurableObjectAlarm(stub);
    expect(ran).toBe(true);

    const joinAfter = await joinRoom(pin);
    expect(joinAfter.status).toBe(404);

    const getAfter = await apiAbsolute(
      `http://localhost/room/${pin}/file/${grant.fileId}?exp=${grant.download.exp}&sig=${grant.download.sig}`,
    );
    expect(getAfter.status).toBe(404);
  });
});
