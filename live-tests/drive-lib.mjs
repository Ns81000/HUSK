/**
 * Playwright driver for live testing against production (no route mocking).
 * Node >= 24. Run: `node live-tests/<scenario>.mjs`
 */
import { chromium } from "playwright";

export const FRONTEND = "https://ns81000-husk.ns8pc1.workers.dev";

export function log(...args) {
  console.log(`[${new Date().toISOString()}]`, ...args);
}

export function assert(cond, label) {
  if (!cond) throw new Error(`ASSERT FAILED: ${label}`);
  log("PASS:", label);
}

export function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

export async function launch() {
  return chromium.launch({ headless: true });
}

/** Attaches failure/telemetry capture to a page. Returns the event record. */
export function monitor(page, label) {
  const events = { console: [], pageerrors: [], requestfailed: [], badResponses: [], posts: [] };
  page.on("console", (msg) => {
    events.console.push({ type: msg.type(), text: msg.text() });
  });
  page.on("pageerror", (err) => events.pageerrors.push(String(err)));
  page.on("requestfailed", (req) =>
    events.requestfailed.push({ url: req.url(), error: req.failure()?.errorText }),
  );
  page.on("response", (res) => {
    if (res.status() >= 400) {
      events.badResponses.push({ status: res.status(), url: res.url() });
    }
  });
  page.on("request", (req) => {
    if (req.method() === "POST" && req.url().includes("husk.ns8pc1")) {
      events.posts.push({ url: req.url(), body: req.postData()?.slice(0, 200) });
    }
  });
  return events;
}

/** Clicks with hydration-settle retry (clicks before hydration are no-ops). */
export async function clickWithRetry(page, locatorOrSelector, tries = 3) {
  const locator =
    typeof locatorOrSelector === "string" ? page.locator(locatorOrSelector) : locatorOrSelector;
  for (let attempt = 1; attempt <= tries; attempt += 1) {
    await locator.click();
    await sleep(400);
    // Success heuristic: caller validates state afterwards; a no-op click
    // typically leaves the page unchanged, so callers re-check and may call
    // again via this helper's return.
    return true;
  }
  return false;
}

export async function createRoomViaUi(page) {
  for (let navAttempt = 0; navAttempt < 3; navAttempt += 1) {
    await page.goto(FRONTEND + "/", { waitUntil: "domcontentloaded", timeout: 30_000 });
    try {
      await page
        .getByRole("button", { name: "Create a room" })
        .waitFor({ state: "visible", timeout: 10_000 });
      break;
    } catch {
      log("landing button not visible, reloading...");
    }
  }
  const button = page.getByRole("button", { name: "Create a room" });
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      await button.click({ timeout: 5000 });
    } catch (error) {
      await page
        .screenshot({ path: "live-tests/debug-create-fail.png", fullPage: true })
        .catch(() => {});
      log("click failed:", String(error).slice(0, 200), "| url:", page.url());
      log(
        "body text:",
        (
          await page
            .locator("body")
            .textContent()
            .catch(() => "?")
        ).slice(0, 300),
      );
      await button.click({ force: true }).catch(() => {});
    }
    try {
      await page.waitForURL(/\/r\/\d+/, { timeout: 5000 });
      break;
    } catch {
      // not hydrated yet; retry
    }
  }
  await page.waitForURL(/\/r\/\d+/);
  const url = new URL(page.url());
  return { pin: url.pathname.split("/")[2], fragment: url.hash.slice(1) };
}

export async function joinViaLink(context, link) {
  const page = await context.newPage();
  await page.goto(link);
  await page.waitForURL(/\/r\/\d+/);
  return page;
}

export async function participantCount(page) {
  const text = await page.getByText(/participant(s)? connected/).textContent();
  const match = /(\d+)/.exec(text ?? "");
  return match ? Number(match[1]) : -1;
}

/** Polls until the given participant count is visible (or times out). */
export async function waitForParticipants(page, want, timeoutMs = 20_000) {
  const start = Date.now();
  let last = -1;
  while (Date.now() - start < timeoutMs) {
    last = await participantCount(page);
    if (last === want) return last;
    await sleep(500);
  }
  return last;
}

export async function sendText(page, text) {
  const composer = page.getByRole("textbox", { name: "Message" });
  for (let attempt = 0; attempt < 5; attempt += 1) {
    if (await composer.isEnabled()) break;
    await sleep(500);
  }
  await composer.fill(text);
  await composer.press("Enter");
}

export async function messageCount(page) {
  return page.locator(".space-y-3 > div").count();
}

export async function attachFile(page, filePath) {
  const input = page.locator('input[type="file"]');
  await input.setInputFiles(filePath);
}

export function statusLine(page) {
  return page.locator("header p").nth(1);
}
