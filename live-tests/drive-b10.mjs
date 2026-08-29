// B10: reconnect termination. A real socket drop + aborted join mints ->
// attempt budget exhausts -> terminal closed_disconnected with a Reconnect
// button -> recovery via the browser `online` event, then message flow.
// Costs: 1 create + 2 joins (mints are aborted client-side: no join budget).
import {
  FRONTEND,
  assert,
  createRoomViaUi,
  launch,
  log,
  monitor,
  sleep,
  statusLine,
  waitForParticipants,
} from "./drive-lib.mjs";

const browser = await launch();
const ctxA = await browser.newContext({ viewport: { width: 1280, height: 900 } });
const ctxB = await browser.newContext({ viewport: { width: 1280, height: 900 } });
// Track every WebSocket so we can force-close the live one from the page.
await ctxB.addInitScript(() => {
  const NativeWebSocket = window.WebSocket;
  window.__sockets = [];
  window.WebSocket = class extends NativeWebSocket {
    constructor(...args) {
      super(...args);
      window.__sockets.push(this);
    }
  };
});
const pageA = await ctxA.newPage();
const eventsA = monitor(pageA, "A");
const pageB = await ctxB.newPage();
const eventsB = monitor(pageB, "B");

const { pin, fragment } = await createRoomViaUi(pageA);
await pageB.goto(`${FRONTEND}/r/${pin}#${fragment}`);
assert((await waitForParticipants(pageA, 2)) === 2, `both connected`);

// Block future join mints at the network layer (fetch, not WebSocket).
await ctxB.route("**/room/join*", (route) => route.abort());
// Force-close the live socket: exactly what a mid-stream network drop does.
const closedCount = await pageB.evaluate(() => {
  let closed = 0;
  for (const ws of window.__sockets) {
    if (ws.readyState <= 1) {
      ws.close();
      closed += 1;
    }
  }
  return closed;
});
log("force-closed sockets:", closedCount);
assert(closedCount >= 1, `live socket force-closed`);

// The reconnect loop must terminate in the terminal state.
const start = Date.now();
let terminal = false;
while (Date.now() - start < 240_000) {
  if ((await pageB.getByRole("heading", { name: "Disconnected" }).count()) > 0) {
    terminal = true;
    break;
  }
  await sleep(2000);
}
assert(terminal, `terminal "Disconnected" screen reached after the attempt budget`);
const reconnectBtn = pageB.getByRole("button", { name: "Reconnect" });
assert((await reconnectBtn.count()) === 1, `Reconnect button offered on closed_disconnected`);
log(`time to terminal: ${Math.round((Date.now() - start) / 1000)}s`);

// Recovery: browser `online` event auto-recovers a terminal room (Phase 4).
await ctxB.unroute("**/room/join*");
await pageB.evaluate(() => window.dispatchEvent(new Event("online")));
let recovered = false;
for (let i = 0; i < 30; i += 1) {
  if ((await pageB.getByRole("heading", { name: "Disconnected" }).count()) === 0) {
    recovered = true;
    break;
  }
  await sleep(1000);
}
assert(recovered, `browser online event auto-recovers the terminal room`);
await pageB.getByRole("textbox", { name: "Message" }).waitFor({ timeout: 20_000 });
for (let i = 0; i < 30; i += 1) {
  const status = await statusLine(pageB).textContent();
  if (status.includes("Connected")) break;
  await sleep(1000);
}
log("B status after recovery:", await statusLine(pageB).textContent());

// Seq continuity: A sends, B receives exactly one bubble.
await pageA.getByRole("textbox", { name: "Message" }).fill("after-b10");
await pageA.getByRole("textbox", { name: "Message" }).press("Enter");
await pageB.getByText("after-b10").waitFor({ timeout: 15_000 });
const dups = await pageB.getByText("after-b10").count();
assert(dups === 1, `post-recovery delivery exactly once`);

log("B console errors:", JSON.stringify(eventsB.console.filter((c) => c.type === "error")));
await browser.close();
log("SCENARIO B10: OK");
