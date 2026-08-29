// C14 (rapid double-send), C15 (duplicate tab as distinct participant).
// Costs: 1 create + 2 joins (A + B) + 1 join (duplicate tab of A).
import {
  FRONTEND,
  assert,
  attachFile,
  createRoomViaUi,
  launch,
  log,
  monitor,
  messageCount,
  participantCount,
  sendText,
  sleep,
  statusLine,
} from "./drive-lib.mjs";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join as joinPath } from "node:path";

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
assert((await participantCount(pageA)) === 2, `both connected`);

// C14: rapid double-send (spam Enter). One bubble per send, all acked.
const composer = pageA.getByRole("textbox", { name: "Message" });
await composer.fill("spam-one");
await composer.press("Enter");
await composer.fill("spam-two");
await composer.press("Enter");
await composer.fill("spam-three");
await composer.press("Enter");
await pageB.getByText("spam-three").waitFor({ timeout: 10_000 });
await sleep(1500);
for (const text of ["spam-one", "spam-two", "spam-three"]) {
  const atA = await pageA.getByText(text).count();
  const atB = await pageB.getByText(text).count();
  assert(atA === 1 && atB === 1, `"${text}" exactly one bubble on each side (A:${atA} B:${atB})`);
}
// No "Not sent" notes.
const notSent = await pageA.getByText("Not sent").count();
assert(notSent === 0, `all sends acked (no "Not sent")`);

// C15: same room in a second tab of context A -> distinct participant, both
// relay, count includes both (documented intended behavior).
const pageA2 = await ctxA.newPage();
const eventsA2 = monitor(pageA2, "A2");
await pageA2.goto(`${FRONTEND}/r/${pin}#${fragment}`);
await sleep(3000);
const countB = await participantCount(pageB);
assert(countB === 3, `duplicate tab counts as a distinct participant (B sees ${countB})`);
await sendText(pageA2, "from the second tab");
await pageB.getByText("from the second tab").waitFor({ timeout: 10_000 });
assert(true, `second tab's relay reaches B`);
const inA = await pageA.getByText("from the second tab").count();
assert(inA === 1, `first tab also receives the second tab's relay`);

log("A console errors:", JSON.stringify(eventsA.console.filter((c) => c.type === "error")));
log("A2 console errors:", JSON.stringify(eventsA2.console.filter((c) => c.type === "error")));
log("B console errors:", JSON.stringify(eventsB.console.filter((c) => c.type === "error")));
await browser.close();
log("SCENARIO C14/C15: OK");
