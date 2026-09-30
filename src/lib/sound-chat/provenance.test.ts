/**
 * Machine-checked artifact provenance (master plan Section 10.1, class 7).
 *
 * The independent verification pass found `NOTICE.md` claiming 147140 bytes for
 * a 147139-byte file: the SHA-256 was right, the hand-typed size was not, and
 * nothing could catch it because only the hash had ever been asserted. Every
 * recorded fact about the vendored artifact is now a test, so the document
 * cannot drift from the bytes again.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ARTIFACT = fileURLToPath(new URL("./vendor/ggwave.js", import.meta.url));
const NOTICE = fileURLToPath(new URL("./vendor/NOTICE.md", import.meta.url));
const LICENSE = fileURLToPath(new URL("./vendor/LICENSE.ggwave", import.meta.url));

const artifact = readFileSync(ARTIFACT);
const notice = readFileSync(NOTICE, "utf8");
const digest = createHash("sha256").update(artifact).digest("hex").toUpperCase();

/** Git's blob id: SHA-1 over `blob <len>\0` + bytes. */
function gitBlobId(bytes: Buffer): string {
  const header = Buffer.from(`blob ${bytes.byteLength}\0`, "utf8");
  return createHash("sha1").update(header).update(bytes).digest("hex");
}

describe("vendored artifact provenance", () => {
  it("matches the size and SHA-256 NOTICE.md records for the patched file", () => {
    const recorded = /Current \(patched\) file: (\d+) bytes,\s*SHA-256 `([0-9A-F]{64})`/.exec(
      notice,
    );
    expect(
      recorded,
      "NOTICE.md must state the patched artifact's byte count and SHA-256",
    ).not.toBeNull();
    const [, size, recordedDigest] = recorded as RegExpExecArray;
    expect(Number(size)).toBe(artifact.byteLength);
    expect(recordedDigest).toBe(digest);
  });

  it("records the patched artifact's git blob id", () => {
    // The unpatched blob id is already in NOTICE.md; the patched one is what a
    // fresh checkout actually has, so it has to be checkable too.
    // Whitespace is normalised: the recorded value wraps across lines.
    const flat = notice.replace(/\s+/g, " ");
    const recorded =
      /patched\) file: \d+ bytes, SHA-256 `[0-9A-F]{64}`, git blob `([0-9a-f]{40})`/.exec(flat);
    expect(recorded, "NOTICE.md must state the patched artifact's git blob id").not.toBeNull();
    expect((recorded as RegExpExecArray)[1]).toBe(gitBlobId(artifact));
  });

  it("carries no dynamic JavaScript execution (the CSP-safe patch)", () => {
    const source = artifact.toString("utf8");
    expect(/\beval\s*\(/.test(source)).toBe(false);
    expect(/\bnew\s+Function\b/.test(source)).toBe(false);
    // `newFunc` survives only as its now-unreferenced declaration: the invoker
    // is built by `createNamedFunction`, never by compiling generated source.
    expect((source.match(/newFunc\s*\(/g) ?? []).length).toBe(1);
    expect(source.includes("createNamedFunction")).toBe(true);
    // The only dynamic-execution-adjacent call left is the wasm instantiation
    // itself, which is exactly what `'wasm-unsafe-eval'` permits.
    expect((source.match(/WebAssembly\.instantiate/g) ?? []).length).toBe(1);
  });

  it("needs no cross-origin isolation: no SharedArrayBuffer, no pthreads", () => {
    // The master plan closes COOP/COEP on this measurement, so it is asserted
    // rather than restated.
    const source = artifact.toString("utf8");
    expect(source).not.toContain("SharedArrayBuffer");
    expect(source.toLowerCase()).not.toContain("pthread");
  });

  it("records the unpatched upstream identity the patch was derived from", () => {
    // These cannot be re-derived here — the research clone is gitignored and its
    // `.git` is gone — so the test's job is to guarantee the numbers are
    // *recorded* and that NOTICE.md admits their verification status.
    expect(notice).toMatch(/Unpatched upstream bytes: 148131 bytes/);
    expect(notice).toMatch(/D5FDB0A11B390D357D67163311C064FFD8CD90476911DCCA3C689A98EA11AB6B/);
    expect(notice).toMatch(/b9ca22672b85ebe916ec7baa344bde983421751c/);
    expect(notice).toMatch(/F4BD5E9E3B79DB9C599D197C83D250E1A514C0295F4856A26065B6E427C252F3/);
    expect(notice).toMatch(/verified once/i);
  });

  it("ships the upstream MIT license text beside it", () => {
    const license = readFileSync(LICENSE);
    expect(license.toString("utf8")).toContain("MIT License");
    expect(license.toString("utf8")).toContain("Georgi Gerganov");
    // NOTICE.md claims byte-identity with upstream's LICENSE and records its
    // blob id. Both are prose today; the blob id at least is checkable here.
    // The pattern is anchored on the LICENSE sentence rather than taking the
    // first `blob` in the file, so reordering NOTICE.md cannot silently make
    // this compare the *patched artifact's* id to the license bytes.
    const recorded = /`LICENSE`, blob `([0-9a-f]{40})`/.exec(notice.replace(/\s+/g, " "));
    expect(recorded, "NOTICE.md must state the license's git blob id").not.toBeNull();
    expect((recorded as RegExpExecArray)[1]).toBe(gitBlobId(license));
  });
});
