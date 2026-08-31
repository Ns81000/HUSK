/**
 * STRESS 5e/5f: Security probes + concurrency — spoofed senderId, client-sent
 * server-only frames, token reuse, path traversal, same-millisecond sends,
 * rapid room creation (rate-limit check).
 * Join budget spent: 2 (+ reuse of one token).
 * NOTE: the /room/create burst probe runs LAST — it exhausts the create
 * budget (5 per IP per 5 min) on purpose, which would starve earlier sections.
 */
import {
  BASE, assert, connect, createRoom, importRoomKeySync, joinRoom, log, randomRoomId, seal, sendJson, sleep,
} from "./probe-lib.mjs";

// --- Same-millisecond sends: seq ordering must stay strict. ---
const roomId = randomRoomId();
assert((await createRoom(roomId)).status === 200, "create room");
const ja = await joinRoom(roomId);
const jb = await joinRoom(roomId);
assert(ja.status === 200 && jb.status === 200, "both joins ok");
const key = await importRoomKeySync("MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY");
const A = await connect(roomId, ja.body.joinToken, "A");
const B = await connect(roomId, jb.body.joinToken, "B");

const collect = async (count) => {
  const out = [];
  while (out.length < count) {
    out.push(await B.waitFor((m) => m.t === "relay", 15_000, "relay"));
  }
  return out;
};
const wait = collect(4);
const p1 = seal(key, { kind: "text", text: "a", sentAt: Date.now() });
const p2 = seal(key, { kind: "text", text: "b", sentAt: Date.now() });
const p3 = seal(key, { kind: "text", text: "c", sentAt: Date.now() });
const p4 = seal(key, { kind: "text", text: "d", sentAt: Date.now() });
const [s1, s2, s3, s4] = await Promise.all([p1, p2, p3, p4]);
// Four sockets-level sends fired back-to-back in the same tick:
A.ws.send(JSON.stringify({ t: "send", localId: "c1", payload: s1 }));
A.ws.send(JSON.stringify({ t: "send", localId: "c2", payload: s2 }));
A.ws.send(JSON.stringify({ t: "send", localId: "c3", payload: s3 }));
B.ws.send(JSON.stringify({ t: "send", localId: "c4", payload: s4 }));
const relays = await wait;
const seqs = relays.map((r) => r.seq);
assert(new Set(seqs).size === 4, "same-tick sends get unique seqs");
assert([...seqs].sort((x, y) => x - y).join() === seqs.join(), "same-tick sends arrive in seq order");

// --- Spoofed senderId: server must override with the attachment id. ---
sendJson(A.ws, { t: "send", senderId: "SPOOFED-ID", localId: "spoof", payload: await seal(key, { kind: "text", text: "spoof", sentAt: Date.now() }) });
const spoof = await B.waitFor((m) => m.t === "relay" && m.localId === "spoof");
assert(spoof.senderId === A.welcome.you, `server overrides client-sent senderId (got ${spoof.senderId})`);

// --- Client sends a server-only frame type (welcome) ---
sendJson(A.ws, { t: "welcome", you: "evil" });
const wErr = await A.waitFor("error", 10_000, "error for client welcome");
assert(wErr.code === "bad_request", "client-sent welcome frame rejected with bad_request");

// --- Path traversal / SQL injection in roomId ---
for (const bad of ["../../admin", "%2e%2e%2fadmin", "abc123'--", "abcdefgh OR 1=1"]) {
  const res = await fetch(`${BASE}/room/${encodeURIComponent(bad)}/socket`);
  log(`socket on malformed roomId "${bad}" ->`, res.status);
  // 400/404/426 are all rejections (no upgrade handshake, no data). The edge
  // normalizes dot-segments to 400; the worker would 404/426. None may be 101.
  assert(res.status !== 101 && res.status < 500, `malformed roomId safely rejected (got ${res.status} for ${bad})`);
}
const createBad = await createRoom("' OR 1=1--");
assert(createBad.status === 400, `create with SQLi roomId -> 400 (got ${createBad.status})`);

// --- Join-token reuse: second connect with the same token must fail. ---
const jc = await joinRoom(roomId);
assert(jc.status === 200, "third join ok (token mint)");
const C = await connect(roomId, jc.body.joinToken, "C");
C.close();
await sleep(500);
let reuseRejected = false;
try {
  const reuse = await connect(roomId, jc.body.joinToken, "C-reuse");
  log("REUSED TOKEN CONNECT: unexpectedly OPENED (welcome you=" + reuse.welcome.you + ")");
  reuse.close();
  log("FINDING-EVIDENCE: reused join token was accepted (burn TOCTOU or missing burn)");
} catch {
  reuseRejected = true;
}
assert(reuseRejected, "reused join token is rejected (burned token cannot reopen a socket)");

A.close();
B.close();

// --- Rapid room creation: the create budget (5 per IP per 5 min) must hold.
// Runs last: the burst deliberately exhausts this IP's create budget. The
// room create above already consumed one slot, so the burst runs until the
// first 429 rather than assuming a fresh window.
const created = [];
let guard = 0;
while (guard++ < 10) {
  const res = await createRoom(randomRoomId());
  created.push(res.status);
  if (res.status !== 200) break;
}
log("create burst:", created.join(","));
assert(created.at(-1) === 429, `create burst ends in a 429 (got ${created.join(",")})`);
assert(
  created.filter((s) => s === 200).length >= 1,
  "the remaining budget is served before the denial",
);

log("SCENARIO 5e/5f: OK");
await sleep(200);
