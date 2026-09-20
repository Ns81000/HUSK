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

  it("ships the upstream MIT license text beside it", () => {
    const license = readFileSync(LICENSE, "utf8");
    expect(license).toContain("MIT License");
    expect(license).toContain("Georgi Gerganov");
  });
});
