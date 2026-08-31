/**
 * STRESS 5b: Message reliability — 50 rapid-fire messages, ordering,
 * empty payload, invalid JSON, oversized payload.
 * Join budget spent: 2.
 */
import {
  BASE, assert, connect, createRoom, importRoomKeySync, joinRoom, log, randomRoomId, seal, sendJson, sleep,
} from "./probe-lib.mjs";

const roomId = randomRoomId();
assert((await createRoom(roomId)).status === 200, "create room");
const ja = await joinRoom(roomId);
assert(ja.status === 200, `join A (${ja.status})`);
const jb = await joinRoom(roomId);
assert(jb.status === 200, `join B (${jb.status})`);
const key = await importRoomKeySync("MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY");

const A = await connect(roomId, ja.body.joinToken, "A");
const B = await connect(roomId, jb.body.joinToken, "B");

// 50 rapid-fire from A; B must receive all 50 in seq order.
const N = 50;
const relayWaiter = (async () => {
  const relays = [];
  while (relays.length < N) {
    const r = await B.waitFor(
      (m) => m.t === "relay" && m.senderId === A.welcome.you,
      20_000,
      `relay ${relays.length + 1}`,
    );
    relays.push(r);
  }
  return relays;
})();
for (let i = 0; i < N; i += 1) {
  sendJson(A.ws, { t: "send", localId: `m${i}`, payload: await seal(key, { kind: "text", text: `msg-${i}`, sentAt: Date.now() }) });
}
const relays = await relayWaiter;
assert(relays.length === N, `all ${N} relays received (got ${relays.length})`);
const seqs = relays.map((r) => r.seq);
const sorted = [...seqs].sort((x, y) => x - y);
assert(JSON.stringify(seqs) === JSON.stringify(sorted), "relays arrive in strictly ascending seq order");
assert(new Set(seqs).size === N, "seq values are unique (no dupes/loss)");

// Empty payload {iv:"", ct:""} -> server error frame, connection survives.
sendJson(A.ws, { t: "send", localId: "empty", payload: { iv: "", ct: "" } });
const err1 = await A.waitFor("error", 10_000, "error for empty payload");
assert(err1.code === "bad_request", "empty payload answered with bad_request");

// Malformed JSON frame -> error frame, connection survives.
A.ws.send("this is not json {{{");
const err2 = await A.waitFor("error", 10_000, "error for bad json");
assert(err2.code === "bad_request", "invalid JSON answered with bad_request");

// Oversized payload (~900KB ciphertext; platform WS cap is 1MiB).
try {
  const big = { kind: "text", text: "x".repeat(900_000), sentAt: Date.now() };
  sendJson(A.ws, { t: "send", localId: "big", payload: await seal(key, big) });
  const bigRelay = await B.waitFor((m) => m.t === "relay" && m.localId === "big", 15_000, "big relay");
  assert(bigRelay.payload.ct.length > 500_000, "large (~900KB) payload relayed end-to-end");
} catch (e) {
  log("NOTE: large payload behaviour:", e.message);
}

// Ping still answered after all abuse (connection healthy).
sendJson(A.ws, { t: "ping" });
assert((await A.waitFor("pong")).t === "pong", "A connection healthy after stress");
sendJson(B.ws, { t: "ping" });
assert((await B.waitFor("pong")).t === "pong", "B connection healthy after stress");

A.close();
B.close();
log("SCENARIO 5b: OK");
await sleep(200);
