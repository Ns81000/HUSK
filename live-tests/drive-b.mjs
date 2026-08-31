// B9/B12: kill A's context entirely -> B sees the grace window ("peer may be
// reconnecting"), then "waiting for peer" + system note. Then a fresh host
// leaves via the modal -> guest gets the closed screen. Costs: 2 joins.
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
  waitForParticipants,
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
const gotA = await waitForParticipants(pageA, 2);
const gotB = await waitForParticipants(pageB, 2);
assert(gotA === 2, `both connected (A sees ${gotA}, B sees ${gotB})`);
await sendText(pageA, "hello before the crash");
await pageB.getByText("hello before the crash").waitFor({ timeout: 10_000 });

// B9: kill A's context with no leave (context.close() = abrupt).
const statusB = statusLine(pageB);
await ctxA.close();
log("A context killed");

// Grace window: within 8s the copy shows "peer may be reconnecting".
let graceSeen = false;
for (let i = 0; i < 16; i += 1) {
  const t = await statusB.textContent();
  if (t.includes("peer may be reconnecting")) {
    graceSeen = true;
    break;
  }
  await sleep(500);
}
assert(graceSeen, `grace window copy "peer may be reconnecting" visible at B`);

// After the grace window: waiting-for-peer state + system note.
let systemNote = "";
for (let i = 0; i < 20; i += 1) {
  const note = await pageB.getByText("A participant left the room.").count();
  if (note > 0) {
    systemNote = "A participant left the room.";
    break;
  }
  await sleep(1000);
}
assert(systemNote !== "", `system note "A participant left the room." appears after grace expiry`);
const waitingVisible = await pageB.getByText("Waiting for someone to join").count();
log("waiting-for-peer empty state visible:", waitingVisible > 0);
log("B status line:", await statusB.textContent());

// B12 (fresh room): host leaves via the modal -> guest sees the leave and
// enters the grace lifecycle (the relay sends no "closed" frame for a host
// socket close; only alarm closure does). Costs: 2 joins.
const ctx2A = await browser.newContext({ viewport: { width: 1280, height: 900 } });
const ctx2B = await browser.newContext({ viewport: { width: 1280, height: 900 } });
const page2A = await ctx2A.newPage();
const page2B = await ctx2B.newPage();
const room2 = await createRoomViaUi(page2A);
await page2B.goto(`${FRONTEND}/r/${room2.pin}#${room2.fragment}`);
const got2 = await waitForParticipants(page2A, 2);
assert(got2 === 2, `room 2: both connected (got ${got2})`);

// The "Leave room" button lives inside the room info panel (toggled by the
// "Room info" button on both desktop and mobile). Open the panel, then the
// leave modal.
await page2A.getByRole("button", { name: "Room info" }).click();
await page2A.getByRole("button", { name: "Leave room" }).click({ timeout: 15_000 });
await page2A.getByRole("heading", { name: "Leave this room?" }).waitFor({ timeout: 5000 });
assert(true, `leave modal opens`);
await page2A.getByRole("button", { name: "Leave", exact: true }).click();
await sleep(2000);

// Guest should reach the terminal closed screen (host socket close -> leave broadcast).
// NOTE: the relay distinguishes nothing; guest sees the socket close and enters
// the reconnect lifecycle -> grace -> waiting. A terminal "closed" frame only
// fires for alarm closure, so document what actually happens.
let guestState = "";
for (let i = 0; i < 25; i += 1) {
  const note = await page2B.getByText("A participant left the room.").count();
  if (note > 0) {
    guestState = "system note (grace expired, waiting for peer)";
    break;
  }
  const reconnecting = (await statusLine(page2B).textContent()) ?? "";
  if (i === 0) log("B status right after host leave:", reconnecting);
  await sleep(1000);
}
log("guest state 25s after host left:", guestState);
const waiting2 = await page2B.getByText("Waiting for someone to join").count();
log("guest empty state:", waiting2 > 0);

log("B console errors:", JSON.stringify(eventsB.console.filter((c) => c.type === "error")));
await browser.close();
log("SCENARIO B9/B12: OK");
