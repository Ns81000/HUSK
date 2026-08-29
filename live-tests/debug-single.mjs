// Debug: create via UI, dump page state.
import {
  FRONTEND,
  launch,
  log,
  monitor,
  sleep,
  statusLine,
  waitForParticipants,
} from "./drive-lib.mjs";

const browser = await launch();
const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
const page = await ctx.newPage();
const events = monitor(page, "dbg");
page.on("response", (r) => log("response:", r.status(), r.url().slice(0, 90)));
await page.goto(FRONTEND + "/", { waitUntil: "domcontentloaded" });
await sleep(3000);
const button = page.getByRole("button", { name: "Create a room" });
log("button count:", await button.count());
log("button visible:", await button.isVisible().catch((e) => `err ${e}`));
log("body text sample:", (await page.locator("body").textContent()).slice(0, 300));
try {
  await button.click({ timeout: 8000 });
} catch {
  log("CLICK FAILED - screenshotting");
  await page.screenshot({ path: "live-tests/debug-landing.png", fullPage: true });
  log("boxes:", JSON.stringify(await button.boundingBox().catch((e) => `err ${e}`)));
}
await browser.close();
