// Diagnostic: two joins -> two sockets with full event logging.
import { createRoom, joinRoom, log, randomRoomId } from "./probe-lib.mjs";

const pin = randomRoomId();
log("create:", (await createRoom(pin)).status);
const j1 = await joinRoom(pin);
const j2 = await joinRoom(pin);
log("tokens:", j1.body?.joinToken?.slice(0, 24), "/", j2.body?.joinToken?.slice(0, 24));
log("distinct tokens:", j1.body.joinToken !== j2.body.joinToken);

const ws1 = new WebSocket(
  `wss://husk.ns8pc1.workers.dev/room/${pin}/socket?jt=${j1.body.joinToken}`,
);
ws1.onopen = () => log("A open");
ws1.onmessage = (e) => log("A msg:", String(e.data).slice(0, 80));
ws1.onerror = (e) => log("A error", e?.message ?? "");
ws1.onclose = (e) => log("A close", e.code, e.reason);

const ws2 = new WebSocket(
  `wss://husk.ns8pc1.workers.dev/room/${pin}/socket?jt=${j2.body.joinToken}`,
);
ws2.onopen = () => log("B open");
ws2.onmessage = (e) => log("B msg:", String(e.data).slice(0, 80));
ws2.onerror = (e) => log("B error", e?.message ?? "");
ws2.onclose = (e) => log("B close", e.code, e.reason);

await new Promise((r) => setTimeout(r, 8000));
process.exit(0);
