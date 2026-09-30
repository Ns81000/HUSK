/**
 * Phase 4 Gauntlet — the double-teardown proof against a REAL Chromium
 * AudioContext, with a real microphone device and the app's real CSP.
 *
 * Why this needs a browser: the whole defect is `AudioContext.close()` rejecting
 * on an already-closed context. The in-repo mock *asserts* that it rejects with
 * `InvalidStateError`, so the mock cannot falsify the claim — it can only
 * restate it. The plan's class 5 guard ("every close is rejection-handled")
 * is therefore unverified at the only level where it could fail, and the
 * in-process double-teardown test passes whether or not the `.catch` is there
 * (mutation-checked: deleting `void context?.close().catch(() => {})` leaves
 * every other test green, because a Node unhandled rejection is reported to the
 * process, not to the test).
 *
 * So: create a real 48 kHz AudioContext, tear it down twice through the real
 * `teardownAudio`, and watch the page for `unhandledrejection`. Two events must
 * be observed for this to be a real proof:
 *   1. the second `close()` really does reject, with `InvalidStateError`;
 *   2. nothing escapes as an unhandled rejection.
 * A page that never saw a rejection would pass (2) vacuously, so (1) is
 * asserted first and independently.
 */
import { chromium, expect, test, type Page } from "@playwright/test";

const APP_URL = "http://localhost:3000/";
const PROOF_URL = "http://localhost:3000/__sound-chat-teardown-proof";

/**
 * The proof page: a module script served from the real dev server, so it runs
 * the *product's* `audio-io.ts` under the app's real CSP — not a copy.
 */
const PROOF_HTML =
  '<!doctype html><html><head><meta charset="utf-8">' +
  "<title>Sound Chat teardown proof</title></head><body>" +
  '<script type="module" src="/src/lib/sound-chat/harness/teardown-proof.ts"></script>' +
  "</body></html>";

/** What the page reports back. Mirrors the module it loads. */
type ProofResult = {
  /** The rate the browser really gave us. */
  sampleRate: number;
  /** What the *second* `close()` rejected with, before teardownAudio saw it. */
  secondCloseOutcome: { rejected: boolean; name: string; message: string };
  /** Every `unhandledrejection` the page saw, in order. */
  unhandledRejections: { name: string; message: string }[];
  /** Every error the page saw, so a thrown guard cannot hide as a rejection. */
  pageErrors: string[];
  /** How many times the real `teardownAudio` was called. */
  teardownCalls: number;
  /** The context state after both teardowns. */
  stateAfter: string;
};

declare global {
  interface Window {
    __teardownProof?: () => Promise<ProofResult>;
  }
}

async function installProofRoute(page: Page, csp: string): Promise<void> {
  await page.route("**/__sound-chat-teardown-proof", (route) =>
    route.fulfill({
      status: 200,
      contentType: "text/html; charset=utf-8",
      headers: { "content-security-policy": csp },
      body: PROOF_HTML,
    }),
  );
}

test("a double teardown of a real AudioContext leaks no unhandled rejection", async () => {
  const appResponse = await fetch(APP_URL);
  const realCsp = appResponse.headers.get("content-security-policy") ?? "";
  expect(realCsp, "the app must serve a CSP").not.toBe("");
  expect(realCsp).toContain("'wasm-unsafe-eval'");

  const browser = await chromium.launch({
    channel: "chromium",
    args: [
      "--use-fake-device-for-media-stream",
      "--use-fake-ui-for-media-stream",
      "--autoplay-policy=no-user-gesture-required",
    ],
  });
  try {
    const page = await browser.newPage();
    // Browser-side errors, so a throw inside the audio module is caught even if
    // the page's own collector missed it.
    const consoleErrors: string[] = [];
    page.on("console", (message) => {
      if (message.type() === "error") consoleErrors.push(message.text());
    });
    const nodeErrors: string[] = [];
    page.on("pageerror", (error) => nodeErrors.push(`${error.name}: ${error.message}`));

    await installProofRoute(page, realCsp);
    await page.goto(PROOF_URL, { waitUntil: "load" });
    await page.waitForFunction(() => window.__teardownProof !== undefined);

    // SAFETY: `page.evaluate` JSON-serialises the page's return value, and the
    // page resolves it from the `ProofResult` type declared in
    // `teardown-proof.ts`; the shape is checked by the assertions below rather
    // than restated here.
    const result = (await page.evaluate(async () => {
      const run = window.__teardownProof;
      if (run === undefined) throw new Error("the proof module did not load");
      return run();
    })) as ProofResult;

    console.log(
      `[teardown-proof] sampleRate=${result.sampleRate} ` +
        `teardownCalls=${result.teardownCalls} ` +
        `secondClose=${result.secondCloseOutcome.rejected ? result.secondCloseOutcome.name : "resolved"} ` +
        `unhandledRejections=${result.unhandledRejections.length} ` +
        `pageErrors=${result.pageErrors.length}`,
    );

    // (1) The premise. If this fails, the browser does not behave as measured
    // and the whole proof is void, so it is asserted on its own.
    expect(
      result.secondCloseOutcome.rejected,
      "the measured Chromium behaviour: a second close() must reject",
    ).toBe(true);
    expect(result.secondCloseOutcome.name).toBe("InvalidStateError");

    // (2) The claim under test.
    expect(result.teardownCalls).toBe(2);
    expect(
      result.unhandledRejections,
      "an InvalidStateError escaped teardownAudio as an unhandled rejection",
    ).toEqual([]);
    expect(result.pageErrors, "the proof page threw").toEqual([]);
    expect(nodeErrors, "an uncaught error escaped into the page").toEqual([]);
    expect(consoleErrors, "the page logged an error").toEqual([]);
    expect(result.stateAfter).toBe("closed");
  } finally {
    await browser.close();
  }
});
