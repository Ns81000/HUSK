// B6/B7: hibernation wake (idle sockets >60s, seq continues, no duplicate
// localIds) and isolate eviction mid-room (close sockets, wait >60s, rejoin —
// room alive, seq continues). Costs: 1 create + 4 joins (2 after the waits).
import {
  assert,
  connect,
  createRoom,
  importRoomKeySync,
  joinRoom,
  log,
  openSealed,
  randomRoomId,
  seal,
  sendJson,
  sleep,
} from "./probe-lib.mjs";

const pin = randomRoomId();
assert((await createRoom(pin)).status === 200, `create ${pin} -> 200`);
const keyBytes = crypto.getRandomValues(new Uint8Array(32));
let binary = "";
for (const b of keyBytes) binary += String.fromCharCode(b);
const key = await importRoomKeySync(btoa(binary));

const ja = await joinRoom(pin);
const jb = await joinRoom(pin);
const A = await connect(pin, ja.body.joinToken, "A");
const B = await connect(pin, jb.body.joinToken, "B");

// Hibernation wake: idle >75s with sockets open, then send.
log("idling 75s with sockets open (hibernation window)...");
await sleep(75_000);
sendJson(A.ws, {
  t: "send",
  localId: "pre-eviction",
  payload: await seal(key, { kind: "text", text: "wake", sentAt: Date.now() }),
});
const relay = B.waitFor("relay", 15_000, "relay after hibernation wake");
const ack = A.waitFor(
  (m) => m.t === "ack" && m.localId === "pre-eviction",
  15_000,
  "ack after wake",
);
const r1 = await relay;
const a1 = await ack;
assert(a1.seq === r1.seq && r1.seq >= 1, `hibernation wake: relay+ack still work, seq ${r1.seq}`);
const body = await openSealed(key, r1.payload);
assert(body.text === "wake", `payload intact after hibernation`);
// No duplicate localIds: exactly one relay for the localId at B.
const dupRelays = B.frames.filter((m) => m.t === "relay" && m.localId === "pre-eviction");
assert(dupRelays.length === 1, `no duplicate relay after wake (${dupRelays.length})`);

// Isolate eviction: close both sockets, wait >75s, rejoin.
A.close();
B.close();
log("sockets closed; waiting 80s for isolate eviction...");
await sleep(80_000);

const ja2 = await joinRoom(pin);
assert(ja2.status === 200, `join after eviction -> 200 (room alive)`);
const jb2 = await joinRoom(pin);
assert(jb2.status === 200, `second join after eviction -> 200`);
const A2 = await connect(pin, ja2.body.joinToken, "A2");
const B2 = await connect(pin, jb2.body.joinToken, "B2");
assert(
  A2.welcome.seq === r1.seq,
  `welcome seq ${A2.welcome.seq} continues pre-eviction seq ${r1.seq}`,
);
sendJson(A2.ws, {
  t: "send",
  localId: "post-eviction",
  payload: await seal(key, { kind: "text", text: "after", sentAt: Date.now() }),
});
const relay2 = B2.waitFor("relay", 15_000, "relay after eviction");
const r2 = await relay2;
assert(r2.seq === r1.seq + 1, `seq continues across eviction (${r1.seq} -> ${r2.seq})`);

A2.close();
B2.close();
log("SCENARIO B6/B7-eviction: OK");
