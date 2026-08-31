/**
 * STRESS 5d: File transfer edge cases — boundary sizes, tampered/expired
 * tickets, replayed chunks, cancel of nonexistent file.
 * Join budget spent: 1.
 */
import {
  assert, connect, createRoom, importRoomKeySync, joinRoom, log, randomRoomId, requestFileGrant, putChunk, getFile, sendJson, sleep,
} from "./probe-lib.mjs";

const CHUNK = 1024 * 1024;

const roomId = randomRoomId();
assert((await createRoom(roomId)).status === 200, "create room");
const ja = await joinRoom(roomId);
assert(ja.status === 200, `join (${ja.status})`);
const A = await connect(roomId, ja.body.joinToken, "A");
const me = A.welcome.you;

// Grant for a non-member id must be forbidden.
const ghost = await requestFileGrant(roomId, "not-a-member", 1024);
assert(ghost.status === 403, `grant with fake member -> 403 (got ${ghost.status})`);

// Oversize grant (25MB + 1) must be 400.
const over = await requestFileGrant(roomId, me, 25 * 1024 * 1024 + 1);
assert(over.status === 400, `grant over MAX_FILE_BYTES -> 400 (got ${over.status})`);

// 0-byte grant must be 400.
const zero = await requestFileGrant(roomId, me, 0);
assert(zero.status === 400, `0-byte grant -> 400 (got ${zero.status})`);

// Exact boundary: 25 MiB grant accepted. Public grant shape omits `chunks`
// (the Worker strips it) — the client computes it from size.
const grant = await requestFileGrant(roomId, me, 25 * CHUNK);
assert(grant.status === 200, "grant for exactly 25 MiB accepted");
assert(grant.body.fileId !== undefined, "grant carries fileId");
assert(Array.isArray(grant.body.chunkUrls) && grant.body.chunkUrls.length === 25, `25 chunk urls for 25 MiB (got ${grant.body.chunkUrls?.length})`);

// Upload one chunk, verify replay/tamper behaviour.
const payload = new Uint8Array(CHUNK + 16).map((_, i) => i % 251);
const put1 = await putChunk(grant.body.chunkUrls[0], payload);
assert(put1.status === 200, `chunk 0 upload ok (got ${put1.status})`);
const replay = await putChunk(grant.body.chunkUrls[0], payload);
assert(replay.status === 409, `chunk 0 REPLAY -> 409 immutable (got ${replay.status})`);

// Tampered signature on chunk URL.
const badUrl = grant.body.chunkUrls[1].replace(/sig=.{8}/, "sig=deadbeef");
const tampered = await putChunk(badUrl, payload);
assert(tampered.status === 403, `tampered chunk sig -> 403 (got ${tampered.status})`);

// Expired ticket: exp in the past.
const url = new URL(grant.body.chunkUrls[2]);
const expiredUrl = `${url.origin}${url.pathname}?exp=1000000000&sig=${url.searchParams.get("sig")}`;
const expired = await putChunk(expiredUrl, payload);
assert(expired.status === 403, `expired exp on chunk PUT -> 403 (got ${expired.status})`);

// Chunk index beyond meta.chunks -> 404.
const beyond = await putChunk(grant.body.chunkUrls[24].replace(/\/24\?/, "/25?"), payload);
log("chunk index beyond grant ->", beyond.status);

// Download with tampered sig -> 403.
const { fileId, download } = grant.body;
const dlBad = await getFile(roomId, fileId, download.exp, "deadbeefdeadbeef");
assert(dlBad.status === 403, `download with forged sig -> 403 (got ${dlBad.status})`);

// Download with tampered exp -> 403 (sig covers exp).
const dlExp = await getFile(roomId, fileId, download.exp + 1, download.sig);
assert(dlExp.status === 403, `download with modified exp -> 403 (got ${dlExp.status})`);

// Cancel of a nonexistent fileId must not crash the socket.
sendJson(A.ws, { t: "cancel", fileId: "00000000-0000-4000-8000-000000000000" });
await sleep(1000);
sendJson(A.ws, { t: "ping" });
assert((await A.waitFor("pong")).t === "pong", "socket healthy after cancel of unknown fileId");

// Cross-room forgery: use this room's ticket against a different roomId path.
const otherRoom = randomRoomId();
assert((await createRoom(otherRoom)).status === 200, "second room created");
const cross = await fetch(grant.body.chunkUrls[0].replace(roomId, otherRoom), { method: "PUT", body: payload });
assert(cross.status === 403 || cross.status === 404, `cross-room ticket use rejected (got ${cross.status})`);

A.close();
log("SCENARIO 5d: OK");
await sleep(200);
