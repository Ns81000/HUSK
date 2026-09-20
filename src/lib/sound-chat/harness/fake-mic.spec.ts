/**
 * Phase 0 fake-microphone harness (master plan Section 7, steps 5-7).
 *
 * For every variant in the degradation matrix this spec:
 * 1. encodes the variant's payloads with the real Tx path (vendored codec, the
 *    locked two-instance configuration),
 * 2. writes the (possibly impaired) waveform to a 16-bit WAV,
 * 3. launches a full Chromium with `--use-file-for-fake-audio-capture`, so that
 *    file *is* the machine's microphone,
 * 4. loads the harness page from the Vite dev server under the app's real CSP,
 *    which runs the real `getUserMedia` -> `AudioContext` ->
 *    `ScriptProcessor(1024, 1, 1)` -> codec -> decode pipeline, and
 * 5. asserts the variant's contract: exact decode, graceful failure (no crash,
 *    no hang, no garbage), or guaranteed silence.
 *
 * Two more tests cover the pieces this cannot reach: the browser's own Tx path
 * (encode in the page, then feed that WAV back in through a second browser) and
 * the build-time chunk split of the vendored codec.
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { chromium, expect, test, type Browser, type Page } from "@playwright/test";
import { openSoundChatCodec, type SoundChatCodec } from "../spike/codec";
import { resample } from "../spike/degrade";
import { encodeWav16 } from "../spike/wav";
import { CHANNEL_MATRIX, type ChannelVariant } from "./matrix";
import { PRIMARY_PAYLOAD } from "./payloads";
import type { EncodedBlock, HarnessOptions, HarnessResult } from "./page";

const HARNESS_URL = "http://localhost:3000/__sound-chat-harness";
const APP_URL = "http://localhost:3000/";
const WAV_DIR = resolve(process.cwd(), "test-results/sound-chat-wavs");
const BUILD_DIR = resolve(process.cwd(), "test-results/sound-chat-harness");
const VITE_CONFIG = "src/lib/sound-chat/harness/vite.config.ts";

const HARNESS_HTML =
  '<!doctype html><html><head><meta charset="utf-8">' +
  "<title>Sound Chat Phase 0 harness</title></head><body>" +
  '<script type="module" src="/src/lib/sound-chat/harness/page.ts"></script></body></html>';

const WAV_FLAG = "--use-file-for-fake-audio-capture";

/** A `securitypolicyviolation` event, as the blocker test records it. */
type CspViolation = {
  directive: string;
  blocked: string;
  source: string;
  line: number;
  column: number;
};

declare global {
  interface Window {
    __soundChatViolations: CspViolation[];
  }
}

/**
 * The measured Phase 0 blocker (see `SOUND_CHAT_LOG.md`).
 *
 * The vendored artifact's embind glue ends `craftInvokerFunction` with
 * `return newFunc(Function, args1).apply(null, args2)`, and `newFunc` calls
 * `constructor.apply(obj, argumentList)` — i.e. the *global* `Function`
 * constructor compiles one invoker per registered binding at init. There is no
 * textual `new Function`/`eval(` in the file (which is why a grep-based review
 * missed it), so under HUSK's real CSP (`'wasm-unsafe-eval'`, deliberately not
 * `'unsafe-eval'`) the very first `encode`/`decode` throws
 * `EvalError: Evaluating a string as JavaScript violates ... script-src` and the
 * codec is unusable.
 *
 * Widening the app's CSP is a human decision (the plan's approved edit is the
 * single `'wasm-unsafe-eval'` token), so by default the browser matrix is
 * skipped with that message rather than silently relaxed. Running it for
 * measurement is opt-in:
 *
 *   $env:SOUND_CHAT_HARNESS_RELAXED_CSP = "1"
 *   pnpm exec playwright test --config src/lib/sound-chat/harness/playwright.config.ts
 *
 * In relaxed mode only the *served harness document's* CSP gains `'unsafe-eval'`
 * — `src/server.ts` is untouched — every matrix line is tagged with the mode,
 * and the always-on "real CSP blocks the codec" test below keeps asserting the
 * blocker itself.
 */
const RELAXED_CSP = process.env["SOUND_CHAT_HARNESS_RELAXED_CSP"] === "1";
const CSP_MODE = RELAXED_CSP ? "relaxed(+unsafe-eval,MEASUREMENT-ONLY)" : "real";
const BLOCKED_MESSAGE =
  "the vendored codec cannot load under HUSK's real CSP (embind compiles " +
  "invokers with the global Function constructor, which needs 'unsafe-eval'); " +
  "see SOUND_CHAT_LOG.md and run with SOUND_CHAT_HARNESS_RELAXED_CSP=1 to " +
  "measure the audio pipeline anyway";

/** The CSP the harness document is served with. Only ever relaxed opt-in. */
function harnessCsp(): string {
  if (!RELAXED_CSP) return realCsp;
  return realCsp.replace("script-src 'self'", "script-src 'self' 'unsafe-eval'");
}

function variantById(id: string): ChannelVariant {
  const found = CHANNEL_MATRIX.find((variant) => variant.id === id);
  if (found === undefined) throw new Error(`unknown channel variant: ${id}`);
  return found;
}

function assetFile(dir: string, prefix: string): string {
  const file = readdirSync(dir).find((candidate) => candidate.startsWith(prefix));
  if (file === undefined) throw new Error(`no ${prefix} chunk in ${dir}`);
  return file;
}

let encoder: SoundChatCodec;
let sharedBrowser: Browser;
let realCsp: string;

test.beforeAll(async () => {
  mkdirSync(WAV_DIR, { recursive: true });
  encoder = await openSoundChatCodec();
  const response = await fetch(APP_URL);
  realCsp = response.headers.get("content-security-policy") ?? "";
  expect(realCsp, "the app must serve a CSP").not.toBe("");
  expect(realCsp).toContain("'wasm-unsafe-eval'");
  expect(realCsp).not.toContain("'unsafe-eval'");
  console.log(
    `[harness] csp-mode=${CSP_MODE} server-csp-has-unsafe-eval=${realCsp.includes("'unsafe-eval'")}`,
  );
});

test.afterAll(async () => {
  await sharedBrowser?.close();
  encoder?.close();
});

/**
 * Serves the harness document under the app's real CSP. The page must be
 * fetched from the real dev server (so relative module specifiers and the app's
 * transform pipeline work); only the document itself is fulfilled here.
 */
async function installHarnessRoute(page: Page): Promise<void> {
  await page.route("**/__sound-chat-harness", (route) =>
    route.fulfill({
      status: 200,
      contentType: "text/html; charset=utf-8",
      headers: { "content-security-policy": harnessCsp() },
      body: HARNESS_HTML,
    }),
  );
}

/** Opens the harness page under the app's real CSP. */
async function openHarnessPage(): Promise<Page> {
  const page = await sharedBrowser.newPage();
  await installHarnessRoute(page);
  await page.goto(HARNESS_URL, { waitUntil: "load" });
  return page;
}

/** Runs the capture pipeline in the page and returns what it decoded. */
async function captureWithBrowser(
  wavPath: string,
  options: HarnessOptions,
): Promise<HarnessResult> {
  const instance = await chromium.launch({
    channel: "chromium",
    args: [
      "--use-fake-device-for-media-stream",
      "--use-fake-ui-for-media-stream",
      "--autoplay-policy=no-user-gesture-required",
      `${WAV_FLAG}=${wavPath}%noloop`,
    ],
  });
  const page = await instance.newPage();
  const consoleErrors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  page.on("pageerror", (error) => consoleErrors.push(`pageerror: ${error.message}`));
  try {
    await installHarnessRoute(page);
    await page.goto(HARNESS_URL, { waitUntil: "load" });
    const entry = await resolveHarnessEntry(page);
    await entry.prepare(options);
    const result = await entry.run();
    return result;
  } finally {
    if (consoleErrors.length > 0) {
      console.log(`[console] ${JSON.stringify(consoleErrors)}`);
    }
    await page.close();
    await instance.close();
  }
}

/**
 * `page.evaluate` cannot serialise the typed helpers directly, so the entry is
 * resolved through the declared global and wrapped for the Node side.
 */
async function resolveHarnessEntry(page: Page) {
  return {
    prepare: async (options: HarnessOptions) => {
      await page.evaluate((value) => window.__soundChatHarness.prepare(value), options);
    },
    encode: async (hex: string): Promise<EncodedBlock> =>
      page.evaluate((value) => window.__soundChatHarness.encode(value), hex),
    run: async (): Promise<HarnessResult> => page.evaluate(() => window.__soundChatHarness.run()),
  };
}

function harnessOptions(variant: ChannelVariant): HarnessOptions {
  return {
    deviceRate: variant.deviceRate,
    profile: variant.profile,
    captureMs: variant.captureMs,
    selfTransmit: variant.selfTransmit,
    settleAfterDecodeMs: variant.settleAfterDecodeMs,
  };
}

/** A variant's impaired waveform, written out for the fake microphone. */
type VariantWav = { wavPath: string; sampleCount: number };

/** Encodes the variant's payloads with the real Tx path and writes the WAV. */
function writeVariantWav(variant: ChannelVariant): VariantWav {
  const built = variant.build((payload) => encoder.encode(payload.bytes));
  const samples = variant.wavRate === 48000 ? built : resample(built, 48000, variant.wavRate);
  const wavPath = resolve(WAV_DIR, `${variant.id}.wav`);
  writeFileSync(wavPath, encodeWav16({ sampleRate: variant.wavRate, samples }));
  return { wavPath, sampleCount: samples.length };
}

type MatrixObservation = {
  verdict: "pass" | "fail";
  decodes: number;
  unique: number;
  firstMs: number | null;
  chunks: number;
  skipped: number;
  contextRate: number;
  trackRate: number;
  elapsedMs: number;
};

/** Asserts the variant's contract and returns a one-line summary for the log. */
function assertVariantContract(variant: ChannelVariant, result: HarnessResult): MatrixObservation {
  const allowed = new Set(variant.allowed.map((payload) => payload.hex));
  const decodes = result.ok ? result.decodes : [];
  const unique = new Set(decodes.map((decode) => decode.hex));
  const garbage = [...unique].filter((hex) => !allowed.has(hex));
  const observation: MatrixObservation = {
    verdict: "fail",
    decodes: decodes.length,
    unique: unique.size,
    firstMs: decodes[0]?.atMs ?? null,
    chunks: result.ok ? result.chunks : 0,
    skipped: result.ok ? result.skipped : 0,
    contextRate: result.ok ? result.contextSampleRate : 0,
    trackRate: result.ok ? result.trackSampleRate : 0,
    elapsedMs: result.ok ? result.elapsedMs : 0,
  };

  // Invariant for every variant, including the destructive ones: the pipeline
  // must complete, the codec must stay alive, and nothing may decode that is
  // not a byte-exact, known payload.
  expect(result.ok, `${variant.id}: the pipeline threw (${result.ok ? "" : result.error})`).toBe(
    true,
  );
  if (!result.ok) return observation;

  expect(result.chunks, `${variant.id}: no capture chunks arrived`).toBeGreaterThan(0);
  expect(result.codecState, `${variant.id}: the codec died`).toBe("ready");
  expect(
    garbage,
    `${variant.id}: decoded content that is not a known payload: ${garbage.join(",")}`,
  ).toEqual([]);
  for (const decode of decodes) {
    expect(decode.hex.length, `${variant.id}: decode was not one 64-byte block`).toBe(128);
  }

  const decodedHexes = [...unique];
  if (variant.expectation === "decode") {
    for (const payload of variant.expected) {
      expect(decodedHexes, `${variant.id}: ${payload.id} must decode`).toContain(payload.hex);
    }
  }
  if (variant.expectation === "silence") {
    expect(decodedHexes, `${variant.id}: nothing may decode`).toEqual([]);
  }
  observation.verdict = "pass";
  return observation;
}

test.describe("Phase 0 fake-microphone degradation matrix", () => {
  for (const variant of CHANNEL_MATRIX) {
    test(`${variant.id} — ${variant.label}`, async () => {
      test.skip(!RELAXED_CSP, BLOCKED_MESSAGE);
      const { wavPath, sampleCount } = writeVariantWav(variant);
      const result = await captureWithBrowser(wavPath, harnessOptions(variant));
      const observation = assertVariantContract(variant, result);
      console.log(
        `[matrix] ${variant.id} ${observation.verdict} csp=${CSP_MODE} decodes=${observation.decodes} ` +
          `unique=${observation.unique} firstMs=${observation.firstMs} chunks=${observation.chunks} ` +
          `skipped=${observation.skipped} ctx=${observation.contextRate} track=${observation.trackRate} ` +
          `wav=${sampleCount} elapsed=${observation.elapsedMs}ms`,
      );
    });
  }
});

/**
 * The always-on record of the blocker, independent of the measurement switch:
 * under the app's real CSP the codec cannot even be instantiated, and adding
 * exactly `'unsafe-eval'` (nothing else) is enough to make the same page work.
 * This is the test a future session should delete *only* once the CSP question
 * has been decided and the codec loads for real.
 */
test.describe("codec loading vs HUSK's CSP", () => {
  test("needs 'unsafe-eval': embind compiles invokers with the global Function constructor", async () => {
    const instance = await chromium.launch({ channel: "chromium" });
    try {
      const probe = async (csp: string) => {
        const page = await instance.newPage();
        await page.addInitScript(() => {
          window.__soundChatViolations = [];
          document.addEventListener("securitypolicyviolation", (event) => {
            window.__soundChatViolations.push({
              directive: event.violatedDirective,
              blocked: event.blockedURI,
              source: event.sourceFile,
              line: event.lineNumber,
              column: event.columnNumber,
            });
          });
        });
        await page.route("**/__sound-chat-harness", (route) =>
          route.fulfill({
            status: 200,
            contentType: "text/html; charset=utf-8",
            headers: { "content-security-policy": csp },
            body: HARNESS_HTML,
          }),
        );
        await page.goto(HARNESS_URL, { waitUntil: "load" });
        let encoded: number | null = null;
        let error = "";
        try {
          const block = await page.evaluate(
            (hex) => window.__soundChatHarness.encode(hex),
            PRIMARY_PAYLOAD.hex,
          );
          encoded = block.sampleCount;
        } catch (thrown) {
          error = String(thrown).split("\n")[0] ?? "";
        }
        const violations = await page.evaluate(() => window.__soundChatViolations);
        await page.close();
        return { encoded, error, violations };
      };

      const real = await probe(realCsp);
      expect(real.encoded, "the real CSP must block the codec today").toBeNull();
      expect(real.error).toContain("EvalError");
      expect(real.violations.map((entry) => entry.blocked)).toEqual(["eval"]);
      console.log(
        `[csp-blocker] real-csp blocked=${JSON.stringify(real.violations)} error="${real.error.slice(0, 90)}"`,
      );

      const relaxed = await probe(
        harnessCsp().replace("script-src 'self'", "script-src 'self' 'unsafe-eval'"),
      );
      expect(relaxed.violations).toEqual([]);
      expect(relaxed.encoded, "'unsafe-eval' alone must be sufficient").toBe(90 * 1024);
      console.log(
        `[csp-blocker] with-unsafe-eval samples=${relaxed.encoded} violations=${relaxed.violations.length}`,
      );
    } finally {
      await instance.close();
    }
  });
});

/**
 * The Tx path as the browser itself will run it: encode inside the page (under
 * the real CSP, in the real wasm), hand the samples back, write them to a WAV,
 * then feed that WAV to a second Chromium as the fake microphone.
 */
test.describe("browser Tx path", () => {
  test("encodes in the page and decodes that same audio back through the fake mic", async () => {
    test.skip(!RELAXED_CSP, BLOCKED_MESSAGE);
    sharedBrowser = await chromium.launch({ channel: "chromium" });
    const page = await openHarnessPage();
    const entry = await resolveHarnessEntry(page);
    const encoded: EncodedBlock = await entry.encode(PRIMARY_PAYLOAD.hex);
    const bytes = Uint8Array.from(Buffer.from(encoded.base64, "base64"));
    const samples = new Float32Array(bytes.buffer);
    expect(samples.length).toBe(90 * 1024);
    const wavPath = resolve(WAV_DIR, "browser-encoded-primary.wav");
    writeFileSync(wavPath, encodeWav16({ sampleRate: 48000, samples }));
    await page.close();
    await sharedBrowser.close();

    const result = await captureWithBrowser(wavPath, harnessOptions(variantById("clean")));
    const clean = variantById("clean");
    const observation = assertVariantContract(clean, result);
    console.log(
      `[browser-tx] ${observation.verdict} unique=${observation.unique} firstMs=${observation.firstMs}`,
    );
  });
});

/** Master plan Section 7 step 8, before any UI consumes the codec. */
test.describe("build output", () => {
  test("emits the vendored codec as its own lazy chunk", () => {
    execFileSync("pnpm", ["exec", "vite", "build", "--config", VITE_CONFIG], {
      cwd: process.cwd(),
      stdio: "inherit",
      shell: true,
    });
    const assets = resolve(BUILD_DIR, "assets");
    const codecChunk = assetFile(assets, "ggwave-");
    const entryChunk = assetFile(assets, "index-");

    const codecSource = readFileSync(resolve(assets, codecChunk), "utf8");
    const entrySource = readFileSync(resolve(assets, entryChunk), "utf8");
    // The vendored artifact is 148131 bytes; the codec chunk must carry it.
    expect(codecSource.length).toBeGreaterThan(100_000);
    // ...and the main chunk must not: the codec is reached only by dynamic import.
    expect(entrySource.length).toBeLessThan(30_000);
    expect(entrySource).toContain("ggwave-");

    const html = readFileSync(resolve(BUILD_DIR, "index.html"), "utf8");
    expect(html).toContain("assets/index-");
    expect(html).not.toContain("ggwave-");
  });
});
