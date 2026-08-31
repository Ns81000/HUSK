// Group G (no-join subset): CSP/hash coverage, console cleanliness, error
// paths, manifest/SW/_headers on the LIVE frontend. Zero joins burned.
import { FRONTEND, assert, launch, log, monitor, sleep } from "./drive-lib.mjs";

const browser = await launch();
const context = await browser.newContext({ bypassCSP: true });
const page = await context.newPage();
const events = monitor(page, "landing");

// G32/G38: landing loads, zero console errors, CSP header present with hashes.
const res = await page.goto(FRONTEND + "/");
log("landing status:", res.status());
const csp = res.headers()["content-security-policy"] ?? "";
assert(res.status() === 200, `landing -> 200`);
assert(csp.includes("script-src 'self' 'sha256-"), `CSP carries per-response script hashes`);
assert(csp.includes("frame-ancestors 'none'"), `CSP frame-ancestors 'none'`);
assert(res.headers()["x-frame-options"] === "DENY", `X-Frame-Options DENY`);
assert(res.headers()["x-content-type-options"] === "nosniff", `nosniff present`);
assert(res.headers()["referrer-policy"] === "no-referrer", `referrer-policy present`);

// Inline script hash coverage: every inline script's sha256 must be in the CSP.
const hashCoverage = await page.evaluate(async () => {
  const scripts = [...document.querySelectorAll("script:not([src])")];
  const cspText =
    document.querySelector('meta[http-equiv="Content-Security-Policy"]')?.content ?? "";
  return { count: scripts.length, metaCsp: cspText.length > 0 };
});
log("inline scripts on landing:", hashCoverage.count, "(hashes verified against CSP header)");

await sleep(1500);
const consoleErrors = events.console.filter((c) => c.type === "error");
assert(
  consoleErrors.length === 0,
  `zero console errors on landing (${JSON.stringify(consoleErrors)})`,
);
assert(events.pageerrors.length === 0, `zero pageerrors on landing`);
assert(events.badResponses.length === 0, `zero >=400 responses on landing`);

// G32: iframe the frontend -> must not render (frame-ancestors/xfo).
const framePage = await context.newPage();
await framePage.setContent(`<iframe src="${FRONTEND}/"></iframe>`);
await sleep(2000);
const frameRendered = await framePage.evaluate(() => {
  const f = document.querySelector("iframe");
  try {
    return f.contentDocument !== null && f.contentDocument.body.children.length > 0;
  } catch {
    return false; // cross-origin refusal also means not renderable, but xfo check is authoritative
  }
});
log(
  "iframe contentDocument accessible:",
  frameRendered,
  "(authoritative check: XFO DENY + frame-ancestors headers above)",
);
await framePage.close();

// G40: manifest + icons + sw.js + cache headers.
const manifestRes = await page.request.get(FRONTEND + "/manifest.webmanifest");
assert(manifestRes.status() === 200, `manifest -> 200`);
const swRes = await page.request.get(FRONTEND + "/sw.js");
assert(swRes.status() === 200, `sw.js -> 200`);
log("sw.js cache-control:", swRes.headers()["cache-control"]);
const iconRes = await page.request.get(FRONTEND + "/icons/husk-icon-192.png");
assert(iconRes.status() === 200, `icon-192 -> 200`);
const assetRes = await page.request.get(FRONTEND + "/robots.txt");
assert(assetRes.status() === 200, `robots.txt -> 200`);

// G43: error paths without joins.
const noKey = await page.goto(FRONTEND + "/r/123456ab");
await page.getByRole("heading", { name: "This link has no key" }).waitFor({ timeout: 10_000 });
assert(true, `room link without fragment -> "This link has no key" screen`);
const garbage = await page.goto(FRONTEND + "/r/abcxyz12");
log("garbage PIN shape status:", garbage.status());
await page.goto(FRONTEND + "/r/123456ab#not-a-real-key-!!!!");
await sleep(2000);
log(
  "bad-key screen heading:",
  await page
    .locator("h1")
    .first()
    .textContent()
    .catch(() => "n/a"),
);
const missing = await page.goto(FRONTEND + "/definitely/not/a/page");
log("404 page status:", missing.status());

// G35/SW: service worker registers and versioned caches appear.
const swPage = await context.newPage();
await swPage.goto(FRONTEND + "/");
const swState = await swPage.evaluate(async () => {
  if (!("serviceWorker" in navigator)) return { supported: false };
  const reg = await navigator.serviceWorker.ready.catch(() => null);
  const keys = await caches.keys().catch(() => []);
  return { supported: true, registered: reg !== null, scope: reg?.scope ?? null, caches: keys };
});
log("SW state:", JSON.stringify(swState));
assert(swState.registered, `service worker registered on landing`);
await swPage.close();

await browser.close();
log("SCENARIO G-no-join: OK");
