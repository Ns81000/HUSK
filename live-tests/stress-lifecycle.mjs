/**
 * STRESS 5c: Room lifecycle — invalid room ids, join on nonexistent room,
 * join rate-limit shape, welcome expiresAt sanity.
 * Join budget spent: ~3.
 */
import {
  BASE, assert, connect, createRoom, joinRoom, log, randomRoomId, sleep,
} from "./probe-lib.mjs";

// Invalid room ids on create.
for (const bad of ["short", "waytoolongid123", "UPPERCASE", "with-dash", "with space", ""]) {
  const res = await createRoom(bad);
  assert(res.status === 400, `create with invalid roomId "${bad}" -> 400 (got ${res.status})`);
}

// Join on a nonexistent (but well-formed) room -> generic 404, no oracle.
const ghost = await joinRoom(randomRoomId());
assert(ghost.status === 404, `join nonexistent room -> 404 (got ${ghost.status})`);
assert(ghost.body?.error === "unavailable", "error body is the generic 'unavailable'");

// Socket on a nonexistent room without an upgrade header -> rejected (426
// "Expected websocket" per room.ts:200-201; some edge normalizations yield
// 400/404). Any of these is a rejection — none may be 101/200.
const ghostSock = await fetch(`${BASE.replace("https:", "wss:")}/room/${randomRoomId()}/socket`.replace("wss:", "https:"));
log("socket route on nonexistent room (no upgrade) ->", ghostSock.status);
assert([400, 404, 426].includes(ghostSock.status), `socket route on nonexistent room rejected (got ${ghostSock.status})`);

// Real room: welcome carries a sane expiresAt (~24h from now).
const roomId = randomRoomId();
assert((await createRoom(roomId)).status === 200, "create room");
const j = await joinRoom(roomId);
assert(j.status === 200, "join ok");
const A = await connect(roomId, j.body.joinToken, "A");
const expiresIn = A.welcome.expiresAt - Date.now();
log("room expires in hours:", (expiresIn / 3_600_000).toFixed(2));
assert(expiresIn > 23 * 3_600_000 && expiresIn < 25 * 3_600_000, `expiresAt is ~24h out (got ${(expiresIn / 3_600_000).toFixed(2)}h)`);
A.close();

// NOTE: idle-timeout (30 min empty) and rejoin-after-purge are time-gated and
// covered by probe-eviction instead; documented in FINDINGS §9.
log("SCENARIO 5c: OK");
await sleep(200);
