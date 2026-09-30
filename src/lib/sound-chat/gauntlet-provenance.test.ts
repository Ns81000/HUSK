/**
 * Phase 4 Gauntlet, category BUILD / OPS / ARTIFACT.
 *
 * The three facts below are the master plan's serving claims that only prose
 * asserts today: that the vendored codec is emitted under `/assets/*` and
 * therefore inherits the immutable long-cache rule "for free", and that
 * `/sound-chat` navigations plus the codec asset behave as `public/sw.js`
 * predicts. Nothing machine-checked any of them, so a change to `public/_headers`
 * or `public/sw.js` that quietly dropped the rule, or that started caching
 * `/sound-chat`, would have been invisible to the test suite.
 *
 * Scope note, because it is the honest limit of what a unit test can say here:
 * these are *static* checks of the source of truth. The end-to-end facts the
 * Phase 5 checklist asks for — a real 200 on `/sound-chat` and a real
 * `Cache-Control: public, max-age=31536000, immutable` on
 * `/assets/ggwave-*.js` as actually served — are verified by reading the
 * generated `.output/public/_headers` after `pnpm run build` and by issuing real
 * requests against a running build, not from here. `pnpm run preview` cannot
 * serve that check on this repo today: the TanStack Start preview-server plugin
 * looks for `dist/server/server.js` while the build emits `.output/server/`, so
 * `vite preview` answers 500 and then exits.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/** Repository root, from `src/lib/sound-chat/`. */
const REPO = new URL("../../../", import.meta.url);

function repoText(relative: string): string {
  return readFileSync(new URL(relative, REPO), "utf8");
}

/**
 * The body of the `_headers` block introduced by exactly `pattern`.
 *
 * `_headers` is line-oriented, not blank-line-separated: `public/_headers` puts
 * the `/*` catch-all directly above `/assets/*` with no blank line between them,
 * so the block boundary is "the next line starting at column 0 with a slash".
 * An exact `indexOf` on the pattern also means a narrowed `/assets/*.js` would
 * not be mistaken for the wildcard rule.
 */
function headerBlock(headers: string, pattern: string): string {
  const lines = headers.split("\n");
  const start = lines.indexOf(pattern);
  if (start === -1) return "";
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => line.startsWith("/"));
  return (end === -1 ? rest : rest.slice(0, end)).join("\n");
}

describe("the codec is served as an immutable /assets/* asset", () => {
  it("has a public/_headers rule that gives every /assets/* response the immutable cache", () => {
    // The plan's claim is that the codec needs no new header of its own: it
    // lands under /assets/* and inherits this rule. If the rule is renamed,
    // narrowed to /assets/*.js, or its max-age shortened, this fails — which is
    // the point, because the codec's caching then silently regresses.
    const block = headerBlock(repoText("public/_headers"), "/assets/*");
    expect(block, "public/_headers must have an /assets/* block").not.toBe("");
    expect(block.replace(/\s+/g, " ").toLowerCase()).toContain(
      "cache-control: public, max-age=31536000, immutable",
    );
  });

  it("is not shadowed by a later, shorter-lived rule for the same path", () => {
    // `no-cache` does appear in this file, for `/sw.js` and
    // `/manifest.webmanifest`, which is correct and unrelated. What must not
    // exist is a `no-cache` (or shorter `max-age`) block of its own for
    // `/assets/*`, because the later block would win and the codec would be
    // revalidated on every visit. There is none today.
    const headers = repoText("public/_headers");
    expect(headers).not.toMatch(/^\/assets\/[^*\s]/m);
    expect(headerBlock(headers, "/assets/*")).not.toMatch(/no-cache/i);
  });
});

describe("the loader keeps the artifact out of the JavaScript module graph", () => {
  it("reaches it as a ?url asset", () => {
    // `?url` is what makes Vite emit a separate hashed file instead of inlining
    // 147 KB into whichever chunk imports the loader. Dropping the suffix would
    // move the codec back into the bundle without any other test noticing.
    expect(repoText("src/lib/sound-chat/load-ggwave.ts")).toContain(
      'from "./vendor/ggwave.js?url"',
    );
  });

  it("never takes a bare specifier for the artifact", () => {
    // A value import of the UMD file would be a second, bundler-parsed copy of
    // the same bytes. There must be exactly one specifier, and it is the `?url`.
    const specifiers = repoText("src/lib/sound-chat/load-ggwave.ts").match(
      /from\s+"\.\/vendor\/ggwave\.js[^"]*"/g,
    );
    expect(specifiers).toHaveLength(1);
  });
});

describe("the service worker's predictions for Sound Chat", () => {
  it("serves /assets/* cache-first into a separate bundle cache, so the codec survives one visit", () => {
    // This is the whole reason the codec is offline-tolerant: the first fetch
    // of /assets/ggwave-*.js is written to BUNDLE_CACHE and every later one is
    // answered from it. `cacheFirst` (not a network-first helper) is the load
    // bearing token here.
    const sw = repoText("public/sw.js");
    expect(sw).toContain("const BUNDLE_CACHE =");
    expect(sw).toMatch(
      /url\.pathname\.startsWith\("\/assets\/"\)[\s\S]{0,80}cacheFirst\(request,\s*BUNDLE_CACHE\)/,
    );
    expect(sw).toMatch(
      /function cacheFirst\([\s\S]*?caches\.match\(request\)[\s\S]*?cache\.put\(request/,
    );
  });

  it("leaves every navigation but / to the network, so /sound-chat is never cached", () => {
    // The honest consequence, stated as a test rather than left to be guessed:
    // an installed PWA can open "/" offline and still shows a Sound Chat button
    // that cannot be followed offline, because the navigate branch returns for
    // any pathname other than "/". That asymmetry is by design (room pages are
    // per-request SSR state) — but it is a decision, so it is pinned here and
    // any change to it has to be deliberate.
    const sw = repoText("public/sw.js");
    expect(sw).toMatch(/request\.mode === "navigate"[\s\S]{0,80}url\.pathname !== "\/"/);
    expect(sw).not.toContain("/sound-chat");
  });

  it("pre-caches no Sound Chat asset", () => {
    const precache = /const PRECACHE_URLS = \[([\s\S]*?)\];/.exec(repoText("public/sw.js"));
    expect(precache?.[1] ?? "").not.toContain("sound-chat");
  });
});
