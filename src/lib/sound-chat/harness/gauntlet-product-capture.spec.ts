/**
 * Phase 4 — the product's own capture and send path, in a real Chromium.
 *
 * `harness/fake-mic.spec.ts` drives `spike/audio-io`'s `attachCapture`, a second
 * implementation of the ScriptProcessor pipeline. Everything it measured about
 * the channel was therefore measured about a *copy* of the code, and three
 * things the product actually depends on were never executed in a browser at
 * all:
 *
 *   1. `startListening`'s error split — a codec call that throws ends the feed
 *      and reports `onModuleError`, while a throwing `onDecoded` keeps the feed
 *      running and reports `onDecodedError`. One bad consumer must never present
 *      as a dead codec.
 *   2. `transmitAndPause`'s pause arithmetic, including the two-block message
 *      where the first block carries the window for both. Phase 2V found a
 *      double-counted tail here that shut the sender's own feed half a second
 *      too long and ate the first half second of the peer's acknowledgement,
 *      breaking every single-block message.
 *   3. self-reception: whether a closed Rx feed really stops the sender's
 *      microphone from decoding the block the sender is playing.
 *
 * This spec drives `harness/product-page.ts`, which imports `startListening` and
 * `transmitAndPause` from `../audio-io` and nothing else, in the same full
 * Chromium with the same `--use-file-for-fake-audio-capture` device.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { chromium, expect, test, type Page } from "@playwright/test";
import { openSoundChatCodec, type SoundChatCodec } from "../spike/codec";
import { RX_PAUSE_TAIL_SECONDS } from "../audio-io";
import { BLOCK_DURATION_MS, BLOCK_DURATION_SECONDS } from "../session";
import { encodeWav16 } from "../spike/wav";
import { findVariant, type ChannelVariant } from "./matrix";
import type { ProductObservation, ProductRequest } from "./product-page";

const PRODUCT_URL = "http://localhost:3000/__sound-chat-product-harness";
const WAV_DIR = resolve(process.cwd(), "test-results/sound-chat-wavs");

const PRODUCT_HTML =
  '<!doctype html><html><head><meta charset="utf-8">' +
  "<title>Sound Chat product capture harness</title></head><body>" +
  '<script type="module" src="/src/lib/sound-chat/harness/product-page.ts"></script></body></html>';

const WAV_FLAG = "--use-file-for-fake-audio-capture";

/** 1024 samples at 48000 Hz: how often the audio callback runs. */
const CHUNK_MS = (1024 / 48_000) * 1000;

/**
 * One block, as the *product* measures it. Derived from `session.ts` rather than
 * written out, so a change to the block length cannot leave this spec asserting
 * an arithmetic the product no longer performs.
 */
const BLOCK_SECONDS = BLOCK_DURATION_SECONDS;

/**
 * The pause probe samples at 16 ms, so the measured window carries up to one
 * interval of jitter at each edge. The band below is generous against that and
 * still far narrower than the 500 ms it has to exclude to rule out a
 * double-counted tail.
 */
const PAUSE_TOLERANCE_SECONDS = 0.25;

let encoder: SoundChatCodec;
let realCsp = "";

test.beforeAll(async () => {
  mkdirSync(WAV_DIR, { recursive: true });
  encoder = await openSoundChatCodec();
  const response = await fetch("http://localhost:3000/");
  realCsp = response.headers.get("content-security-policy") ?? "";
  expect(realCsp, "the app must serve a CSP").not.toBe("");
});

test.afterAll(() => {
  encoder?.close();
});

/**
 * A matrix variant's waveform as the fake microphone's file. Built from the
 * matrix's own `build` so the WAV a case hears and the variant named in the log
 * can never be two different things.
 */
function wavFor(variant: ChannelVariant): string {
  const samples = variant.build((payload) => encoder.encode(payload.bytes));
  const wavPath = resolve(WAV_DIR, `product-${variant.id}.wav`);
  writeFileSync(wavPath, encodeWav16({ sampleRate: variant.wavRate, samples }));
  return wavPath;
}

async function installProductRoute(page: Page): Promise<void> {
  await page.route("**/__sound-chat-product-harness", (route) =>
    route.fulfill({
      status: 200,
      contentType: "text/html; charset=utf-8",
      headers: { "content-security-policy": realCsp },
      body: PRODUCT_HTML,
    }),
  );
}

/** Runs the product's capture and send path in Chromium and reports what it saw. */
async function runProductCase(
  wavPath: string,
  request: ProductRequest,
): Promise<ProductObservation> {
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
    await installProductRoute(page);
    await page.goto(PRODUCT_URL, { waitUntil: "load" });
    const observation = await page.evaluate(
      (value) => window.__soundChatProductHarness.run(value),
      request,
    );
    // Asserted, not just logged: the audio callback runs on a thread where an
    // uncaught exception tears the whole feed down, and every expectation below
    // is satisfied by "nothing decoded" (P2V finding 17).
    expect(consoleErrors, `the product page logged errors`).toEqual([]);
    return observation;
  } finally {
    if (consoleErrors.length > 0) console.log(`[product-console] ${JSON.stringify(consoleErrors)}`);
    await page.close();
    await instance.close();
  }
}

/** Every case shares these: the pipeline built, the codec alive, nothing garbled. */
function expectHealthyPipeline(observation: ProductObservation, label: string): void {
  expect(observation.ok, `${label}: ${observation.error}`).toBe(true);
  expect(observation.contextSampleRate, `${label}: the product demands 48000 Hz`).toBe(48_000);
  expect(observation.chunks, `${label}: no capture chunks arrived`).toBeGreaterThan(0);
  expect(observation.codecState, `${label}: the codec died`).toBe("ready");
  expect(observation.moduleErrors, `${label}: a module error was reported`).toEqual([]);
  expect(observation.consumerErrors, `${label}: a consumer error was reported`).toEqual([]);
}

test.describe("the product's own capture path in a real browser", () => {
  test("startListening decodes the fake microphone, at the locked 48000 Hz", async () => {
    const observation = await runProductCase(wavFor(findVariant("clean")), {
      captureMs: 5000,
      settleAfterDecodeMs: 700,
      blocks: 0,
      selfTransmit: "none",
      fault: "none",
    });
    expectHealthyPipeline(observation, "capture");
    const unique = [...new Set(observation.decodes.map((decode) => decode.hex))];
    expect(unique, "the product's own Rx path must decode the block").toHaveLength(1);
    expect(unique[0]).toBe(findVariant("clean").expected[0]?.hex);
    // Nothing was closed and nothing was dropped: this arm is a control.
    expect(observation.skippedWhilePaused).toBe(0);
    expect(observation.pausedWindowSeconds).toBe(-1);
    expect(observation.chunksFedToCodec).toBe(observation.chunks);
    console.log(
      `[product] capture chunks=${observation.chunks} decodes=${observation.decodes.length} ` +
        `firstMs=${observation.decodes[0]?.atMs ?? "none"} track=${observation.trackLabel} ` +
        `trackRate=${observation.trackSampleRate} elapsed=${observation.elapsedMs}ms`,
    );
  });

  test("an unclosed Rx feed decodes our own transmission", async () => {
    // The hazard, through the product. The room holds no other sound, so the
    // only thing that can decode is the block this page is playing.
    const observation = await runProductCase(wavFor(findVariant("quiet-5s-only")), {
      captureMs: 6500,
      settleAfterDecodeMs: 900,
      blocks: 1,
      selfTransmit: "leave-open",
      fault: "none",
    });
    expectHealthyPipeline(observation, "self-transmit-hazard");
    const unique = [...new Set(observation.decodes.map((decode) => decode.hex))];
    expect(unique, "the hazard must be real through the product's own feed").toHaveLength(1);
    expect(unique[0]).toBe(findVariant("clean").expected[0]?.hex);
    // The control arm never closed the feed: the two arms differ only in the
    // `pauseSeconds` argument, so this is the honest baseline for test three.
    expect(observation.pausedWindowSeconds, "the control arm must not pause at all").toBe(-1);
    expect(observation.skippedWhilePaused, "the control arm drops nothing").toBe(0);
    console.log(
      `[product] self-transmit-hazard decodes=${observation.decodes.length} ` +
        `firstMs=${observation.decodes[0]?.atMs ?? "none"} ` +
        `pausedWindow=${observation.pausedWindowSeconds}s ` +
        `transmittedMs=${observation.transmittedMs.join("+")}`,
    );
  });

  test("transmitAndPause closes the feed and nothing of our own block is decoded", async () => {
    const observation = await runProductCase(wavFor(findVariant("quiet-5s-only")), {
      captureMs: 6500,
      settleAfterDecodeMs: 0,
      blocks: 1,
      selfTransmit: "pause",
      fault: "none",
    });
    expectHealthyPipeline(observation, "self-transmit-paused");
    expect(
      observation.decodes.map((decode) => decode.hex),
      "the product's own transmission must not be decoded by the product",
    ).toEqual([]);

    // The arithmetic, measured on the AudioContext clock: one block of audio
    // plus the tail, once. A second tail would show up as 2.92 s.
    const expected = BLOCK_SECONDS + RX_PAUSE_TAIL_SECONDS;
    expect(
      Math.abs(observation.pausedWindowSeconds - expected),
      `one block must pause for ${expected}s, measured ${observation.pausedWindowSeconds}s`,
    ).toBeLessThan(PAUSE_TOLERANCE_SECONDS);
    // And the behaviour, not just the number: every chunk of the transmit
    // window was skipped, and the feed kept delivering while it skipped.
    const windowChunks = (BLOCK_SECONDS * 1000) / CHUNK_MS;
    expect(observation.skippedWhilePaused).toBeGreaterThanOrEqual(windowChunks);
    expect(observation.chunks, "a closed feed must skip chunks, not be torn down").toBeGreaterThan(
      observation.skippedWhilePaused,
    );
    // The feed resumed: chunks kept arriving after the window closed, and the
    // ones after it reached the codec again.
    expect(observation.chunksFedToCodec).toBeGreaterThan(observation.chunksBeforeSend);
    console.log(
      `[product] self-transmit-paused decodes=${observation.decodes.length} ` +
        `pausedWindow=${observation.pausedWindowSeconds}s expected=${expected}s ` +
        `skipped=${observation.skippedWhilePaused} chunks=${observation.chunks} ` +
        `transmittedMs=${observation.transmittedMs.join("+")} ` +
        `roomSamples=${observation.roomSampleCounts.join("+")}`,
    );
  });

  test("a two-block message is covered whole, and the tail is counted once", async () => {
    const observation = await runProductCase(wavFor(findVariant("quiet-5s-only")), {
      captureMs: 9000,
      settleAfterDecodeMs: 0,
      blocks: 2,
      selfTransmit: "pause",
      fault: "none",
    });
    expectHealthyPipeline(observation, "two-block");
    expect(observation.transmittedMs, "two blocks of equal length").toEqual([
      BLOCK_DURATION_MS,
      BLOCK_DURATION_MS,
    ]);
    expect(observation.decodes, "the sender must decode neither of its own blocks").toEqual([]);

    // The Phase 2V regression, in the shape it actually broke: the first block
    // carries the window for both, so the closed window is two blocks plus the
    // tail — not two blocks plus two tails, and not one block plus a tail.
    const expected = 2 * BLOCK_SECONDS + RX_PAUSE_TAIL_SECONDS;
    expect(
      Math.abs(observation.pausedWindowSeconds - expected),
      `two blocks must pause for ${expected}s, measured ${observation.pausedWindowSeconds}s`,
    ).toBeLessThan(PAUSE_TOLERANCE_SECONDS);
    // The second block must be *inside* the closed window. 180 chunks is the
    // whole window; if the pause were re-armed per block the second block's own
    // audio would reach the codec and be decoded.
    const windowChunks = (2 * BLOCK_SECONDS * 1000) / CHUNK_MS;
    expect(observation.skippedWhilePaused).toBeGreaterThanOrEqual(windowChunks);
    expect(observation.chunks).toBeGreaterThan(observation.skippedWhilePaused);
    // The room fixture played exactly what the product played.
    expect(observation.roomSampleCounts).toEqual([90 * 1024, 90 * 1024]);
    console.log(
      `[product] two-block decodes=${observation.decodes.length} ` +
        `pausedWindow=${observation.pausedWindowSeconds}s expected=${expected}s ` +
        `skipped=${observation.skippedWhilePaused} (window=${Math.floor(windowChunks)}) ` +
        `chunks=${observation.chunks} transmittedMs=${observation.transmittedMs.join("+")}`,
    );
  });
});

test.describe("the product's error split, in a real browser", () => {
  test("a throwing consumer is reported on its own channel and the feed keeps running", async () => {
    const observation = await runProductCase(wavFor(findVariant("clean")), {
      captureMs: 6000,
      settleAfterDecodeMs: 0,
      blocks: 0,
      selfTransmit: "none",
      fault: "consumer",
    });
    expect(observation.ok, observation.error).toBe(true);
    expect(observation.contextSampleRate).toBe(48_000);
    expect(
      observation.consumerErrors.length,
      "the consumer error must be reported",
    ).toBeGreaterThan(0);
    expect(
      observation.consumerErrors[0],
      "and it must be the consumer's own error, verbatim",
    ).toContain("injected consumer failure");
    // The split: a consumer bug must never look like a dead codec.
    expect(observation.moduleErrors, "a consumer bug is not a module failure").toEqual([]);
    // The feed is the real proof. A 6 s window is ~281 callbacks; a feed that
    // stopped at the first decode (~1.9 s in) would report under 100.
    expect(
      observation.chunks,
      "the mic feed must keep running after the consumer throws",
    ).toBeGreaterThan(200);
    expect(observation.codecState, "the module is healthy throughout").toBe("ready");
    console.log(
      `[product] error-split consumer consumerErrors=${observation.consumerErrors.length} ` +
        `moduleErrors=${observation.moduleErrors.length} chunks=${observation.chunks} ` +
        `decodes=${observation.decodes.length}`,
    );
  });

  test("a throwing codec call ends the feed and is reported as a module failure", async () => {
    const observation = await runProductCase(wavFor(findVariant("clean")), {
      captureMs: 6000,
      settleAfterDecodeMs: 0,
      blocks: 0,
      selfTransmit: "none",
      fault: "codec",
    });
    expect(observation.ok, observation.error).toBe(true);
    expect(observation.moduleErrors.length, "the module failure must be reported").toBe(1);
    expect(observation.moduleErrors[0]).toContain("injected codec failure");
    expect(
      observation.consumerErrors,
      "a module failure is never reported as a consumer bug",
    ).toEqual([]);
    // The feed stops: chunks is incremented before the decode, so a torn feed
    // freezes within the first few callbacks instead of reaching ~281.
    expect(observation.chunks, "a failed codec call must end the Rx feed").toBeLessThan(10);
    expect(observation.decodes, "nothing may decode once the codec has failed").toEqual([]);
    console.log(
      `[product] error-split codec moduleErrors=${observation.moduleErrors.length} ` +
        `consumerErrors=${observation.consumerErrors.length} chunks=${observation.chunks} ` +
        `elapsed=${observation.elapsedMs}ms`,
    );
  });
});

test.describe("a room with nothing in it", () => {
  test("an input that carries no signal returns cleanly rather than hanging", async () => {
    const observation = await runProductCase(wavFor(findVariant("quiet-5s-only")), {
      captureMs: 5000,
      settleAfterDecodeMs: 0,
      blocks: 0,
      selfTransmit: "none",
      fault: "none",
    });
    expectHealthyPipeline(observation, "muted-input");
    expect(observation.decodes, "an input with no signal decodes nothing").toEqual([]);
    // The hang check, which is the point: the run returned on its own clock,
    // at about the window it was asked for, rather than blocking forever.
    expect(observation.elapsedMs).toBeGreaterThan(4_500);
    expect(observation.elapsedMs).toBeLessThan(9_000);
    expect(observation.chunks, "the feed is still running, which is not a hang").toBeGreaterThan(
      200,
    );
    expect(observation.paused).toBe(false);
    console.log(
      `[product] muted-input decodes=${observation.decodes.length} chunks=${observation.chunks} ` +
        `elapsed=${observation.elapsedMs}ms paused=${observation.paused} ` +
        `errorKind=${observation.errorKind}`,
    );
  });
});
