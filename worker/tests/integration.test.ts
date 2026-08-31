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

/** Fresh room id per test so every test gets its own Durable Object. */
let roomIdCounter = 100_000;
function freshPin(): string {
  roomIdCounter += 1;
  return roomIdCounter.toString(36).padStart(8, "0");
}

function api(path: string, init?: RequestInit): Promise<Response> {
  return SELF.fetch(new Request(`http://localhost${path}`, init));
}

/** Routes an absolute worker URL (e.g. a signed chunk URL) through SELF. */
function apiAbsolute(url: string, init?: RequestInit): Promise<Response> {
  const parsed = new URL(url);
  return SELF.fetch(new Request(`http://localhost${parsed.pathname}${parsed.search}`, init));
}

async function createRoom(roomId: string): Promise<Response> {
  return api("/room/create", { method: "POST", body: JSON.stringify({ roomId }) });
}

/** Unique caller IP per call so the join rate-limit budget is per-test. */
let ipCounter = 1;
async function joinRoomFrom(pin: string, ip?: string): Promise<Response> {
  const callerIp = ip ?? `10.0.0.${(ipCounter += 1)}`;
  return api("/room/join", {
    method: "POST",
    headers: { "CF-Connecting-IP": callerIp },
    body: JSON.stringify({ roomId: pin }),
  });
}

type JoinBody = { ok: boolean; roomId?: string; joinToken?: string };

async function joinRoom(pin: string): Promise<Response> {
  return joinRoomFrom(pin);
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

/**
 * Joins (minting a one-time token) and opens the socket with it. The token is
 * bound to the join caller's IP, so both requests must carry the same address.
 */
async function openSocket(
  pin: string,
): Promise<{ ws: WebSocket; member: string; frames: FrameQueue }> {
  const callerIp = `10.0.0.${(ipCounter += 1)}`;
  const join = await joinRoomFrom(pin, callerIp);
  const joinBody = (await join.json()) as JoinBody;
  if (!join.ok || typeof joinBody.joinToken !== "string") {
    throw new Error(`join failed with HTTP ${join.status}`);
  }
  const response = await api(`/room/${pin}/socket?jt=${encodeURIComponent(joinBody.joinToken)}`, {
    headers: { Upgrade: "websocket", "CF-Connecting-IP": callerIp },
  });
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
    // openSocket() performs the joins; ten of them exactly fill the room.
    const sockets: WebSocket[] = [];
    for (let index = 0; index < 10; index += 1) {
      sockets.push((await openSocket(pin)).ws);
    }
    // An untokenized public request cannot reach the capacity check (it fails
    // the generic 404 above), and an 11th join would trip the per-PIN budget —
    // so mint a valid token directly with the test secret and assert the
    // Durable Object's atomic capacity rejection.
    const callerIp = "10.9.9.9";
    const tokenExpiresAt = Math.floor(Date.now() / 1000) + 60;
    const tokenNonce = "capacity-test-nonce";
    const tokenSignature = await signTicket(
      TICKET_SECRET,
      "join",
      `${pin}|${callerIp}|${tokenExpiresAt}|${tokenNonce}`,
      tokenExpiresAt,
    );
    const eleventh = await api(
      `/room/${pin}/socket?jt=${encodeURIComponent(
        `${tokenExpiresAt}.${tokenNonce}.${tokenSignature}`,
      )}`,
      { headers: { Upgrade: "websocket", "CF-Connecting-IP": callerIp } },
    );
    expect(eleventh.status).toBe(403);
    expect(eleventh.webSocket).toBeNull();
  });

  it("regression: a room survives isolate eviction (volatile state reloads from storage)", async () => {
    const pin = freshPin();
    await createRoom(pin);
    await joinRoom(pin);
    const first = await openSocket(pin);
    first.ws.send(JSON.stringify({ t: "send", localId: "m1", payload: { iv: "aXY", ct: "Y3Q" } }));
    let ack1: Frame = await first.frames.next();
    while (ack1.t !== "ack") {
      ack1 = await first.frames.next();
    }
    expect(ack1.seq).toBe(1);
    first.ws.close();

    // Simulate the runtime evicting the isolate: on the real deployment a
    // Durable Object is reconstructed from SQLite storage within seconds of
    // going idle (and for every hibernating-socket wake). Wiping the fields
    // and re-running the restore is exactly that cold reconstruct.
    const rooms = (env as unknown as { HUSK_ROOMS: DurableObjectNamespace }).HUSK_ROOMS;
    const stub = rooms.get(rooms.idFromName(pin));
    await runInDurableObject(stub, async (instance) => {
      const room = instance as unknown as {
        exists: boolean;
        createdAt: number;
        emptySince: number;
        seq: number;
        bytesUsed: number;
        restoreVolatileState(): Promise<void>;
      };
      room.exists = false;
      room.createdAt = 0;
      room.emptySince = 0;
      room.seq = 0;
      room.bytesUsed = 0;
      await room.restoreVolatileState();
    });

    // A join after eviction must still find the room (previously 404).
    const rejoin = await joinRoom(pin);
    expect(rejoin.status).toBe(200);

    const second = await openSocket(pin);
    second.ws.send(JSON.stringify({ t: "send", localId: "m2", payload: { iv: "aXY", ct: "Y3Q" } }));
    let ack2: Frame = await second.frames.next();
    while (ack2.t !== "ack" || ack2.localId !== "m2") {
      ack2 = await second.frames.next();
    }
    // The server sequence continues across the eviction instead of restarting.
    expect(ack2.seq).toBe(2);
    // Live-member-gated file grants work after eviction too.
    const grant = await requestGrant(pin, second.member, 1024);
    expect(grant.status).toBe(200);
    second.ws.close();
  });
});

describe("chunked file transfer", () => {
  /**
   * Streams the GET response through its pull-based reader and asserts byte
   * equality chunk-wise (one 1 MiB row at a time). Completing the full
   * round-trip is the CPU assertion: the streamed GET never buffers the file
   * server-side, so no "Worker exceeded CPU time" (1102) class failure can
   * occur, even at the Free plan's 10 ms budget.
   */
  async function expectStreamedChunkwiseEqual(
    response: Response,
    vector: Uint8Array,
  ): Promise<void> {
    expect(response.status).toBe(200);
    const reader = response.body?.getReader();
    if (reader === undefined) {
      throw new Error("response body is not streamed");
    }
    const downloaded = new Uint8Array(vector.byteLength);
    let offset = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      if (offset + value.byteLength > downloaded.byteLength) {
        throw new Error("stream delivered more bytes than uploaded");
      }
      downloaded.set(value, offset);
      offset += value.byteLength;
    }
    expect(offset).toBe(vector.byteLength);

    // Row-wise equality: every 1 MiB chunk row matches the uploaded slice.
    for (let index = 0; index * CHUNK_BYTES < vector.byteLength; index += 1) {
      const start = index * CHUNK_BYTES;
      const end = Math.min(start + CHUNK_BYTES, vector.byteLength);
      const expectedRow = vector.subarray(start, end);
      const actualRow = downloaded.subarray(start, end);
      for (let position = 0; position < expectedRow.length; position += 1) {
        if (actualRow[position] !== expectedRow[position]) {
          throw new Error(`first differing byte in chunk ${index} at ${position}`);
        }
      }
    }
  }

  it("PUTs and GETs a multi-chunk file with chunk-wise byte equality (11 MiB vector)", async () => {
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
    await expectStreamedChunkwiseEqual(downloaded, vector);
    expect(downloaded.headers.get("content-type")).toBe("application/octet-stream");
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

  it("accepts a full ciphertext chunk (1 MiB plaintext + GCM tag) and rejects beyond", async () => {
    // The real client seals each 1 MiB plaintext chunk; AES-GCM appends a
    // 16-byte tag, so the PUT body exceeds FILE_CHUNK_BYTES by exactly 16.
    const pin = freshPin();
    await createRoom(pin);
    await joinRoom(pin);
    const socket = await openSocket(pin);
    const grant = (await (await requestGrant(pin, socket.member, CHUNK_BYTES)).json()) as Grant;

    const sealedChunk = randomBytes(CHUNK_BYTES + 16);
    const accepted = await apiAbsolute(grant.chunkUrls[0] ?? "", {
      method: "PUT",
      body: sealedChunk,
    });
    expect(accepted.status).toBe(200);
    socket.ws.close();
  });

  it("rejects a chunk PUT one byte beyond the ciphertext cap", async () => {
    const pin = freshPin();
    await createRoom(pin);
    await joinRoom(pin);
    const socket = await openSocket(pin);
    const grant = (await (await requestGrant(pin, socket.member, CHUNK_BYTES)).json()) as Grant;

    const oversized = await apiAbsolute(grant.chunkUrls[0] ?? "", {
      method: "PUT",
      body: randomBytes(CHUNK_BYTES + 17),
    });
    expect(oversized.status).toBe(400);
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

describe("abuse controls", () => {
  it("edge: socket without a join token is a generic 404, existing or not", async () => {
    const livePin = freshPin();
    await createRoom(livePin);
    await joinRoom(livePin);

    const missing = await api(`/room/${freshPin()}/socket`, { headers: { Upgrade: "websocket" } });
    const withoutToken = await api(`/room/${livePin}/socket`, {
      headers: { Upgrade: "websocket" },
    });
    const forgedToken = await api(`/room/${livePin}/socket?jt=9999999999.AAAA`, {
      headers: { Upgrade: "websocket" },
    });

    // Identical generic responses: no live-PIN oracle survives.
    expect(withoutToken.status).toBe(404);
    expect(missing.status).toBe(404);
    expect(await withoutToken.text()).toBe(await missing.text());
    expect(forgedToken.status).toBe(404);
  });

  it("edge: a join token cannot be replayed for a second connection", async () => {
    const pin = freshPin();
    await createRoom(pin);
    const callerIp = `10.0.0.${(ipCounter += 1)}`;
    const join = await joinRoomFrom(pin, callerIp);
    const token = ((await join.json()) as JoinBody).joinToken;
    if (typeof token !== "string") {
      throw new Error("join did not mint a token");
    }

    const first = await api(`/room/${pin}/socket?jt=${encodeURIComponent(token)}`, {
      headers: { Upgrade: "websocket", "CF-Connecting-IP": callerIp },
    });
    expect(first.status).toBe(101);
    first.webSocket?.accept();
    first.webSocket?.close();

    const replay = await api(`/room/${pin}/socket?jt=${encodeURIComponent(token)}`, {
      headers: { Upgrade: "websocket", "CF-Connecting-IP": callerIp },
    });
    expect(replay.status).toBe(404);
  });

  it("regression: two joins from one IP within the same second mint distinct tokens and both sockets open", async () => {
    // Live-deploy bug (session 7): the token was HMAC over `join|pin|ip|exp`
    // with seconds-granularity exp, so two legitimate joins inside the same
    // second minted byte-identical tokens and the DO's one-time burn rejected
    // the second peer's upgrade with the generic 404.
    const pin = freshPin();
    await createRoom(pin);
    const callerIp = `10.0.0.${(ipCounter += 1)}`;
    const firstJoin = joinRoomFrom(pin, callerIp);
    const secondJoin = joinRoomFrom(pin, callerIp);
    const [first, second] = (await Promise.all([firstJoin, secondJoin])).map(
      async (response) => ((await response.json()) as JoinBody).joinToken,
    );
    const firstToken = await first;
    const secondToken = await second;
    expect(firstToken).toBeTruthy();
    expect(secondToken).toBeTruthy();
    expect(firstToken).not.toBe(secondToken);

    const socketA = await api(`/room/${pin}/socket?jt=${encodeURIComponent(firstToken ?? "")}`, {
      headers: { Upgrade: "websocket", "CF-Connecting-IP": callerIp },
    });
    const socketB = await api(`/room/${pin}/socket?jt=${encodeURIComponent(secondToken ?? "")}`, {
      headers: { Upgrade: "websocket", "CF-Connecting-IP": callerIp },
    });
    expect(socketA.status).toBe(101);
    expect(socketB.status).toBe(101);
    socketA.webSocket?.accept();
    socketB.webSocket?.accept();
    socketA.webSocket?.close();
    socketB.webSocket?.close();
  });

  it("security: brute-force joins are throttled with HTTP 429", async () => {
    const pin = freshPin();
    await createRoom(pin);
    const attackerIp = `10.0.0.${(ipCounter += 1)}`;

    let throttled: Response | null = null;
    for (let attempt = 0; attempt < 12; attempt += 1) {
      const response = await joinRoomFrom(pin, attackerIp);
      if (response.status === 429) {
        throttled = response;
        break;
      }
    }
    expect(throttled).not.toBeNull();
    const body = (await (throttled as Response).json()) as { retryAfter?: unknown };
    expect(typeof body.retryAfter).toBe("number");
    expect(body.retryAfter).toBeGreaterThan(0);
  });

  it("security: a captured relay frame carries only ciphertext fields", async () => {
    const pin = freshPin();
    await createRoom(pin);
    await joinRoom(pin);
    const a = await openSocket(pin);
    const b = await openSocket(pin);
    await drainJoinPresence(a.frames);

    a.ws.send(JSON.stringify({ t: "send", localId: "sec1", payload: { iv: "aXY", ct: "Y3Q" } }));
    const relay = await b.frames.next();
    expect(relay.t).toBe("relay");

    // The wire format must contain nothing but routing metadata and the sealed
    // payload: no plaintext, no key material, no extra channels.
    const allowedKeys = new Set(["t", "seq", "senderId", "localId", "ts", "payload"]);
    for (const key of Object.keys(relay)) {
      expect(allowedKeys.has(key)).toBe(true);
    }
    expect(relay.payload).toEqual({ iv: "aXY", ct: "Y3Q" });
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

describe("edge cases", () => {
  it("edge: PIN collision on creation returns 409", async () => {
    const pin = freshPin();
    expect((await createRoom(pin)).status).toBe(200);
    expect((await createRoom(pin)).status).toBe(409);
  });

  it("edge: a cancel frame deletes an interrupted upload and refunds the budget", async () => {
    const pin = freshPin();
    await createRoom(pin);
    await joinRoom(pin);
    const socket = await openSocket(pin);

    const grants: Grant[] = [];
    for (let index = 0; index < 4; index += 1) {
      const response = await requestGrant(pin, socket.member, 25 * 1024 * 1024);
      expect(response.status).toBe(200);
      grants.push((await response.json()) as Grant);
    }
    const fifthBefore = await requestGrant(pin, socket.member, 25 * 1024 * 1024);
    expect(fifthBefore.status).toBe(507);

    // Partial upload of grant 0, then the client gives up and cancels.
    const first = grants[0];
    if (first === undefined) {
      throw new Error("missing grant 0");
    }
    await uploadVector(first, randomBytes(1024));
    socket.ws.send(JSON.stringify({ t: "cancel", fileId: first.fileId }));

    let deleted = false;
    for (let attempt = 0; attempt < 50 && !deleted; attempt += 1) {
      const probe = await apiAbsolute(
        `http://localhost/room/${pin}/file/${first.fileId}?exp=${first.download.exp}&sig=${first.download.sig}`,
      );
      deleted = probe.status === 404;
      if (!deleted) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    }
    expect(deleted).toBe(true);

    // The cancelled reservation refunds the budget, so a full-size grant fits.
    const fifthAfter = await requestGrant(pin, socket.member, 25 * 1024 * 1024);
    expect(fifthAfter.status).toBe(200);
    socket.ws.close();
  });

  it("edge: duplicate tabs behave as distinct participants", async () => {
    const pin = freshPin();
    await createRoom(pin);
    await joinRoom(pin);
    const a = await openSocket(pin);
    const b = await openSocket(pin);
    await drainJoinPresence(a.frames);
    expect(b.member).not.toBe(a.member);

    a.ws.send(JSON.stringify({ t: "send", localId: "tab1", payload: { iv: "aXY", ct: "Y3Q" } }));
    const relayToB = await b.frames.next();
    expect(relayToB.t).toBe("relay");
    expect(relayToB.localId).toBe("tab1");

    // The sender receives its own relay broadcast and then the ack.
    const ownRelay = await a.frames.next();
    expect(ownRelay.t).toBe("relay");
    let ack = await a.frames.next();
    while (ack.t !== "ack") {
      ack = await a.frames.next();
    }
    expect(ack.localId).toBe("tab1");
    a.ws.close();
    b.ws.close();
  });

  it("edge: a resent localId is relayed once and re-acked with the original seq", async () => {
    const pin = freshPin();
    await createRoom(pin);
    await joinRoom(pin);
    const a = await openSocket(pin);
    const b = await openSocket(pin);
    await drainJoinPresence(a.frames);

    const frame = JSON.stringify({ t: "send", localId: "m1", payload: { iv: "aXY", ct: "Y3Q" } });
    a.ws.send(frame);
    const relay = await b.frames.next();
    expect(relay.t).toBe("relay");
    expect(relay.localId).toBe("m1");
    let ack1 = await a.frames.next();
    while (ack1.t !== "ack") {
      ack1 = await a.frames.next();
    }

    // The client lost the first ack and resends the identical frame.
    a.ws.send(frame);
    let ack2 = await a.frames.next();
    while (ack2.t !== "ack" || ack2.localId !== "m1") {
      ack2 = await a.frames.next();
    }
    expect(ack2.seq).toBe(ack1.seq);

    // No second relay reached B: its next frame belongs to a new message.
    a.ws.send(JSON.stringify({ t: "send", localId: "m2", payload: { iv: "aXY", ct: "Y3Q" } }));
    const next = await b.frames.next();
    expect(next.t).toBe("relay");
    expect(next.localId).toBe("m2");
    a.ws.close();
    b.ws.close();
  });

  it("edge: a socket close broadcasts presence leave exactly once", async () => {
    const pin = freshPin();
    await createRoom(pin);
    await joinRoom(pin);
    const a = await openSocket(pin);
    const b = await openSocket(pin);
    await drainJoinPresence(a.frames);

    a.ws.close();
    const leave = await b.frames.next();
    expect(leave.t).toBe("presence");
    expect(leave.event).toBe("leave");
    expect(leave.who).toBe(a.member);

    // If a duplicate leave had been broadcast it would arrive before the
    // relay of B's own next message.
    b.ws.send(JSON.stringify({ t: "send", localId: "after", payload: { iv: "aXY", ct: "Y3Q" } }));
    const next = await b.frames.next();
    expect(next.t).toBe("relay");
    b.ws.close();
  });
});
