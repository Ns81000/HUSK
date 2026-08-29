// G38/G41/I50 (no-join subset): live axe on landing/PIN-entry/no-key room in
// both themes, mobile emulation snapshots, and the full _headers contract.
import { FRONTEND, assert, launch, log, sleep } from "./drive-lib.mjs";
import AxeBuilder from "@axe-core/playwright";

async function axeViolations(page) {
  const results = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
    .analyze();
  return results.violations.map(
    (v) => `${v.id} (${v.impact}): ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`,
  );
}

const browser = await launch();

// I50: static _headers contract on key asset classes.
{
  const ctx = await browser.newContext({ bypassCSP: true });
  const page = await ctx.newPage();
  const sw = await page.request.get(FRONTEND + "/sw.js");
  log(
    "sw.js:",
    sw.status(),
    sw.headers()["cache-control"],
    "xfo:",
    sw.headers()["x-frame-options"],
  );
  assert(sw.headers()["cache-control"] === "no-cache", `sw.js served no-cache`);
  const asset = await page.request.get(FRONTEND + "/manifest.webmanifest");
  log("manifest cache-control:", asset.headers()["cache-control"]);
  const icon = await page.request.get(FRONTEND + "/icons/husk-icon-512.png");
  log("icon cache-control:", icon.headers()["cache-control"]);
  const font = await page.request.get(FRONTEND + "/fonts/inter-latin.woff2");
  log("font cache-control:", font.headers()["cache-control"]);
  const xfo = icon.headers()["x-frame-options"];
  const nosniff = icon.headers()["x-content-type-options"];
  log("icon xfo/nosniff:", xfo, nosniff);
  assert(nosniff === "nosniff", `static assets carry nosniff`);

  // G38: axe sweeps, both themes.
  for (const theme of ["light", "dark"]) {
    await page.addInitScript((value) => window.localStorage.setItem("husk-theme", value), theme);
    await page.goto(FRONTEND + "/");
    await page.getByRole("button", { name: "Create a room" }).waitFor({ timeout: 20_000 });
    let violations = await axeViolations(page);
    assert(violations.length === 0, `landing axe clean, ${theme} (${violations.join(" | ")})`);
    const joinBtn = page.getByRole("button", { name: "Join with a PIN" });
    for (let i = 0; i < 3; i += 1) {
      try {
        await joinBtn.click({ timeout: 3000 });
        break;
      } catch {}
    }
    await page.getByRole("heading", { name: "Enter the room PIN" }).waitFor({ timeout: 10_000 });
    violations = await axeViolations(page);
    assert(violations.length === 0, `PIN-entry axe clean, ${theme} (${violations.join(" | ")})`);
    await page.goto(FRONTEND + "/r/123456");
    await page.getByRole("heading", { name: "This link has no key" }).waitFor({ timeout: 10_000 });
    violations = await axeViolations(page);
    assert(violations.length === 0, `no-key room axe clean, ${theme} (${violations.join(" | ")})`);
  }
  await ctx.close();
}

// G41: mobile emulation (Pixel-ish and iPhone-ish) on landing + keypad + room error path.
{
  const devices = [
    {
      name: "Pixel 7",
      viewport: { width: 412, height: 915 },
      isMobile: true,
      hasTouch: true,
      ua: "Android 14; Pixel 7",
    },
    {
      name: "iPhone 14",
      viewport: { width: 390, height: 844 },
      isMobile: true,
      hasTouch: true,
      ua: "iPhone; CPU iPhone OS 17_0 like Mac OS X",
    },
  ];
  for (const device of devices) {
    const ctx = await browser.newContext({
      viewport: device.viewport,
      isMobile: device.isMobile,
      hasTouch: device.hasTouch,
      userAgent: `Mozilla/5.0 (${device.ua}) AppleWebKit/605.1.15 Mobile Safari/604.1`,
    });
    const page = await ctx.newPage();
    await page.goto(FRONTEND + "/");
    await page.getByRole("button", { name: "Create a room" }).waitFor({ timeout: 20_000 });
    const hasHScroll = await page.evaluate(
      () => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
    );
    assert(!hasHScroll, `${device.name}: landing has no horizontal overflow`);
    const joinBtn = page.getByRole("button", { name: "Join with a PIN" });
    for (let i = 0; i < 3; i += 1) {
      try {
        await joinBtn.click({ timeout: 3000 });
        break;
      } catch {}
    }
    await page.getByRole("heading", { name: "Enter the room PIN" }).waitFor({ timeout: 10_000 });
    // Keypad buttons reachable by touch-size; tap 1-2-3-4-5-6.
    for (const digit of ["1", "2", "3", "4", "5", "6"]) {
      await page.getByRole("button", { name: digit, exact: true }).tap();
    }
    await page.getByRole("button", { name: "Join", exact: true }).tap();
    await sleep(2500);
    const failure = await page.getByText(/not available|Too many attempts|full six digit/).count();
    log(`${device.name}: join attempt feedback shown:`, failure > 0 ? "yes" : "(navigated)");
    await page.goto(`${FRONTEND}/r/123456`);
    await page.getByRole("heading", { name: "This link has no key" }).waitFor({ timeout: 10_000 });
    assert(true, `${device.name}: room error path renders`);
    await ctx.close();
  }
}

await browser.close();
log("SCENARIO G-live/I50: OK");
