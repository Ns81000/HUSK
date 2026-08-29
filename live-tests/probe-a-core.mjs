// Scenario A1-A3 (raw protocol layer): create, two sockets, bidirectional
// relay, acks, ordering, presence, dedup on resend.
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
} from "./probe-lib.mjs";

const pin = randomPin();
const created = await createRoom(pin);
assert(created.status === 200, `create room ${pin} -> 200 (got ${created.status})`);

const keyBytes = crypto.getRandomValues(new Uint8Array(32));
let binary = "";
for (const b of keyBytes) binary += String.fromCharCode(b);
const fragment = btoa(binary);
const key = await importRoomKeySync(fragment);

const jb = await joinRoom(pin);
assert(jb.status === 200 && jb.body?.joinToken, `join #1 -> 200 with token`);
const jb2 = await joinRoom(pin);
assert(jb2.status === 200 && jb2.body?.joinToken, `join #2 -> 200 with token`);

const A = await connect(pin, jb.body.joinToken, "A");
assert(A.welcome.participants.length === 1, `welcome A lists 1 participant (joined first)`);
const B = await connect(pin, jb2.body.joinToken, "B");
assert(B.welcome.participants.length === 2, `welcome B lists 2 participants`);
await new Promise((r) => setTimeout(r, 1000));
const aPeerJoin = A.frames.find((m) => m.t === "presence" && m.event === "join");
assert(
  aPeerJoin !== undefined && aPeerJoin.participants.length === 2,
  `A received presence join, now 2 participants`,
);
log("A id", A.welcome.you, "B id", B.welcome.you);

const bRelay1 = B.waitFor("relay", 10_000, "relay->B");
sendJson(A.ws, {
  t: "send",
  localId: "m1",
  payload: await seal(key, { kind: "text", text: "hello from A", sentAt: Date.now() }),
});
const aAck1 = A.waitFor((m) => m.t === "ack" && m.localId === "m1", 10_000, "ack m1");
const r1 = await bRelay1;
const a1 = await aAck1;
assert(a1.seq === r1.seq, `ack seq ${a1.seq} equals relayed seq ${r1.seq}`);
const body1 = await openSealed(key, r1.payload);
assert(body1.text === "hello from A", `B decrypted A's message verbatim`);

const aRelay = A.waitFor("relay", 10_000, "relay->A");
const bAck = B.waitFor((m) => m.t === "ack" && m.localId === "m2", 10_000, "ack m2");
sendJson(B.ws, {
  t: "send",
  localId: "m2",
  payload: await seal(key, { kind: "text", text: "hi from B", sentAt: Date.now() }),
});
const r2 = await aRelay;
await bAck;
assert(
  (await openSealed(key, r2.payload)).text === "hi from B",
  `A decrypted B's message verbatim`,
);
assert(r2.seq === r1.seq + 1, `seq monotonic (${r1.seq} -> ${r2.seq})`);

// Resend dedup: B sends same localId twice, A must get exactly one relay, B gets fresh ack with original seq.
const aWait2 = A.waitFor("relay", 10_000, "relay->A #2");
sendJson(B.ws, {
  t: "send",
  localId: "m3",
  payload: await seal(key, { kind: "text", text: "dup test", sentAt: Date.now() }),
});
const r3 = await aWait2;
sendJson(B.ws, {
  t: "send",
  localId: "m3",
  payload: await seal(key, { kind: "text", text: "dup test", sentAt: Date.now() }),
});
const bAckResend = B.waitFor((m) => m.t === "ack" && m.localId === "m3", 10_000, "resend ack");
const resendAck = await bAckResend;
await new Promise((r) => setTimeout(r, 1500));
const relaysForM3 = A.frames.filter((m) => m.t === "relay" && m.localId === "m3");
assert(
  relaysForM3.length === 1,
  `DO resend dedup: exactly one relay for m3 (got ${relaysForM3.length})`,
);
assert(resendAck.seq === r3.seq, `resend ack carries original seq (${resendAck.seq} vs ${r3.seq})`);

// Presence: A closes (no leave frame in the protocol - just socket close) and B sees leave.
const bLeave = B.waitFor(
  (m) => m.t === "presence" && m.event === "leave",
  15_000,
  "presence leave at B",
);
A.close();
const leave = await bLeave;
assert(leave.who === A.welcome.you, `B saw leave of A's id`);
assert(leave.participants.length === 1, `participants after leave: 1`);

// Malformed frames: connection survives, other peer unaffected.
sendJson(B.ws, "not json at all");
sendJson(B.ws, { t: "send" });
sendJson(B.ws, { t: "unknown-tag", junk: true });
sendJson(B.ws, "x".repeat(200_000));
const ping = B.waitFor("pong", 10_000, "pong after malformed frames");
sendJson(B.ws, { t: "ping" });
await ping;
await new Promise((r) => setTimeout(r, 1500));
const bErrs = B.frames.filter((m) => m.t === "error");
log("B received error frames:", JSON.stringify(bErrs));
assert(bErrs.length >= 2, `server answered malformed frames with error frames (${bErrs.length})`);
assert(true, `connection survives malformed frames (B still answers ping)`);

B.close();
log("SCENARIO A1-A3-raw: OK");
