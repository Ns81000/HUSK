/**
 * Phase 4 — the positive counterpart to the "the harness does not run the
 * product's capture path" pin.
 *
 * `deep-verify-harness-constants.test.ts` (F11) and `deep-harness-matrix.test.ts`
 * both assert that `harness/page.ts` drives `spike/audio-io`'s `attachCapture`
 * and never `startListening`. Both still hold and are still true *of that file*:
 * `page.ts` exists to measure device rates and mic chains with a
 * non-48000 Hz context, which the product's own `createAudioContext` refuses to
 * build, so it cannot be made to use the product's pipeline.
 *
 * But a pin that says "the product's path is never run in a browser" is only
 * true while nothing else runs it. Phase 4 added `harness/product-page.ts`,
 * which imports `startListening` and `transmitAndPause` from `../audio-io` and
 * nothing else, and `harness/gauntlet-product-capture.spec.ts`, which drives it
 * through the same full Chromium with the same fake-microphone device. This file
 * pins THAT, so the coverage cannot be removed silently: if the product page
 * ever stops importing the product's functions, or the spec stops driving it,
 * these fail.
 *
 * What is deliberately not pinned here: that the room fixture is right. The
 * speaker-to-microphone leg is a fixture by construction, and the spec asserts
 * its sample count against what the product played rather than trusting it.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { RX_PAUSE_TAIL_SECONDS } from "../audio-io";
import { CODEC_SAMPLES_PER_FRAME } from "../codec";
import { BLOCK_DURATION_SECONDS, TRANSMIT_LEAD_SECONDS } from "../session";
import { CAPTURE_FRAME_SAMPLES } from "./audio-io";

const PRODUCT_PAGE = fileURLToPath(new URL("../harness/product-page.ts", import.meta.url));
const PRODUCT_SPEC = fileURLToPath(
  new URL("../harness/gauntlet-product-capture.spec.ts", import.meta.url),
);
const SPIKE_AUDIO_IO = fileURLToPath(new URL("./audio-io.ts", import.meta.url));

/** The page with its own doc comments stripped, so prose cannot satisfy a check. */
function code(of: string): string {
  return of.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
}

const page = readFileSync(PRODUCT_PAGE, "utf8");
const pageCode = code(page);
const spec = readFileSync(PRODUCT_SPEC, "utf8");
const spikeAudioIo = readFileSync(SPIKE_AUDIO_IO, "utf8");

describe("the product's capture path is on a browser harness path", () => {
  it("imports startListening and transmitAndPause from the product module itself", () => {
    // The whole value of the page: these are the *product's* functions, not the
    // spike's re-implementation. A relative `../audio-io` specifier is what makes
    // that checkable at all.
    expect(page).toContain('from "../audio-io"');
    expect(page).toContain("startListening");
    expect(page).toContain("transmitAndPause");
    // ...and it is the product's own codec, not a spike re-export, so nothing
    // on this page can drift from what the app runs.
    expect(page).toContain('from "../codec"');
    expect(pageCode).not.toContain('from "../spike/');
    expect(pageCode).not.toContain("attachCapture");
  });

  it("does not build a capture pipeline of its own", () => {
    // The failure mode this file exists to prevent: someone "simplifying" the
    // product page by wiring it to the spike's capture, or by inlining a
    // ScriptProcessor, which would make every measurement in the spec evidence
    // about code the product does not run. Checked against the page with its
    // comments stripped, so a doc comment *describing* the spike's function
    // cannot satisfy the check.
    expect(pageCode).not.toContain("createScriptProcessor");
    expect(pageCode).not.toContain("onaudioprocess");
    expect(pageCode).not.toContain("getChannelData");
    // The two pipelines really are separate implementations, so "it does not
    // call `attachCapture`" is a fact about the code, not a naming trick.
    expect(spikeAudioIo).toContain("export function attachCapture");
    expect(CAPTURE_FRAME_SAMPLES).toBe(CODEC_SAMPLES_PER_FRAME);
  });

  it("uses the product's own context and microphone entry points", () => {
    // `createAudioContext` is what enforces the 48000 Hz gate, and
    // `requestMicrophoneAccess` is what returns the locked clean constraints and
    // a discriminated refusal rather than a thrown error.
    expect(page).toContain("createAudioContext");
    expect(page).toContain("requestMicrophoneAccess");
    expect(page).toContain("teardownAudio");
    // The rate gate is a real product behaviour the page must not bypass: a page
    // that built its own `new AudioContext` could run at 44100 Hz and would then
    // measure a pipeline the product refuses to start.
    expect(pageCode).not.toContain("new AudioContext");
  });

  it("rehearses the session's own transmit arithmetic rather than inventing one", () => {
    // Two constants the page could have copied: the scheduling lead and the
    // block length. It derives the block length from the codec's own output, and
    // it must not add `RX_PAUSE_TAIL_SECONDS` anywhere — `ListenHandle.pause`
    // adds it, and a second addition is the exact Phase 2V regression.
    expect(page).toContain(`const TRANSMIT_LEAD_SECONDS = ${TRANSMIT_LEAD_SECONDS};`);
    expect(pageCode).toContain("payloads.length * blockSeconds");
    expect(pageCode).not.toContain("RX_PAUSE_TAIL_SECONDS");
    // ...and it never passes a per-block hold to the later blocks, which is the
    // other half of the regression: only the first block carries the window.
    expect(pageCode).toMatch(
      /index === 0[\s\S]{0,80}payloads\.length \* blockSeconds[\s\S]{0,40}: 0/,
    );
  });

  it("is driven by a spec that asserts, not just logs", () => {
    expect(spec).toContain("--use-file-for-fake-audio-capture");
    expect(spec).toContain("--use-fake-device-for-media-stream");
    expect(spec).toContain('channel: "chromium"');
    // The real CSP, so the codec runs under the app's actual policy.
    expect(spec).toContain("content-security-policy");
    // Console errors are asserted (P2V finding 17): a `graceful` outcome is
    // satisfied by decoding nothing, so an uncaught exception in the audio
    // callback would otherwise pass unnoticed. The assertion, not just the
    // collection — and `.toEqual([])`, not merely the collection.
    const flattened = spec.replace(/\s+/g, " ");
    const at = flattened.indexOf("expect(consoleErrors,");
    expect(at, "the product spec must assert on the console errors it collects").toBeGreaterThan(
      -1,
    );
    expect(flattened.slice(at, at + 120)).toContain(".toEqual([])");
  });

  it("covers both halves of the error split, the pause arithmetic, and the pause", () => {
    // The three things the residual said were unexercised, named so removing
    // one of these tests is a visible, deliberate act.
    for (const claim of [
      'fault: "consumer"',
      'fault: "codec"',
      'selfTransmit: "pause"',
      'selfTransmit: "leave-open"',
      "blocks: 2",
    ]) {
      expect(spec, `the product spec no longer covers ${claim}`).toContain(claim);
    }
    // The pause tolerance has to be far narrower than the tail it must exclude,
    // or the arithmetic assertion would pass even if the tail were counted
    // twice. This is the machine-check of that claim.
    expect(RX_PAUSE_TAIL_SECONDS).toBe(0.5);
    expect(page).toContain("const WARMUP_MS = 2600;");
    // ...and the spec's tolerance is read from the spec, so shrinking one
    // without the other cannot quietly weaken the check.
    expect(spec).toContain("const PAUSE_TOLERANCE_SECONDS = 0.25;");
    // The two-block window is two blocks plus one tail, which is the number the
    // spec computes from the product's own constant.
    expect(BLOCK_DURATION_SECONDS).toBe(1.92);
  });
});
