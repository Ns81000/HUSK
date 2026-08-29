// C17/H44 true socket-drop semantics (raw): B's socket genuinely closes, A
// sends, B re-joins fresh -> welcome seq advanced, no relay for the missed
// message (no backfill by design), seq continuity after reconnect.
// Costs: 1 create + 3 joins.
import {
  assert,
  connect,
  createRoom,
  importRoomKeySync,
  joinRoom,
  log,
  openSealed,
  randomPin,
  seal,
  sendJson,
  sleep,
} from "./probe-lib.mjs";

const pin = randomPin();
assert((await createRoom(pin)).status === 200, `create ${pin} -> 200`);
const keyBytes = crypto.getRandomValues(new Uint8Array(32));
let binary = "";
for (const b of keyBytes) binary += String.fromCharCode(b);
const key = await importRoomKeySync(btoa(binary));

const ja = await joinRoom(pin);
const jb = await joinRoom(pin);
const A = await connect(pin, ja.body.joinToken, "A");
const B = await connect(pin, jb.body.joinToken, "B");
assert(
  A.welcome.participants.length === 2 || B.welcome.participants.length === 2,
  `both sockets up`,
);

// B's socket genuinely drops.
B.close();
await sleep(1000);

// A sends while B is gone.
sendJson(A.ws, {
  t: "send",
  localId: "missed-1",
  payload: await seal(key, { kind: "text", text: "missed", sentAt: Date.now() }),
});
const aAck = A.waitFor((m) => m.t === "ack" && m.localId === "missed-1", 10_000, "ack missed-1");
const ackMissed = await aAck;
log("missed message seq:", ackMissed.seq);

// B re-joins fresh (new join + new socket, like the client's reconnect).
const jb2 = await joinRoom(pin);
assert(jb2.status === 200, `B rejoin -> 200`);
const B2 = await connect(pin, jb2.body.joinToken, "B2");
assert(
  B2.welcome.seq === ackMissed.seq,
  `welcome seq ${B2.welcome.seq} equals last acked seq ${ackMissed.seq} (continuity, no history)`,
);
await sleep(3000);
const backfilled = B2.frames.filter((m) => m.t === "relay" && m.localId === "missed-1");
assert(
  backfilled.length === 0,
  `no backfill of the missed message (by design; client shows no fake delivery)`,
);

// H44: seq continues after reconnect; misordering never occurs.
sendJson(B2.ws, {
  t: "send",
  localId: "post-reconnect",
  payload: await seal(key, { kind: "text", text: "post", sentAt: Date.now() }),
});
const relayBack = A.waitFor(
  (m) => m.t === "relay" && m.localId === "post-reconnect",
  10_000,
  "relay post-reconnect",
);
const r = await relayBack;
assert(
  r.seq === ackMissed.seq + 1,
  `seq monotonic across the reconnect window (${ackMissed.seq} -> ${r.seq})`,
);

A.close();
B2.close();
log("SCENARIO C17/H44-raw: OK");
