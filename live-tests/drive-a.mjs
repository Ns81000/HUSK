// Group A (browser): A creates via UI, B joins via link; messaging both ways;
// small + mid file with byte equality; XSS payloads inert. Costs: 2 joins.
import {
  FRONTEND,
  assert,
  attachFile,
  launch,
  log,
  monitor,
  participantCount,
  sendText,
  sleep,
} from "./drive-lib.mjs";
import { createRoomViaUi } from "./drive-lib.mjs";
import { writeFileSync, readFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join as joinPath } from "node:path";

const scratch = mkdtempSync(joinPath(tmpdir(), "husk-live-"));
function makeFile(name, size, fill) {
  const bytes = Buffer.alloc(size, fill);
  for (let i = 0; i < size; i += 65536)
    crypto.getRandomValues(bytes.subarray(i, Math.min(size, i + 65536)));
  const path = joinPath(scratch, name);
  writeFileSync(path, bytes);
  return path;
}

const browser = await launch();
const ctxA = await browser.newContext({ viewport: { width: 1280, height: 900 } });
const ctxB = await browser.newContext({ viewport: { width: 1280, height: 900 } });
const pageA = await ctxA.newPage();
const eventsA = monitor(pageA, "A");
const pageB = await ctxB.newPage();
const eventsB = monitor(pageB, "B");

// A1: create + join via link (fragment never typed anywhere server-visible).
const { pin, fragment } = await createRoomViaUi(pageA);
log("room:", pin, "fragment length:", fragment.length);
assert(fragment.length > 0, `creator URL carries the key fragment`);
const link = `${FRONTEND}/r/${pin}#${fragment}`;
await pageB.goto(link);
await pageB.waitForURL(/\/r\/\d+/);
await sleep(2500);
const countA = await participantCount(pageA);
const countB = await participantCount(pageB);
assert(countA === 2, `A sees 2 participants (got ${countA})`);
assert(countB === 2, `B sees 2 participants (got ${countB})`);

// A2: text both directions.
await sendText(pageA, "hello from A");
await pageB.getByText("hello from A").waitFor({ timeout: 10_000 });
assert(true, `B received A's text`);
await sendText(pageB, "reply from B");
await pageA.getByText("reply from B").waitFor({ timeout: 10_000 });
assert(true, `A received B's text`);
await sleep(1500);
const sentBadges = await pageA.getByText("Sent", { exact: false }).count();
log("A delivery notes:", sentBadges);

// A5 + E31: XSS payloads are inert in the real browser.
await sendText(pageA, "javascript:alert(1) click me");
await sendText(pageA, "data:text/html,<script>alert(2)</script>");
await sendText(pageA, "<img src=x onerror=window.__xss=1>");
await pageB.getByText("<img src=x onerror=window.__xss=1>").waitFor({ timeout: 10_000 });
const xssHref = await pageB.evaluate(() => {
  const anchors = [...document.querySelectorAll("a")];
  return anchors.map((a) => a.getAttribute("href"));
});
assert(
  !xssHref.some((href) => href && (href.startsWith("javascript:") || href.startsWith("data:"))),
  `no javascript:/data: hrefs rendered (${JSON.stringify(xssHref)})`,
);
assert(await pageB.evaluate(() => window.__xss === undefined), `onerror payload never executed`);
assert(eventsB.pageerrors.length === 0, `zero pageerrors at B after payloads`);

// A3: small file A -> B with byte equality.
const smallPath = makeFile("small.bin", 10 * 1024, 1);
await attachFile(pageA, smallPath);
const smallBytes = readFileSync(smallPath);
await pageB.getByText("small.bin").waitFor({ timeout: 30_000 });
const [dlSmall] = await Promise.all([
  pageB.waitForEvent("download", { timeout: 30_000 }),
  pageB.getByRole("button", { name: "Download file" }).first().click(),
]);
const dlSmallPath = joinPath(scratch, "dl-small.bin");
await dlSmall.saveAs(dlSmallPath);
assert(
  Buffer.compare(readFileSync(dlSmallPath), smallBytes) === 0,
  `small file byte-identical A -> B`,
);

// A3: mid file B -> A.
const midPath = makeFile("mid.bin", 3 * 1024 * 1024, 2);
await attachFile(pageB, midPath);
const midBytes = readFileSync(midPath);
await pageA.getByText("mid.bin").waitFor({ timeout: 60_000 });
const [dlMid] = await Promise.all([
  pageA.waitForEvent("download", { timeout: 60_000 }),
  pageA
    .locator("div.rounded-md.border")
    .filter({ hasText: "mid.bin" })
    .getByRole("button", { name: "Download file" })
    .click(),
]);
const dlMidPath = joinPath(scratch, "dl-mid.bin");
await dlMid.saveAs(dlMidPath);
assert(Buffer.compare(readFileSync(dlMidPath), midBytes) === 0, `3 MB file byte-identical B -> A`);

// Console/telemetry sanity on both sides.
await sleep(1000);
log("A console errors:", JSON.stringify(eventsA.console.filter((c) => c.type === "error")));
log("B console errors:", JSON.stringify(eventsB.console.filter((c) => c.type === "error")));
log("A >=400 responses:", JSON.stringify(eventsA.badResponses));
log("B >=400 responses:", JSON.stringify(eventsB.badResponses));
log("relay POST bodies seen by A:", JSON.stringify(eventsA.posts.slice(0, 3)));

await browser.close();
log("SCENARIO A-browser: OK");
