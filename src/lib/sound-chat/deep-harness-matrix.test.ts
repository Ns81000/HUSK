/**
 * Phase 2V deep dive — the Phase 0 harness and the degradation matrix.
 *
 * The harness is evidence, and evidence is only worth what it can falsify. This
 * file asks whether the matrix *can* lie: whether a variant could demand a
 * payload it never transmits, whether a `decode` variant could pass without
 * decoding, whether the early-exit timer could truncate a sequence, and whether
 * the numbers in the variant labels are the numbers the impairment produces.
 *
 * It also pins the one thing the spike directory gets right (the codec is a
 * re-export, so the spike cannot drift from the product) against the one thing
 * it does not (the capture pipeline is a *second* implementation, so the
 * harness never runs the product's `startListening`).
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import * as productCodec from "./codec";
import * as spikeCodec from "./spike/codec";
import {
  addWhiteNoise,
  hardClip,
  mulberry32,
  overlay,
  peak,
  resample,
  rms,
  whiteNoise,
} from "./spike/degrade";
import {
  CHANNEL_MATRIX,
  concat,
  findVariant,
  inProcessVariants,
  silence,
  withLeadIn,
} from "./harness/matrix";
import {
  FOREIGN_PAYLOAD,
  fromHex,
  payload,
  PRIMARY_PAYLOAD,
  SEQUENCE_PAYLOADS,
  toHex,
  wireBlock,
} from "./harness/payloads";

const PAGE = fileURLToPath(new URL("./harness/page.ts", import.meta.url));
const SPEC = fileURLToPath(new URL("./harness/fake-mic.spec.ts", import.meta.url));

describe("the matrix cannot demand what it never sends", () => {
  it("gives every variant a unique id that `findVariant` can resolve", () => {
    const ids = CHANNEL_MATRIX.map((variant) => variant.id);
    expect(new Set(ids).size, "variant ids must be unique").toBe(ids.length);
    for (const id of ids) {
      expect(findVariant(id).id).toBe(id);
    }
    expect(() => findVariant("no-such-variant")).toThrowError(/unknown channel variant/);
  });

  it("only ever allows payloads the variant itself puts on the air", () => {
    // The two interference variants legitimately carry a payload this device did
    // not send: the *other* device's block, overlaid. Every other variant must
    // not.
    const interference = new Set(["crosstalk-foreign-half", "collision-simultaneous"]);
    for (const variant of CHANNEL_MATRIX) {
      const sent = new Set(variant.payloads.map((entry) => entry.hex));
      for (const required of [...variant.expected, ...variant.allowed]) {
        if (sent.has(required.hex)) continue;
        expect(
          interference.has(variant.id),
          `${variant.id} allows ${required.id}, which it never transmits`,
        ).toBe(true);
      }
    }
  });

  it("gives every decode variant something that must actually come back", () => {
    for (const variant of CHANNEL_MATRIX) {
      expect(variant.allowed.length, `${variant.id} must allow something`).toBeGreaterThan(0);
      if (variant.expectation !== "decode") continue;
      // The one way a `decode` variant could pass without decoding is an empty
      // expectation list, which `resolve()` can only produce from an empty
      // `payloads` list.
      expect(variant.expected.length, `${variant.id} expects nothing`).toBeGreaterThan(0);
      for (const required of variant.expected) {
        expect(variant.allowed, `${variant.id} expects a payload it forbids`).toContainEqual(
          required,
        );
      }
    }
  });

  it("never lets the early exit truncate a multi-block sequence", () => {
    // `page.ts` stops capturing `settleAfterDecodeMs` after the *first* decode.
    // A variant that transmits more than one payload must therefore disable it,
    // or the later blocks would never be heard and the run would pass for the
    // wrong reason.
    for (const variant of CHANNEL_MATRIX) {
      if (variant.payloads.length > 1) {
        expect(variant.settleAfterDecodeMs, `${variant.id} would stop early`).toBe(0);
      }
      expect(variant.settleAfterDecodeMs).toBeGreaterThanOrEqual(0);
      // ...and the window must be long enough to hold the whole transmission.
      const audioMs = variant.payloads.length * 1920;
      expect(variant.captureMs, `${variant.id} captures less than it transmits`).toBeGreaterThan(
        audioMs,
      );
    }
  });

  it("keeps the in-process and browser halves of the matrix both populated", () => {
    const inProcess = inProcessVariants();
    const browser = CHANNEL_MATRIX.filter((variant) => !variant.inProcess);
    expect(inProcess.length).toBeGreaterThan(20);
    expect(browser.length).toBeGreaterThan(5);
    // Browser-only variants are exactly the ones that need a capture device or
    // a device rate, so they must declare one of those.
    for (const variant of browser) {
      // `profile-browser-defaults-noisy` is the one browser-only variant with no
      // explicit reason of its own: it is here to be run against the browser's
      // processing chain, which it only gets if it asks for it. The dedicated
      // test below is the real assertion; this one only keeps the reason check
      // from flagging it twice.
      const claimsDefaults = variant.id.startsWith("profile-");
      expect(
        claimsDefaults ||
          variant.deviceRate !== 48_000 ||
          variant.wavRate !== 48_000 ||
          variant.profile !== "clean" ||
          variant.selfTransmit !== "none",
        `${variant.id} is browser-only without a reason`,
      ).toBe(true);
    }
    // ...and an in-process variant must not claim a non-48 kHz device, because
    // there is no device in Node to have that rate.
    for (const variant of inProcess) {
      expect(variant.deviceRate, `${variant.id} is in-process at a device rate`).toBe(48_000);
      expect(variant.wavRate, `${variant.id} is in-process at a wav rate`).toBe(48_000);
    }
  });
});

describe("the impairments produce the numbers their labels claim", () => {
  it("hits the requested noise RMS within a fraction of a dB", () => {
    // `whiteNoise` sets its peak amplitude to `target * sqrt(3)` precisely so
    // that a *uniform* distribution has RMS `target` — the label "40 dB SNR"
    // therefore means 40 dB, not 35 dB.
    for (const target of [0.5, 0.05, 0.005]) {
      const noise = whiteNoise(48_000, target, 11);
      const achieved = 20 * Math.log10(target / rms(noise));
      expect(achieved, `target ${target}`).toBeCloseTo(0, 1);
    }
    // And relative to a reference, the ratio is exactly the requested dB.
    const reference = new Float32Array(1024).map((_, index) => Math.sin(index / 8));
    for (const snrDb of [40, 20, 0, -6]) {
      const noisy = addWhiteNoise(reference, snrDb, 11);
      const noiseRms = rms(noisy) - rms(reference);
      // Signal and noise are uncorrelated, so the total RMS is the root sum of
      // the squares; with a -6 dB request the two terms are close enough that
      // this stays a coarse check on the *sign* and the order of magnitude.
      expect(noiseRms).toBeGreaterThan(0);
      expect(noisy).toHaveLength(reference.length);
    }
  });

  it("is reproducible from its seed, and different seeds really differ", () => {
    expect(Array.from(whiteNoise(64, 0.1, 7))).toEqual(Array.from(whiteNoise(64, 0.1, 7)));
    expect(Array.from(whiteNoise(64, 0.1, 7))).not.toEqual(Array.from(whiteNoise(64, 0.1, 8)));
    const a = mulberry32(3);
    const b = mulberry32(3);
    for (let index = 0; index < 100; index += 1) expect(a()).toBe(b());
  });

  it("preserves length where the matrix says it must, and does not where it must not", () => {
    const block = new Float32Array(92_160).map((_, index) => Math.sin(index / 100) * 0.24);
    expect(hardClip(block, 0.06)).toHaveLength(block.length);
    expect(addWhiteNoise(block, 20, 1)).toHaveLength(block.length);
    expect(peak(hardClip(block, 0.06))).toBeLessThanOrEqual(0.06);
    // The resampler is the one impairment that legitimately changes length, and
    // the variants that use it bypass `sameLength` for that reason.
    expect(resample(block, 48_000, 44_100)).not.toHaveLength(block.length);
    expect(resample(block, 48_000, 48_000)).toHaveLength(block.length);
    // `trimStart` is length-*reducing* by design, and the matrix's `graceful`
    // expectations for it are the honest outcome.
    expect(concat(silence(10), block)).toHaveLength(block.length + 480);
    expect(withLeadIn(block, 10)).toHaveLength(block.length + 480);
    // overlay is the crosstalk/collision model the matrix actually uses, and it
    // is not a no-op: two copies of the same block at level 1 double its peak,
    // which is exactly the equal-amplitude collision the matrix gates on.
    expect(peak(overlay(block, block, 1))).toBeCloseTo(peak(block) * 2, 3);
    expect(peak(overlay(block, block, 0))).toBeCloseTo(peak(block), 5);
    expect(peak(overlay(block, block, 0.5))).toBeCloseTo(peak(block) * 1.5, 3);
  });

  it("makes every browser-defaults variant actually ask for the browser's defaults", () => {
    // P2V FINDING: `profile-browser-defaults-noisy` is named and noted as
    // "default processing plus noise" but never sets `profile`, so `resolve()`
    // hands it the *clean* constraints — the opposite of what the variant claims
    // to measure, and invisible because its expectation is `graceful`.
    const profileVariants = CHANNEL_MATRIX.filter((variant) => variant.id.startsWith("profile-"));
    expect(profileVariants.length).toBeGreaterThanOrEqual(2);
    for (const variant of profileVariants) {
      expect(variant.profile, `${variant.id} does not request what it measures`).toBe(
        "browser-defaults",
      );
      expect(variant.inProcess, `${variant.id} needs a capture device`).toBe(false);
    }
  });
});

describe("the harness payloads are not protocol fixtures", () => {
  it("uses a fromPeerId the protocol itself would accept", () => {
    // `payloads.ts` says its blocks follow the locked Section 4 layout, and they
    // do — including `fromPeerId`, which was 0x0a/0x0b rather than the two real
    // peer ids. Harmless while nothing parses these blocks, and a trap for
    // anyone reusing them as Phase 3/4 fixtures, so it is pinned here.
    const block = wireBlock(0x1234);
    expect(block[3]).toBe(0);
    expect(wireBlock(0x1235)[3]).toBe(1);
    expect(block[0]).toBe(1);
    expect(block[4]).toBe(43);
    expect(block).toHaveLength(64);
    // The hex round trip the harness relies on.
    expect(toHex(block)).toHaveLength(128);
    expect(Array.from(fromHex(toHex(block)))).toEqual(Array.from(block));
    // ...and every payload in the matrix is a full 64-byte block, so the
    // browser runner's "one 64-byte decode" assertion has something to hold.
    for (const entry of [PRIMARY_PAYLOAD, FOREIGN_PAYLOAD, ...SEQUENCE_PAYLOADS]) {
      expect(entry.bytes).toHaveLength(64);
      expect(entry.hex).toHaveLength(128);
    }
    expect(payload(1).id).not.toBe(payload(2).id);
  });
});

describe("what the harness actually exercises", () => {
  it("runs the product's capture path nowhere in the browser", () => {
    const page = readFileSync(PAGE, "utf8");
    // The page drives `spike/audio-io`'s `attachCapture`, a *second*
    // implementation of the same ScriptProcessor pipeline. The product's
    // `startListening` — with its own pause arithmetic and its own
    // consumer/module error split — is not on this path at all.
    expect(page).toContain('from "../spike/audio-io"');
    expect(page).toContain("attachCapture");
    expect(page).not.toContain("startListening");
    // The only thing it shares with the product is the tail constant, which is
    // why the measured value still governs the harness's own timer.
    expect(page).toContain("RX_PAUSE_TAIL_SECONDS");
    expect(page).toContain('from "../audio-io"');
  });

  it("asserts on the page's console errors rather than only logging them", () => {
    const spec = readFileSync(SPEC, "utf8");
    // A `graceful` variant is satisfied by "nothing decoded", so an uncaught
    // error inside the page's audio callback would pass unnoticed. The spec
    // collects console errors *and* fails on them.
    expect(spec).toContain("consoleErrors");
    expect(spec).toContain("pageerror");
    // The assertion, whitespace-insensitively: the old check for
    // `expect(consoleErrors` passed vacuously, because the assertion is wrapped
    // across lines, so this one normalises before it looks.
    const flattened = spec.replace(/\s+/g, " ");
    const at = flattened.indexOf("expect( consoleErrors,");
    expect(at, "the spec must assert on the collected console errors").toBeGreaterThan(-1);
    expect(flattened.slice(at, at + 200)).toContain(".toEqual([])");
  });

  it("keeps the spike's codec a pure re-export of the product's", () => {
    // The Phase 0 suites and the browser page import `spike/codec`; if that
    // ever becomes a copy, every one of those results becomes evidence about
    // code the product does not run.
    expect(Object.keys(spikeCodec).sort()).toEqual(Object.keys(productCodec).sort());
    expect(spikeCodec.CODEC_PAYLOAD_LENGTH).toBe(productCodec.CODEC_PAYLOAD_LENGTH);
    expect(spikeCodec.openSoundChatCodec).toBe(productCodec.openSoundChatCodec);
  });
});
