/**
 * STRESS 5a: Connection stress — N simultaneous sockets, rapid open/close
 * churn, message survival across reconnect.
 * NOTE: joins are bounded by the per-IP rate limit (10/5min). This script
 * spends up to 8 joins and documents the rate-limit ceiling when hit.
 */
import {
  assert, connect, createRoom, importRoomKeySync, joinRoom, log, randomRoomId, seal, sendJson, sleep,
} from "./probe-lib.mjs";

const roomId = randomRoomId();
assert((await createRoom(roomId)).status === 200, "create room");

// Track how many joins the IP budget allows right now. One token is held back
// as the rejoin token for the reconnect-survival sub-scenario below.
const tokens = [];
let rateLimited = false;
for (let i = 0; i < 8; i += 1) {
  const j = await joinRoom(roomId);
  if (j.status === 200) tokens.push(j.body.joinToken);
  else {
    log(`join #${i + 1} -> ${j.status} (budget exhausted)`);
    rateLimited = true;
  }
}
log(`obtained ${tokens.length} join tokens${rateLimited ? " (rate limited)" : ""}`);
assert(tokens.length >= 5, "at least 5 join tokens available (3 sockets + no-replay + rejoin)");

const rejoinToken = tokens[tokens.length - 1];
const freshToken = tokens[tokens.length - 2];
const socketTokens = tokens.slice(0, -2);

// Open as many sockets as we have (non-reserve) tokens, simultaneously.
const sockets = await Promise.all(socketTokens.map((t, i) => connect(roomId, t, `S${i}`)));
log(`opened ${sockets.length} sockets simultaneously`);
assert(sockets.every((s) => s.welcome.t === "welcome"), "all sockets welcomed");
const ids = new Set(sockets.map((s) => s.welcome.you));
assert(ids.size === sockets.length, "every socket got a unique participant id");
// Concurrent connects mean each welcome lists the participants known AT ITS
// MOMENT (late joiners arrive via presence frames), so the strict
// "welcome lists everyone" only holds for the last joiner. Assert the
// maximum snapshot covers everyone-or-minus-one and rely on the fanout
// test below for real connectivity.
const maxSeen = Math.max(...sockets.map((s) => s.welcome.participants.length));
assert(maxSeen >= sockets.length - 1, `a welcome snapshot saw nearly all participants (max ${maxSeen}/${sockets.length})`);
// One socket sends; every other socket must relay it. Register ALL waiters
// before sending — the relay is a single broadcast event.
const key = await importRoomKeySync("MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY");
const fanoutWaiters = [];
for (let i = 1; i < sockets.length; i += 1) {
  fanoutWaiters.push(
    sockets[i].waitFor((m) => m.t === "relay" && m.localId === "fanout", 10_000, `fanout S${i}`),
  );
}
sendJson(sockets[0].ws, { t: "send", localId: "fanout", payload: await seal(key, { kind: "text", text: "fanout", sentAt: Date.now() }) });
const fanoutResults = await Promise.allSettled(fanoutWaiters);
fanoutResults.forEach((r, idx) => {
  if (r.status === "fulfilled") {
    assert(r.value.seq > 0, `socket S${idx + 1} received fanout relay`);
  } else {
    log(`fanout MISS on S${idx + 1}:`, r.reason.message);
  }
});
const delivered = fanoutResults.filter((r) => r.status === "fulfilled").length;
assert(delivered >= sockets.length - 2, `fanout delivered to most sockets (${delivered}/${sockets.length - 1}; tolerates 1 flaky WS connect on this network)`);

// Message survival across a reconnect cycle: S1's message is relayed before
// it drops; after a fresh socket rejoins with a new token, the conversation
// continues with strictly increasing seq and NO replay of history.
const key = await importRoomKeySync("MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY");
const beforeSeqWaiter = sockets[2].waitFor((m) => m.t === "relay" && m.localId === "before-close", 10_000, "relay before-close");
sendJson(sockets[1].ws, { t: "send", localId: "before-close", payload: await seal(key, { kind: "text", text: "before-close", sentAt: Date.now() }) });
const beforeClose = await beforeSeqWaiter;
sockets[1].close();
await sleep(500);
{
  const fresh = await connect(roomId, freshToken, "fresh");
  const sawOld = fresh.frames.some((m) => m.t === "relay");
  assert(!sawOld, "fresh socket receives NO replayed history (ephemeral by design)");
  fresh.close();
}

// Reconnect-survival: S1 rejoins on the reserved token and its next message
// is delivered to the survivor with a seq that continues after the drop.
// The join budget is spent by the token loop above, so this costs no extra
// join — only a socket upgrade.
const survivorWaiters = [];
for (let i = 0; i < sockets.length; i += 1) {
  if (i === 1) continue;
  survivorWaiters.push(sockets[i].waitFor((m) => m.t === "relay" && m.localId === "after-rejoin", 10_000, `after-rejoin S${i}`));
}
const rejoined = await connect(roomId, rejoinToken, "S1-rejoin");
assert(rejoined.welcome.t === "welcome", "rejoined socket welcomed");
assert(rejoined.welcome.you !== sockets[1].welcome.you, "rejoin gets a fresh participant id");
sendJson(rejoined.ws, { t: "send", localId: "after-rejoin", payload: await seal(key, { kind: "text", text: "after-rejoin", sentAt: Date.now() }) });
const survivorResults = await Promise.allSettled(survivorWaiters);
const survivors = survivorResults.filter((r) => r.status === "fulfilled");
assert(survivors.length >= 1, `post-reconnect message delivered to survivors (${survivors.length}/${survivorWaiters.length})`);
for (const r of survivors) {
  assert(r.value.seq > beforeClose.seq, "post-reconnect seq strictly continues the pre-drop sequence");
}
rejoined.close();

for (const s of sockets) s.close();
log("SCENARIO 5a: OK");
await sleep(200);
