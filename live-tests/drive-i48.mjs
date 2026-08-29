// I48: redeploy the relay WHILE a room is active with connected sockets.
// Clients must reconnect; the room survives; seq continues. Also probes the
// documented create-during-deploy-churn anomaly. Costs: 2 joins.
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
import { execSync } from "node:child_process";
import { existsSync, rmSync } from "node:fs";

const browser = await launch();
const ctxA = await browser.newContext({ viewport: { width: 1280, height: 900 } });
const ctxB = await browser.newContext({ viewport: { width: 1280, height: 900 } });
const pageA = await ctxA.newPage();
const eventsA = monitor(pageA, "A");
const pageB = await ctxB.newPage();
const eventsB = monitor(pageB, "B");

const { pin, fragment } = await createRoomViaUi(pageA);
await pageB.goto(`${FRONTEND}/r/${pin}#${fragment}`);
assert((await waitForParticipants(pageA, 2)) === 2, `both connected`);

// Baseline message before the redeploy.
await pageA.getByRole("textbox", { name: "Message" }).fill("before-redeploy");
await pageA.getByRole("textbox", { name: "Message" }).press("Enter");
await pageB.getByText("before-redeploy").waitFor({ timeout: 10_000 });
await sleep(1000);

// Redeploy the relay out from under the live sockets.
const deployConfig = "c:/Users/Ns8pc/Pictures/HUSK/.wrangler/deploy/config.json";
if (existsSync(deployConfig)) rmSync(deployConfig, { force: true });
log("redeploying relay...");
const out = execSync("pnpm exec wrangler deploy", {
  cwd: "c:/Users/Ns8pc/Pictures/HUSK/worker",
  encoding: "utf8",
  shell: "cmd.exe",
});
const versionLine = out.split("\n").find((line) => line.includes("Current Version ID"));
log("deploy:", versionLine?.trim());

// Watch both statuses: expect a transient Reconnecting then Connected.
async function waitConnected(page, label, timeoutMs = 120_000) {
  const start = Date.now();
  let sawReconnecting = false;
  while (Date.now() - start < timeoutMs) {
    const status = await statusLine(page).textContent();
    if (status.includes("Reconnecting")) sawReconnecting = true;
    if (status.includes("Connected") && sawReconnecting) return true;
    if (status.includes("Connected") && Date.now() - start > 15_000) return true;
    await sleep(1500);
  }
  return false;
}
const aOk = await waitConnected(pageA, "A");
const bOk = await waitConnected(pageB, "B");
log("A reconnected:", aOk, "| B reconnected:", bOk);
assert(aOk && bOk, `both clients reconnect after the redeploy`);

// The room still works: message flows, and no duplicate of the pre-deploy one.
await pageA.getByRole("textbox", { name: "Message" }).fill("after-redeploy");
await pageA.getByRole("textbox", { name: "Message" }).press("Enter");
await pageB.getByText("after-redeploy").waitFor({ timeout: 15_000 });
const dupBefore = await pageB.getByText("before-redeploy").count();
assert(dupBefore === 1, `pre-deploy message still exactly once (no replay dup)`);

// The documented create-during-deploy-churn anomaly: create a room right
// after deploy and check it is usable.
const pageC = await ctxB.newPage();
const churn = await createRoomViaUi(pageC).catch((e) => ({ error: String(e).slice(0, 120) }));
if (churn.error) {
  log("create-during-churn anomaly reproduced:", churn.error);
} else {
  log("post-deploy create OK, pin:", churn.pin);
  const state = await pageC
    .getByText(/Waiting for someone to join|Room unavailable|Disconnected/)
    .count();
  log("post-deploy room state markers:", state);
}

log("A console errors:", JSON.stringify(eventsA.console.filter((c) => c.type === "error")));
log("B console errors:", JSON.stringify(eventsB.console.filter((c) => c.type === "error")));
await browser.close();
log("SCENARIO I48: OK");
