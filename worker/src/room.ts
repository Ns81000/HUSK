/**
 * HuskRoom Durable Object.
 *
 * One instance per active PIN. Holds every piece of room state in memory:
 * participants, the monotonic sequence counter and the room's deadlines. It
 * relays opaque ciphertext between sockets and can never decrypt anything,
 * because the room key is never sent to the server.
 *
 * Encrypted file chunks live in this object's SQLite storage as 1 MiB rows
 * (`file:<fileId>:<n>`), so they die with the room's alarm purge without any
 * separate bucket or lifecycle rule.
 *
 * Closure is driven only by the alarm below — never by a client-side cleanup
 * call — so a crashed host cannot leave a room alive.
 */

import {
  ALARM_INTERVAL_MS,
  CIPHER_OVERHEAD_BYTES,
  FILE_BYTES_USED_KEY,
  FILE_CHUNK_BYTES,
  FILE_META_PREFIX,
  FILE_ROW_PREFIX,
  MAX_FILE_BYTES,
  MAX_PARTICIPANTS,
  MAX_ROOM_FILE_BYTES,
  ROOM_IDLE_TIMEOUT_MS,
  ROOM_MAX_LIFETIME_MS,
  ROOM_STATE_KEY,
  TICKET_TTL_SECONDS,
} from "./config";
import { signTicket, verifyTicket } from "./tickets";
import type { DurableObjectState, Env } from "./types";

type Participant = { id: string; joinedAt: number };

type Attachment = { id: string; joinedAt: number };

type FileMeta = { size: number; chunks: number; createdAt: number };

/**
 * Lifecycle state that must survive isolate eviction: on the real runtime a
 * Durable Object is reconstructed from SQLite storage within seconds of going
 * idle (and for every hibernating-socket wake), so anything held only in a
 * field is lost. `exists` is the presence of this row.
 */
type PersistedRoomState = {
  createdAt: number;
  emptySince: number;
  seq: number;
};

type ClientFrame =
  | { t: "ping" }
  | { t: "send"; localId: string; payload: { iv: string; ct: string } }
  | { t: "cancel"; fileId: string };

/** Boundary parser for frames arriving from a browser. */
function parseClientFrame(data: string | ArrayBuffer): ClientFrame | null {
  let decoded: {
    t?: string;
    localId?: string;
    payload?: { iv?: string; ct?: string };
    fileId?: string;
  };
  try {
    // SAFETY: every field is validated below before the frame is used.
    decoded = JSON.parse(String(data)) as typeof decoded;
  } catch {
    return null;
  }
  if (decoded.t === "ping") {
    return { t: "ping" };
  }
  if (decoded.t === "cancel") {
    const fileId = String(decoded.fileId ?? "");
    if (fileId === "") {
      return null;
    }
    return { t: "cancel", fileId };
  }
  const localId = String(decoded.localId ?? "");
  const iv = String(decoded.payload?.iv ?? "");
  const ct = String(decoded.payload?.ct ?? "");
  if (decoded.t !== "send" || localId === "" || iv === "" || ct === "") {
    return null;
  }
  return { t: "send", localId, payload: { iv, ct } };
}

export class HuskRoom {
  private seq = 0;
  private createdAt = 0;
  private emptySince = 0;
  private exists = false;
  private bytesUsed = 0;
  /** Serialises every mutation of bytesUsed so the budget check is atomic. */
  private fileOpQueue: Promise<void> = Promise.resolve();
  /** Recent (socketId, localId) -> seq, so a resend after a lost ack is deduplicated. */
  private recentSends = new Map<string, number>();
  private static readonly RECENT_SENDS_LIMIT = 500;
  /** Sockets whose close has already been handled (error and close may both fire). */
  private readonly closeHandled = new WeakSet<WebSocket>();

  constructor(
    private readonly state: DurableObjectState,
    private readonly env: Env,
  ) {
    // Load persisted state before any fetch is served so a reconstructed
    // instance (isolate eviction, hibernating-socket wake) behaves exactly
    // like the one that created the room.
    void this.state.blockConcurrencyWhile(async () => {
      await this.restoreVolatileState();
    });
  }

  /**
   * Loads every field that would otherwise be lost on eviction. Public to the
   * test harness (invoked directly to simulate a cold reconstruct).
   */
  private async restoreVolatileState(): Promise<void> {
    const storedBytes = await this.state.storage.get<number>(FILE_BYTES_USED_KEY);
    this.bytesUsed = storedBytes ?? 0;
    const persisted = await this.state.storage.get<PersistedRoomState>(ROOM_STATE_KEY);
    if (persisted !== undefined) {
      this.exists = true;
      this.createdAt = persisted.createdAt;
      this.emptySince = persisted.emptySince;
      this.seq = persisted.seq;
    }
  }

  /** Writes the lifecycle fields that may have changed back to storage. */
  private persistState(): Promise<void> {
    return this.state.storage.put(ROOM_STATE_KEY, {
      createdAt: this.createdAt,
      emptySince: this.emptySince,
      seq: this.seq,
    } satisfies PersistedRoomState);
  }

  private participants(): Participant[] {
    return this.state
      .getWebSockets()
      .map((socket) => {
        const raw = socket.deserializeAttachment<Attachment>();
        return raw === null ? null : { id: raw.id, joinedAt: raw.joinedAt };
      })
      .filter((value): value is Participant => value !== null);
  }

  /** Membership capability: a participant id of a currently connected socket. */
  private isLiveMember(memberId: string): boolean {
    return this.state
      .getWebSockets()
      .some((socket) => socket.deserializeAttachment<Attachment>()?.id === memberId);
  }

  private broadcast<T>(payload: T, except?: WebSocket): void {
    const body = JSON.stringify(payload);
    for (const socket of this.state.getWebSockets()) {
      if (socket === except) {
        continue;
      }
      try {
        socket.send(body);
      } catch {
        // A dead socket is closed by the runtime; nothing to recover here.
      }
    }
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname.endsWith("/create") || url.pathname.endsWith("/join")) {
      const creating = url.pathname.endsWith("/create");
      if (creating && this.exists) {
        return Response.json({ error: "pin_taken" }, { status: 409 });
      }
      if (!creating && !this.exists) {
        // Generic error: never reveal whether a PIN exists.
        return Response.json({ error: "unavailable" }, { status: 404 });
      }
      if (creating) {
        this.exists = true;
        this.createdAt = Date.now();
        this.emptySince = Date.now();
        this.recentSends.clear();
        await this.state.storage.setAlarm(Date.now() + ALARM_INTERVAL_MS);
        await this.persistState();
      }
      if (this.participants().length >= MAX_PARTICIPANTS) {
        return Response.json({ error: "unavailable" }, { status: 403 });
      }
      return Response.json({ ok: true, expiresAt: this.expiresAt() });
    }

    if (url.pathname.endsWith("/socket")) {
      if (request.headers.get("Upgrade") !== "websocket") {
        return new Response("Expected websocket", { status: 426 });
      }
      // Every failure below stays a generic 404 so the socket route never
      // becomes a room-existence or token-validity oracle.
      const ip = request.headers.get("x-husk-ip") ?? "unknown";
      const token = request.headers.get("x-husk-join-token") ?? "";
      const dotAt = token.indexOf(".");
      const tokenExpiresAt = dotAt === -1 ? Number.NaN : Number(token.slice(0, dotAt));
      const tokenSignature = dotAt === -1 ? "" : token.slice(dotAt + 1);
      const pin = url.pathname.split("/")[2] ?? "";
      const tokenValid =
        dotAt !== -1 &&
        (await verifyTicket(
          this.env.HUSK_TICKET_SECRET,
          "join",
          `${pin}|${ip}|${tokenExpiresAt}`,
          tokenExpiresAt,
          tokenSignature,
          Date.now(),
        ));
      if (!tokenValid) {
        return new Response("unavailable", { status: 404 });
      }
      // Burn the one-time token: a consumed signature is remembered until the
      // room's storage is purged, so a replayed join token is worthless.
      const burnKey = `jt:${tokenSignature}`;
      if ((await this.state.storage.get(burnKey)) !== undefined) {
        return new Response("unavailable", { status: 404 });
      }
      await this.state.storage.put(burnKey, Date.now());
      if (!this.exists) {
        return new Response("unavailable", { status: 404 });
      }
      if (this.participants().length >= MAX_PARTICIPANTS) {
        // Atomic: the check and the accept happen in the same synchronous
        // handler inside a single-threaded Durable Object.
        return new Response("room_full", { status: 403 });
      }

      const pair = new WebSocketPair();
      const client = pair[0];
      const server = pair[1];
      const id = crypto.randomUUID();
      const joinedAt = Date.now();

      this.state.acceptWebSocket(server);
      server.serializeAttachment({ id, joinedAt } satisfies Attachment);
      this.emptySince = 0;
      await this.persistState();

      server.send(
        JSON.stringify({
          t: "welcome",
          you: id,
          participants: this.participants(),
          seq: this.seq,
          expiresAt: this.expiresAt(),
        }),
      );
      this.broadcast(
        {
          t: "presence",
          event: "join",
          who: id,
          participants: this.participants(),
        },
        server,
      );

      return new Response(null, { status: 101, webSocket: client });
    }

    const initMatch = /^\/room\/([1-9][0-9]{5})\/file$/.exec(url.pathname);
    if (initMatch && request.method === "POST") {
      return this.handleFileInit(request, initMatch[1] ?? "");
    }

    const chunkMatch = /^\/room\/([1-9][0-9]{5})\/file\/([0-9a-f-]{36})\/(\d+)$/.exec(url.pathname);
    if (chunkMatch && request.method === "PUT") {
      return this.handleChunkPut(
        url,
        request,
        chunkMatch[1] ?? "",
        chunkMatch[2] ?? "",
        Number(chunkMatch[3]),
      );
    }

    const getMatch = /^\/room\/([1-9][0-9]{5})\/file\/([0-9a-f-]{36})$/.exec(url.pathname);
    if (getMatch && request.method === "GET") {
      return this.handleFileGet(url, getMatch[1] ?? "", getMatch[2] ?? "");
    }

    return new Response("not_found", { status: 404 });
  }

  private async handleFileInit(request: Request, pin: string): Promise<Response> {
    // Reserve/cancel mutate the shared byte counter; chaining them keeps the
    // read-check-write sequence free of interleaved concurrent requests.
    const run = () => this.reserveFileStorage(request, pin);
    const result = this.fileOpQueue.then(run, run);
    this.fileOpQueue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private async reserveFileStorage(request: Request, pin: string): Promise<Response> {
    if (!this.exists) {
      return Response.json({ error: "unavailable" }, { status: 404 });
    }
    let body: { size?: unknown; member?: unknown };
    try {
      // SAFETY: the fields are coerced and validated below before any use.
      body = (await request.json()) as { size?: unknown; member?: unknown };
    } catch {
      return Response.json({ error: "bad_request" }, { status: 400 });
    }
    const size = Number(body.size);
    const member = String(body.member ?? "");
    if (!Number.isFinite(size) || size <= 0 || size > MAX_FILE_BYTES) {
      return Response.json({ error: "bad_request" }, { status: 400 });
    }
    if (!this.isLiveMember(member)) {
      // Only a holder of a live participant id may reserve file storage.
      return Response.json({ error: "forbidden" }, { status: 403 });
    }
    if (this.bytesUsed + size > MAX_ROOM_FILE_BYTES) {
      return Response.json({ error: "room_file_budget" }, { status: 507 });
    }

    const fileId = crypto.randomUUID();
    const chunks = Math.max(1, Math.ceil(size / FILE_CHUNK_BYTES));
    await this.state.storage.put(`${FILE_META_PREFIX}${fileId}`, {
      size,
      chunks,
      createdAt: Date.now(),
    } satisfies FileMeta);
    this.bytesUsed += size;
    await this.state.storage.put(FILE_BYTES_USED_KEY, this.bytesUsed);

    const putExpiresAt = Math.floor(Date.now() / 1000) + TICKET_TTL_SECONDS;
    const chunkSigs: string[] = [];
    for (let index = 0; index < chunks; index += 1) {
      chunkSigs.push(
        await signTicket(
          this.env.HUSK_TICKET_SECRET,
          "chunk",
          `${pin}/${fileId}/${index}`,
          putExpiresAt,
        ),
      );
    }
    // The download capability is relayed to peers inside the encrypted message
    // body, so it can live until the room's own storage is purged.
    const getExpiresAt = Math.floor(this.expiresAt() / 1000);
    const getSig = await signTicket(
      this.env.HUSK_TICKET_SECRET,
      "get",
      `${pin}/${fileId}`,
      getExpiresAt,
    );
    return Response.json({
      fileId,
      chunks,
      putExpiresAt,
      chunkSigs,
      getExpiresAt,
      getSig,
    });
  }

  private async handleChunkPut(
    url: URL,
    request: Request,
    pin: string,
    fileId: string,
    index: number,
  ): Promise<Response> {
    const expiresAt = Number(url.searchParams.get("exp"));
    const signature = url.searchParams.get("sig") ?? "";
    const valid = await verifyTicket(
      this.env.HUSK_TICKET_SECRET,
      "chunk",
      `${pin}/${fileId}/${index}`,
      expiresAt,
      signature,
      Date.now(),
    );
    if (!valid) {
      return Response.json({ error: "forbidden" }, { status: 403 });
    }
    const meta = await this.state.storage.get<FileMeta>(`${FILE_META_PREFIX}${fileId}`);
    if (meta === undefined || index >= meta.chunks) {
      return Response.json({ error: "not_found" }, { status: 404 });
    }
    const key = `${FILE_ROW_PREFIX}${fileId}:${index}`;
    if ((await this.state.storage.get(key)) !== undefined) {
      // Single-use: an existing row is immutable, so a replay cannot overwrite
      // bytes. The client treats 409 as success for its own retry path.
      return Response.json({ error: "chunk_exists" }, { status: 409 });
    }
    const body = await request.arrayBuffer();
    if (body.byteLength === 0 || body.byteLength > FILE_CHUNK_BYTES + CIPHER_OVERHEAD_BYTES) {
      return Response.json({ error: "bad_request" }, { status: 400 });
    }
    await this.state.storage.put(key, body);
    return Response.json({ ok: true });
  }

  private async handleFileGet(url: URL, pin: string, fileId: string): Promise<Response> {
    const expiresAt = Number(url.searchParams.get("exp"));
    const signature = url.searchParams.get("sig") ?? "";
    const valid = await verifyTicket(
      this.env.HUSK_TICKET_SECRET,
      "get",
      `${pin}/${fileId}`,
      expiresAt,
      signature,
      Date.now(),
    );
    if (!valid) {
      return Response.json({ error: "forbidden" }, { status: 403 });
    }
    const meta = await this.state.storage.get<FileMeta>(`${FILE_META_PREFIX}${fileId}`);
    if (meta === undefined) {
      return Response.json({ error: "not_found" }, { status: 404 });
    }
    // Pull-based streaming: one 1 MiB row is read from storage per pull, so a
    // large download never buffers the whole file (Free-plan CPU/memory cap).
    const storage = this.state.storage;
    let index = 0;
    const stream = new ReadableStream<Uint8Array>({
      async pull(controller) {
        if (index >= meta.chunks) {
          controller.close();
          return;
        }
        const row = await storage.get<ArrayBuffer>(`${FILE_ROW_PREFIX}${fileId}:${index}`);
        index += 1;
        if (row === undefined) {
          controller.error(new Error("missing chunk"));
          return;
        }
        controller.enqueue(new Uint8Array(row));
      },
    });
    return new Response(stream, {
      headers: { "content-type": "application/octet-stream" },
    });
  }

  private deleteFileRows(fileId: string): Promise<void> {
    const run = () => this.deleteFileRowsNow(fileId);
    const result = this.fileOpQueue.then(run, run);
    this.fileOpQueue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private async deleteFileRowsNow(fileId: string): Promise<void> {
    const metaKey = `${FILE_META_PREFIX}${fileId}`;
    const meta = await this.state.storage.get<FileMeta>(metaKey);
    if (meta === undefined) {
      return;
    }
    const rows = await this.state.storage.list({
      prefix: `${FILE_ROW_PREFIX}${fileId}:`,
    });
    await this.state.storage.delete([...rows.keys(), metaKey]);
    this.bytesUsed = Math.max(0, this.bytesUsed - meta.size);
    await this.state.storage.put(FILE_BYTES_USED_KEY, this.bytesUsed);
  }

  private expiresAt(): number {
    return this.createdAt + ROOM_MAX_LIFETIME_MS;
  }

  async webSocketMessage(socket: WebSocket, data: string | ArrayBuffer) {
    const frame = parseClientFrame(data);
    if (frame === null) {
      socket.send(JSON.stringify({ t: "error", code: "bad_request" }));
      return;
    }

    if (frame.t === "ping") {
      socket.send(JSON.stringify({ t: "pong" }));
      return;
    }

    const attachment = socket.deserializeAttachment<Attachment>();
    if (attachment === null) {
      return;
    }

    if (frame.t === "cancel") {
      // Interrupted-upload cleanup: drop this file's rows and free the budget.
      await this.deleteFileRows(frame.fileId);
      return;
    }

    const dedupeKey = `${attachment.id}:${frame.localId}`;
    const seenSeq = this.recentSends.get(dedupeKey);
    if (seenSeq !== undefined) {
      // A resend of an already-relayed frame (e.g. the ack was lost): re-ack
      // with the original seq and never assign a second sequence number.
      socket.send(JSON.stringify({ t: "ack", localId: frame.localId, seq: seenSeq }));
      return;
    }

    this.seq += 1;
    this.rememberSend(dedupeKey, this.seq);
    // The sequence counter must survive eviction, or a reconstructed room
    // would restart the server sequence mid-conversation.
    await this.persistState();
    const relay = {
      t: "relay",
      seq: this.seq,
      senderId: attachment.id,
      localId: frame.localId,
      ts: Date.now(),
      payload: frame.payload,
    };
    this.broadcast(relay);
    socket.send(JSON.stringify({ t: "ack", localId: frame.localId, seq: this.seq }));
  }

  private rememberSend(key: string, seq: number): void {
    if (this.recentSends.size >= HuskRoom.RECENT_SENDS_LIMIT) {
      const oldest = this.recentSends.keys().next().value;
      if (oldest !== undefined) {
        this.recentSends.delete(oldest);
      }
    }
    this.recentSends.set(key, seq);
  }

  async webSocketClose(socket: WebSocket) {
    // The runtime may deliver both an error and a close for one socket, and by
    // the time the close event fires the socket is already gone from
    // getWebSockets(), so dedupe by seen-set instead of membership.
    if (this.closeHandled.has(socket)) {
      return;
    }
    this.closeHandled.add(socket);
    const attachment = socket.deserializeAttachment<Attachment>();
    const remaining = this.participants().filter(
      (participant) => participant.id !== attachment?.id,
    );
    if (remaining.length === 0) {
      this.emptySince = Date.now();
      await this.persistState();
    }
    this.broadcast({
      t: "presence",
      event: "leave",
      who: attachment?.id ?? "unknown",
      participants: remaining,
    });
  }

  async webSocketError(socket: WebSocket) {
    await this.webSocketClose(socket);
  }

  /**
   * The single mechanism that closes a room. Runs regardless of whether any
   * client behaved well, which is what makes crashed hosts safe. The
   * deleteAll() also purges every stored file chunk row.
   */
  async alarm(): Promise<void> {
    const now = Date.now();
    const expired = now >= this.expiresAt();
    const idle =
      this.participants().length === 0 &&
      this.emptySince > 0 &&
      now - this.emptySince >= ROOM_IDLE_TIMEOUT_MS;

    if (expired || idle) {
      this.broadcast({ t: "closed", reason: expired ? "expired" : "idle" });
      for (const socket of this.state.getWebSockets()) {
        try {
          socket.close(1000, "room_closed");
        } catch {
          // Already gone.
        }
      }
      this.exists = false;
      this.seq = 0;
      this.createdAt = 0;
      this.emptySince = 0;
      this.bytesUsed = 0;
      this.recentSends.clear();
      // deleteAll() also removes the persisted room-state row, so a later
      // reconstruct correctly sees a nonexistent room.
      await this.state.storage.deleteAll();
      return;
    }

    await this.state.storage.setAlarm(now + ALARM_INTERVAL_MS);
  }
}
