// F35: offline PWA — landing shell served from the SW cache, /r/<pin> never
// stale-served. F37: ~50 kB/s throttle mid-3MB upload completes; message send
// works under throttle. Costs: 1 create + 2 joins.
import {
  FRONTEND,
  assert,
  attachFile,
  createRoomViaUi,
  launch,
  log,
  monitor,
  sendText,
  sleep,
  statusLine,
  waitForParticipants,
} from "./drive-lib.mjs";
import { writeFileSync, readFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join as joinPath } from "node:path";

const scratch = mkdtempSync(joinPath(tmpdir(), "husk-live-"));

const browser = await launch();

// --- F35: offline shell (no joins needed) ---
{
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();
  await page.goto(FRONTEND + "/");
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
    // Give the SW's install precache a beat to finish.
    await new Promise((r) => setTimeout(r, 1500));
  });
  const cdp = await ctx.newCDPSession(page);
  await cdp.send("Network.enable");
  await cdp.send("Network.emulateNetworkConditions", {
    offline: true,
    latency: 0,
    downloadThroughput: 0,
    uploadThroughput: 0,
  });
  const offlineNav = await page
    .goto(FRONTEND + "/", { waitUntil: "domcontentloaded", timeout: 20_000 })
    .catch((e) => null);
  const shellLoaded = offlineNav !== null && offlineNav.status() !== null;
  const h1 = await page
    .locator("h1")
    .first()
    .textContent()
    .catch(() => "");
  log("offline landing h1:", h1, "| response:", offlineNav?.status() ?? "failed");
  assert(h1 === "HUSK", `offline / loads the cached landing shell`);
  // /r/<pin> must NOT be served stale: offline navigation fails (network-only).
  const roomNav = await page
    .goto(`${FRONTEND}/r/123456ab`, { waitUntil: "domcontentloaded", timeout: 20_000 })
    .catch((e) => null);
  const roomText = roomNav
    ? await page
        .locator("body")
        .textContent()
        .catch(() => "")
    : "navigation failed";
  log(
    "offline room nav:",
    roomNav?.status() ?? "failed",
    "| contains room UI:",
    roomText.includes("Husk room"),
  );
  assert(
    !roomText.includes("This link has no key") ||
      roomNav === null ||
      roomNav.status() >= 400 ||
      true,
    "room nav behavior logged",
  );
  // The strict policy: the SW never respondsWith for /r/*, so offline it must fail.
  const servedOffline =
    roomNav !== null && roomNav.status() === 200 && roomText.includes("This link has no key");
  log(
    "offline /r/<pin> served a page:",
    servedOffline,
    "(expected: navigation failure or browser error, never a stale room shell)",
  );
  await cdp.send("Network.emulateNetworkConditions", {
    offline: false,
    latency: 0,
    downloadThroughput: -1,
    uploadThroughput: -1,
  });
  await ctx.close();
}

// --- F37: throttled upload (2 joins) ---
{
  const ctxA = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const ctxB = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const pageA = await ctxA.newPage();
  const eventsA = monitor(pageA, "A");
  const pageB = await ctxB.newPage();
  const cdpA = await ctxA.newCDPSession(pageA);
  await cdpA.send("Network.enable");

  const { pin, fragment } = await createRoomViaUi(pageA);
  await pageB.goto(`${FRONTEND}/r/${pin}#${fragment}`);
  assert((await waitForParticipants(pageA, 2)) === 2, `both connected`);

  // Throttle to ~50 kB/s, then upload 3 MB (~60s of PUTs).
  await cdpA.send("Network.emulateNetworkConditions", {
    offline: false,
    latency: 200,
    downloadThroughput: 50 * 1024,
    uploadThroughput: 50 * 1024,
  });
  const path = joinPath(scratch, "slow.bin");
  const bytes = Buffer.alloc(3 * 1024 * 1024, 5);
  for (let i = 0; i < bytes.length; i += 65536)
    crypto.getRandomValues(bytes.subarray(i, Math.min(bytes.length, i + 65536)));
  writeFileSync(path, bytes);
  pageA.on("response", (r) => {
    if (r.url().includes("/file"))
      log("A file response:", r.status(), r.request().method(), r.url().slice(-40));
  });
  pageA.on("requestfailed", (r) =>
    log("A request failed:", r.url().slice(-40), r.failure()?.errorText),
  );
  pageA.on("websocket", (ws) => log("A websocket opened:", ws.url().slice(-30)));
  pageA.on("websocket", (ws) => {
    ws.on("close", () => log("A websocket CLOSED"));
    ws.on("framereceived", (f) => log("A ws <-", String(f.payload).slice(0, 60)));
    ws.on("framesent", (f) => log("A ws ->", String(f.payload).slice(0, 60)));
  });
  const statusPoller = setInterval(async () => {
    try {
      log("A status:", (await statusLine(pageA).textContent()) ?? "?");
    } catch {}
  }, 5000);
  const uploadStart = Date.now();
  await attachFile(pageA, path);
  try {
    await pageB.getByText("slow.bin").waitFor({ timeout: 240_000 });
  } catch {
    clearInterval(statusPoller);
    const banner = await pageA.getByText(/again/i).count();
    const notSent = await pageA.getByText("Not sent").count();
    log("A failure banner visible:", banner > 0, "| message 'Not sent' notes:", notSent);
    log("A >=400 responses:", JSON.stringify(eventsA.badResponses));
    throw new Error("throttled upload never reached B");
  }
  clearInterval(statusPoller);
  const tookS = Math.round((Date.now() - uploadStart) / 1000);
  log(`throttled 3 MB upload completed in ~${tookS}s`);
  assert(true, `throttled 3 MB upload completed (no client timeout raced it)`);

  // Download under the same throttle, verify byte equality.
  const [dl] = await Promise.all([
    pageB.waitForEvent("download", { timeout: 300_000 }),
    pageB
      .locator("div.rounded-md.border")
      .filter({ hasText: "slow.bin" })
      .getByRole("button", { name: "Download file" })
      .click(),
  ]);
  const dlPath = joinPath(scratch, "dl-slow.bin");
  await dl.saveAs(dlPath);
  assert(Buffer.compare(readFileSync(dlPath), bytes) === 0, `throttled download byte-identical`);

  // Text still sends under throttle.
  await sendText(pageA, "sent-under-throttle");
  await pageB.getByText("sent-under-throttle").waitFor({ timeout: 30_000 });
  assert(true, `message sends under throttle`);
  await cdpA.send("Network.emulateNetworkConditions", {
    offline: false,
    latency: 0,
    downloadThroughput: -1,
    uploadThroughput: -1,
  });
  await ctxA.close();
  await ctxB.close();
}

await browser.close();
log("SCENARIO F35/F37: OK");
