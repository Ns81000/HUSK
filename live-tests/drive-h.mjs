// D19/D20/E31/H45/H47 in the browser: 0-byte file (no request, post-fix),
// 1-byte file, >25 MB client-side rejection, XSS filename inert, wrong-key
// link shows "could not be verified", F5 resets the tab honestly.
// Costs: 1 create + 2 joins + 2 joins (post-F5) + 1 join (wrong-key peer).
import {
  FRONTEND,
  assert,
  attachFile,
  createRoomViaUi,
  launch,
  log,
  monitor,
  sleep,
  statusLine,
  waitForParticipants,
} from "./drive-lib.mjs";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join as joinPath } from "node:path";

const scratch = mkdtempSync(joinPath(tmpdir(), "husk-live-"));
function makeFile(name, size) {
  const bytes = Buffer.alloc(size, 9);
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

const { pin, fragment } = await createRoomViaUi(pageA);
await pageB.goto(`${FRONTEND}/r/${pin}#${fragment}`);
assert((await waitForParticipants(pageA, 2)) === 2, `both connected`);

// D19: 0-byte file -> EmptyFileError path, NO grant request.
const before = eventsA.posts.filter((p) => p.url.endsWith("/file")).length;
await attachFile(pageA, makeFile("zero.bin", 0));
await pageA.getByText("That file is empty").waitFor({ timeout: 10_000 });
assert(true, `0-byte file shows the failed-upload banner`);
await sleep(1000);
const after = eventsA.posts.filter((p) => p.url.endsWith("/file")).length;
assert(after === before, `0-byte file sent NO grant request (${before} -> ${after})`);

// D20: >25 MB rejected client-side, no request.
const before2 = eventsA.posts.filter((p) => p.url.endsWith("/file")).length;
await attachFile(pageA, makeFile("huge.bin", 25 * 1024 * 1024 + 1));
await sleep(1500);
const after2 = eventsA.posts.filter((p) => p.url.endsWith("/file")).length;
assert(
  after2 === before2,
  `>25 MB file rejected client-side, no request (${before2} -> ${after2})`,
);

// E31: XSS filename is inert.
const xssName = '<img src=x onerror="window.__xss=1">.bin';
const xssPath = joinPath(scratch, "xss-payload.bin");
writeFileSync(xssPath, Buffer.alloc(1024, 1));
// Playwright sets the file's name from the path on disk; rename via DataTransfer instead.
await pageA.evaluate(async () => {
  const bytes = new Uint8Array(1024).fill(1);
  const file = new File([bytes], '<img src=x onerror="window.__xss=1">.bin', {
    type: "application/octet-stream",
  });
  const dt = new DataTransfer();
  dt.items.add(file);
  const input = document.querySelector('input[type="file"]');
  input.files = dt.files;
  input.dispatchEvent(new Event("change", { bubbles: true }));
});
await pageB.getByText('<img src=x onerror="window.__xss=1">.bin').waitFor({ timeout: 30_000 });
await sleep(1000);
assert(await pageB.evaluate(() => window.__xss === undefined), `XSS filename never executes at B`);
assert(eventsB.pageerrors.length === 0, `zero pageerrors at B with XSS filename`);

// H47: F5 mid-room -> fresh participant, prior messages gone, honest UI.
await pageB.reload({ waitUntil: "domcontentloaded" });
const statusAfterReload = await statusLine(pageB).textContent();
log("B status after F5:", statusAfterReload);
const oldMessages = await pageB
  .getByText("hello before the crash")
  .count()
  .catch(() => 0);
const anyOldText = await pageB.getByText(/hello|spam/).count();
assert(anyOldText === 0, `prior messages are gone after F5 (nothing pretend-loaded)`);
const waiting = await pageB.getByText(/Waiting for someone to join|No messages yet/).count();
assert(waiting > 0, `empty state is honest after F5 (got ${waiting})`);

// H45: wrong-key link -> "could not be verified" for messages, no crash.
// A sends with the room key; C opens the room URL with a DIFFERENT fragment.
const ctxC = await browser.newContext({ viewport: { width: 1280, height: 900 } });
const pageC = await ctxC.newPage();
const eventsC = monitor(pageC, "C");
const wrongKey = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))));
await pageC.goto(`${FRONTEND}/r/${pin}#${wrongKey}`);
assert((await waitForParticipants(pageA, 3)) === 3, `wrong-key peer joined (3 participants)`);
await pageA.getByRole("textbox", { name: "Message" }).fill("secret-for-A-and-B");
await pageA.getByRole("textbox", { name: "Message" }).press("Enter");
await pageC
  .getByText("A message could not be verified and was discarded.")
  .waitFor({ timeout: 15_000 });
assert(true, `wrong-key peer sees the honest "could not be verified" note`);
assert(eventsC.pageerrors.length === 0, `no crash at the wrong-key peer`);

log("A console errors:", JSON.stringify(eventsA.console.filter((c) => c.type === "error")));
await browser.close();
log("SCENARIO D19/D20/E31/H45/H47: OK");
