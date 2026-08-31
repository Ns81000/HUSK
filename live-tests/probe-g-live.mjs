// G38/G41/I50 (room-link flow): live axe on landing/room-error paths in both
// themes, mobile emulation snapshots, and the static _headers contract. The
// app has no PIN entry anymore: joining happens by opening /r/<roomId>#<key>.
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

// A syntactically valid room id and a 32-byte base64url key fragment: the room
// does not exist on the relay, so the join lands on the "Room unavailable"
// error screen — a fully rendered page suitable for axe sweeps.
const ROOM_ID = "123456ab";
const KEY = "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY";

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

  // G38: axe sweeps, both themes, over the room-link flow surfaces.
  for (const theme of ["light", "dark"]) {
    await page.addInitScript((value) => window.localStorage.setItem("husk-theme", value), theme);
    await page.goto(FRONTEND + "/");
    await page.getByRole("button", { name: "Create a room" }).waitFor({ timeout: 20_000 });
    let violations = await axeViolations(page);
    assert(violations.length === 0, `landing axe clean, ${theme} (${violations.join(" | ")})`);

    // Keyless invite link: the client-side guard screen.
    await page.goto(`${FRONTEND}/r/${ROOM_ID}`);
    await page.getByRole("heading", { name: "This link has no key" }).waitFor({ timeout: 10_000 });
    violations = await axeViolations(page);
    assert(violations.length === 0, `no-key room axe clean, ${theme} (${violations.join(" | ")})`);

    // Well-formed link for a room that does not exist: the join refusal path.
    // Generous timeout: on a degraded network SSR + hydrate + the join round
    // trip can take well over 20 s. The about:blank hop forces a fresh
    // document — a same-path hash-only navigation would not remount the
    // route, and the previous screen (no-key) would stick.
    await page.goto("about:blank");
    await page.goto(`${FRONTEND}/r/${ROOM_ID}#${KEY}`, { waitUntil: "domcontentloaded" });
    await page
      .getByRole("heading", { name: /Room unavailable|Disconnected|Room closed|Too many attempts/ })
      .waitFor({ timeout: 60_000 });
    violations = await axeViolations(page);
    assert(violations.length === 0, `dead-room axe clean, ${theme} (${violations.join(" | ")})`);
  }
  await ctx.close();
}

// G41: mobile emulation (Pixel-ish and iPhone-ish) on landing + room error path.
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
    // Room error path under touch viewport.
    await page.goto(`${FRONTEND}/r/${ROOM_ID}`);
    await page.getByRole("heading", { name: "This link has no key" }).waitFor({ timeout: 10_000 });
    assert(true, `${device.name}: no-key room error path renders`);
    await ctx.close();
  }
}

await browser.close();
await sleep(200);
log("SCENARIO G-live/I50: OK");
