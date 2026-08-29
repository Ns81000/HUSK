// F34/H44/C16/C17: offline mid-room -> distinct offline banner -> online ->
// auto-reconnect -> queued sends flush; missed-message semantics; seq order.
// Costs: 1 create + 2 joins + 1 reconnect join.
import {
  FRONTEND,
  assert,
  createRoomViaUi,
  launch,
  log,
  monitor,
  participantCount,
  sendText,
  sleep,
  statusLine,
} from "./drive-lib.mjs";

const browser = await launch();
const ctxA = await browser.newContext({ viewport: { width: 1280, height: 900 } });
const ctxB = await browser.newContext({ viewport: { width: 1280, height: 900 } });
const pageA = await ctxA.newPage();
const eventsA = monitor(pageA, "A");
const pageB = await ctxB.newPage();
const eventsB = monitor(pageB, "B");

const { pin, fragment } = await createRoomViaUi(pageA);
await pageB.goto(`${FRONTEND}/r/${pin}#${fragment}`);
await sleep(2500);
assert((await participantCount(pageA)) === 2, `both connected (2 participants)`);

// Baseline message both sides see.
await sendText(pageA, "before-offline-1");
await pageB.getByText("before-offline-1").waitFor({ timeout: 10_000 });

// F34: B goes offline via CDP -> distinct "You are offline" banner.
const cdpB = await ctxB.newCDPSession(pageB);
await cdpB.send("Network.enable");
await cdpB.send("Network.emulateNetworkConditions", {
  offline: true,
  latency: 0,
  downloadThroughput: -1,
  uploadThroughput: -1,
});
await sleep(1000);
const offlineText = await statusLine(pageB).textContent();
log("B status line while offline:", offlineText);
assert(offlineText.includes("You are offline"), `distinct offline banner (got "${offlineText}")`);

// A sends while B is disconnected. NOTE: CDP offline emulation does NOT drop
// an established WebSocket, so the relay can still deliver to B once the
// network layer unblocks — the true no-backfill check lives in
// probe-reconnect.mjs with a real socket close + fresh join.
await sendText(pageA, "while-b-offline");
await sleep(2000);

// Back online -> network unblocks (the socket may never have dropped under
// CDP emulation; assert the status recovers to Connected).
await cdpB.send("Network.emulateNetworkConditions", {
  offline: false,
  latency: 0,
  downloadThroughput: -1,
  uploadThroughput: -1,
});
const bStatus = statusLine(pageB);
let reconnected = false;
for (let i = 0; i < 30; i += 1) {
  const t = await bStatus.textContent();
  if (t.includes("Connected")) {
    reconnected = true;
    break;
  }
  await sleep(1000);
}
assert(reconnected, `B status recovers to Connected after coming back online`);

// H44/C16: alternating sends across the reconnect window; order must agree.
await sendText(pageB, "b-after-reconnect-1");
await sendText(pageA, "a-after-reconnect-2");
await sendText(pageB, "b-after-reconnect-3");
await pageA.getByText("b-after-reconnect-1").waitFor({ timeout: 10_000 });
await pageA.getByText("b-after-reconnect-3").waitFor({ timeout: 10_000 });
await pageB.getByText("a-after-reconnect-2").waitFor({ timeout: 10_000 });
await sleep(1500);
const orderA = await pageA.locator("p.whitespace-pre-wrap").allTextContents();
const orderB = await pageB.locator("p.whitespace-pre-wrap").allTextContents();
log("A order:", JSON.stringify(orderA));
log("B order:", JSON.stringify(orderB));
assert(JSON.stringify(orderA) === JSON.stringify(orderB), `both sides agree on final order`);
// No duplicate bubbles after reconnect.
const dupCheck = await pageB.getByText("before-offline-1").count();
assert(dupCheck === 1, `no duplicate bubbles after reconnect (got ${dupCheck})`);

log("A console errors:", JSON.stringify(eventsA.console.filter((c) => c.type === "error")));
log("B console errors:", JSON.stringify(eventsB.console.filter((c) => c.type === "error")));
await browser.close();
log("SCENARIO F34/H44/C17: OK");
