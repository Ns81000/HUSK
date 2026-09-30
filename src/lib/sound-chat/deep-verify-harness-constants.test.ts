/**
 * Phase 2V re-verification — the harness and the constants that must not drift
 * (F10, F11, F16, F17, F18).
 *
 * These are the findings whose "fix" is a value rather than a mechanism, which
 * is exactly why they need pinning: nothing fails at runtime if a matrix variant
 * quietly measures the wrong thing, if the spec stops asserting, or if a
 * constant is copied instead of derived. So each one is asserted here against
 * both the resolved value and the source line that produces it.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { CODEC_PAYLOAD_LENGTH, CODEC_SAMPLE_RATE, CODEC_SAMPLES_PER_FRAME } from "./codec";
import { REQUIRED_SAMPLE_RATE, RX_PAUSE_TAIL_SECONDS } from "./audio-io";
import { CAPTURE_FRAME_SAMPLES } from "./spike/audio-io";
import { CHANNEL_MATRIX, findVariant } from "./harness/matrix";
import { PRIMARY_PAYLOAD, wireBlock } from "./harness/payloads";
import { PAIR_BODY_BYTES } from "./protocol";

const PAGE = fileURLToPath(new URL("./harness/page.ts", import.meta.url));
const SPEC = fileURLToPath(new URL("./harness/fake-mic.spec.ts", import.meta.url));
const MATRIX = fileURLToPath(new URL("./harness/matrix.ts", import.meta.url));
const PAYLOADS = fileURLToPath(new URL("./harness/payloads.ts", import.meta.url));
const AUDIO_IO = fileURLToPath(new URL("./audio-io.ts", import.meta.url));
const SPIKE_AUDIO_IO = fileURLToPath(new URL("./spike/audio-io.ts", import.meta.url));

const page = readFileSync(PAGE, "utf8");
const spec = readFileSync(SPEC, "utf8");
const matrix = readFileSync(MATRIX, "utf8");
const payloads = readFileSync(PAYLOADS, "utf8");
const audioIo = readFileSync(AUDIO_IO, "utf8");
const spikeAudioIo = readFileSync(SPIKE_AUDIO_IO, "utf8");

describe("F10 — the browser-defaults matrix variant really asks for the defaults", () => {
  it("resolves to `browser-defaults` and keeps a self-consistent contract", () => {
    const variant = findVariant("profile-browser-defaults-noisy");
    expect(variant.profile, "the variant must ask for what it measures").toBe("browser-defaults");
    expect(variant.inProcess, "and it needs a capture device").toBe(false);
    expect(variant.label).toContain("default processing");
    expect(variant.note).toContain("Default processing");
    // The source really sets it, rather than relying on the default.
    const spec_block = matrix.slice(
      matrix.indexOf('id: "profile-browser-defaults-noisy"'),
      matrix.indexOf("const ROOM_VARIANTS"),
    );
    expect(spec_block).toContain('profile: "browser-defaults"');
    // And the sibling variant that always did.
    expect(findVariant("profile-browser-defaults").profile).toBe("browser-defaults");
  });

  it("has an expectation the harness can still falsify after the fix", () => {
    const variant = findVariant("profile-browser-defaults-noisy");
    // `graceful` is satisfied by decoding nothing, so the only thing that can
    // catch a wrong measurement is the "no garbage" half: anything decoded must
    // be a byte-exact payload this variant itself transmits.
    expect(variant.expectation).toBe("graceful");
    const sent = new Set(variant.payloads.map((payload) => payload.hex));
    for (const allowed of variant.allowed) {
      expect(sent, `${variant.id} allows a payload it never transmits`).toContain(allowed.hex);
    }
    expect(variant.expected.length).toBeGreaterThan(0);
    // The browser-defaults profile really is a *different* capture request from
    // the clean one, so the variant is not a duplicate measurement: the spike's
    // `constraintsFor` asks for the browser's own processing instead of the
    // feature's locked "clean" constraints.
    expect(spikeAudioIo).toContain('export type MicrophoneProfile = "clean" | "browser-defaults";');
    expect(spikeAudioIo).toContain('if (profile === "clean")');
    expect(spikeAudioIo).toContain(
      "{ echoCancellation: false, noiseSuppression: false, autoGainControl: false }",
    );
    expect(spikeAudioIo).toContain(
      "{ echoCancellation: true, noiseSuppression: true, autoGainControl: true }",
    );
    // ...and the page really passes the variant's own profile through.
    expect(page).toContain("requestMicrophone(options.profile)");
    expect(variant.payloads).toEqual([PRIMARY_PAYLOAD]);
  });
});

describe("F11 — the harness still does not run the product's capture path", () => {
  it("drives the spike's own implementation, and says so in the page", () => {
    // The accepted gap, unchanged and still honestly described: the page wires
    // `spike/audio-io`'s `attachCapture`, a second implementation of the same
    // ScriptProcessor pipeline. The product's `startListening` — with its own
    // pause arithmetic and its own consumer/module error split — is not on this
    // path.
    expect(page).toContain('from "../spike/audio-io"');
    expect(page).toContain("attachCapture");
    expect(page).not.toContain("startListening");
    expect(page).not.toContain("createScriptProcessor");
    // The one thing it does share with the product, and it is imported, not
    // copied (F18).
    expect(page).toContain('from "../audio-io"');
    expect(page).toContain("RX_PAUSE_TAIL_SECONDS");
    // And the spike's capture is genuinely a separate implementation, so the
    // claim is not a naming trick.
    expect(CAPTURE_FRAME_SAMPLES).toBe(CODEC_SAMPLES_PER_FRAME);
  });
});

describe("F16 — the spec asserts on the page's console errors", () => {
  it("fails the variant when the page logged anything", () => {
    expect(spec).toContain("consoleErrors");
    expect(spec).toContain("pageerror");
    // The assertion, not a log: a `graceful` variant is satisfied by "nothing
    // decoded", so an uncaught exception in the audio callback — which runs on
    // the audio thread, outside `runHarness`'s own try — used to pass unnoticed.
    const flattened = spec.replace(/\s+/g, " ");
    const at = flattened.indexOf("expect( consoleErrors,");
    expect(at, "the spec must assert on the collected console errors").toBeGreaterThan(-1);
    expect(flattened.slice(at, at + 200), "and the assertion must be toEqual([])").toContain(
      ".toEqual([])",
    );
    // It has to be inside the capture helper, i.e. for every matrix variant, and
    // before the browser is closed.
    const helperStart = spec.indexOf("async function captureWithBrowser");
    const helperEnd = spec.indexOf("/**\n * `page.evaluate` cannot serialise", helperStart);
    expect(helperStart).toBeGreaterThan(-1);
    expect(helperEnd).toBeGreaterThan(helperStart);
    expect(spec.slice(helperStart, helperEnd)).toContain("expect(");
    // The log survives as diagnostics for a failure, which is the honest reason
    // it is still there.
    expect(spec).toContain("[console]");
  });
});

describe("F17 — the harness payloads carry a real peer id", () => {
  it("uses 0 and 1, alternating, and nothing else", () => {
    // `FrameCodec.parse` refuses any other value as `bad-peer`, so a payload
    // with 0x0a/0x0b in it is a trap for anyone reusing these as protocol
    // fixtures.
    for (const [tag, expected] of [
      [0x1234, 0],
      [0x1235, 1],
      [0x0001, 1],
      [0x0002, 0],
      [0x0003, 1],
      [0x5678, 0],
    ] as [number, number][]) {
      const block = wireBlock(tag);
      expect(block[3], `wireBlock(${tag}).fromPeerId`).toBe(expected);
      expect([0, 1]).toContain(block[3]);
    }
    // The source really derives it from the tag rather than hard-coding it.
    expect(payloads).toContain("DISPLAYER_PEER_ID");
    expect(payloads).toContain("ENTERER_PEER_ID");
    expect(payloads).toContain("const DISPLAYER_PEER_ID = 0x0;");
    expect(payloads).toContain("const ENTERER_PEER_ID = 0x1;");
    // And the rest of the locked layout is still what it claims to be.
    const block = wireBlock(0x1234);
    expect(block).toHaveLength(CODEC_PAYLOAD_LENGTH);
    expect(block[0]).toBe(1);
    expect(block[4]).toBe(CODEC_PAYLOAD_LENGTH - 5 - 16);
    expect(PRIMARY_PAYLOAD.hex).toHaveLength(128);
  });
});

describe("F18 — the shared constants are derived, not copied", () => {
  it("REQUIRED_SAMPLE_RATE is CODEC_SAMPLE_RATE, and cannot drift", () => {
    expect(REQUIRED_SAMPLE_RATE).toBe(CODEC_SAMPLE_RATE);
    expect(REQUIRED_SAMPLE_RATE).toBe(48_000);
    // The source is a re-export of the one constant, not a literal.
    expect(audioIo).toContain(
      'import { CODEC_SAMPLE_RATE, CODEC_SAMPLES_PER_FRAME, type SoundChatCodec } from "./codec";',
    );
    expect(audioIo).toContain("export const REQUIRED_SAMPLE_RATE = CODEC_SAMPLE_RATE;");
    // No other copy of the number anywhere in the module.
    const literals = audioIo.match(/REQUIRED_SAMPLE_RATE\s*=\s*[0-9_]+/g) ?? [];
    expect(literals, "REQUIRED_SAMPLE_RATE must not be a literal").toEqual([]);
  });

  it("the harness's pause tail is RX_PAUSE_TAIL_SECONDS", () => {
    expect(page).toContain('import { RX_PAUSE_TAIL_SECONDS } from "../audio-io";');
    expect(page).toContain("const PAUSE_TAIL_MS = RX_PAUSE_TAIL_SECONDS * 1000;");
    // No copied millisecond literal.
    const literals = page.match(/PAUSE_TAIL_MS\s*=\s*[0-9_]+/g) ?? [];
    expect(literals, "PAUSE_TAIL_MS must not be a literal").toEqual([]);
    // The derived value is the measured one.
    expect(RX_PAUSE_TAIL_SECONDS * 1000).toBe(500);
  });

  it("the frame size the harness captures is the codec's", () => {
    expect(CAPTURE_FRAME_SAMPLES).toBe(CODEC_SAMPLES_PER_FRAME);
    expect(CAPTURE_FRAME_SAMPLES).toBe(1024);
  });

  it("the PAIR body is still the 24 bytes the key check needs", () => {
    // F18's sibling: the frame budget is arithmetic, so a change to the salt or
    // challenge width has to be visible here rather than silently overrunning the
    // block.
    expect(PAIR_BODY_BYTES).toBe(24);
    expect(5 + PAIR_BODY_BYTES + 16).toBeLessThanOrEqual(CODEC_PAYLOAD_LENGTH);
  });
});

describe("the matrix as a whole is still internally consistent", () => {
  it("has unique ids, resolvable by `findVariant`, with a full contract each", () => {
    const ids = CHANNEL_MATRIX.map((variant) => variant.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const variant of CHANNEL_MATRIX) {
      expect(findVariant(variant.id)).toBe(variant);
      expect(["decode", "graceful", "silence"]).toContain(variant.expectation);
      expect(variant.payloads.length).toBeGreaterThan(0);
      expect(variant.allowed.length).toBeGreaterThan(0);
      expect(variant.captureMs).toBeGreaterThan(0);
      expect(variant.settleAfterDecodeMs).toBeGreaterThanOrEqual(0);
      expect(["clean", "browser-defaults"]).toContain(variant.profile);
      // A multi-block transmission must never be cut short by the early exit.
      if (variant.payloads.length > 1) {
        expect(variant.settleAfterDecodeMs, `${variant.id} would stop early`).toBe(0);
      }
    }
  });
});
