// Scenario 4 + C13: fill a room to 10 participants; two simultaneous joins at
// the edge must admit exactly one (atomic capacity); the 11th is refused.
// Join-budget plan: 9 joins in window 1, 5-minute pause, then 2 in window 2.
import {
  assert,
  connect,
  createRoom,
  importRoomKeySync,
  joinRoom,
  log,
  randomRoomId,
  sleep,
} from "./probe-lib.mjs";

const pin = randomRoomId();
assert((await createRoom(pin)).status === 200, `create ${pin} -> 200`);
const keyBytes = crypto.getRandomValues(new Uint8Array(32));
let binary = "";
for (const b of keyBytes) binary += String.fromCharCode(b);
const key = await importRoomKeySync(btoa(binary));

const sockets = [];
for (let index = 0; index < 9; index += 1) {
  const join = await joinRoom(pin);
  assert(join.status === 200, `join ${index + 1} -> 200`);
  sockets.push(await connect(pin, join.body.joinToken, `p${index + 1}`));
  // Pace joins across the shared per-IP window.
  await sleep(35_000);
}
assert(sockets[8].welcome.participants.length === 9, `9 participants after 9 joins`);

log("waiting 5.5 minutes for the join window to reset...");
await sleep(330_000);

// C13: two joins at the capacity edge, fired simultaneously.
const join10 = joinRoom(pin);
const join11 = joinRoom(pin);
const [r10, r11] = await Promise.all([join10, join11]);
log("simultaneous join results:", r10.status, r11.status);
// Both joins may mint tokens (the gate budget is fresh); the capacity
// refusal happens at the DO's socket upgrade, checked below.
const ok10 = r10.status === 200;
const ok11 = r11.status === 200;
assert(ok10 && ok11, `both edge joins minted tokens (${r10.status} / ${r11.status})`);

const tenth = await connect(pin, r10.body.joinToken, "p10");
assert(tenth.welcome.participants.length === 10, `10 participants at capacity`);
if (ok11) {
  // The other token is valid, but the DO's atomic capacity check refuses the
  // 11th upgrade with 403 (surfaced to the client as a failed handshake).
  const upgrade = await connect(pin, r11.body.joinToken, "p11").then(
    () => "opened",
    (error) => `refused: ${String(error).slice(0, 80)}`,
  );
  log("11th socket upgrade:", upgrade);
  assert(upgrade !== "opened", `11th socket refused at capacity`);
}

// A message still relays at full capacity.
const relay = sockets[0].waitFor("relay", 10_000, "relay at capacity");
tenth.send(JSON.stringify({ t: "send", localId: "at-cap", payload: { iv: "aXY", ct: "Y3Q" } }));
const r = await relay;
assert(r.seq >= 1, `relay works at full capacity (seq ${r.seq})`);

for (const s of sockets) s.close();
tenth.close();
log("SCENARIO 4/C13-capacity: OK");
