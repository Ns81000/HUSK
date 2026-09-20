/**
 * Loading the vendored ggwave artifact, in the one way that works per
 * environment. Measured, not assumed — see `prompts/sound-chat/SOUND_CHAT_LOG.md`.
 *
 * The artifact is UMD (deep dive §2.1-2.2): a top-level
 * `var ggwave_factory = (() => { ... })()` followed by
 * `if (typeof exports === 'object' && typeof module === 'object')
 *    module.exports = ggwave_factory;`. Node loads that as CommonJS (the
 * co-located `vendor/package.json` says `"type": "commonjs"`), so the factory
 * arrives as the module's `default`.
 *
 * A browser does not. Measured in Chromium against the Vite dev server: the
 * artifact is served verbatim as an ES module (it contains no `import`/`export`
 * of its own), so the `module.exports` branch never runs and the namespace is
 * empty — `Object.keys(mod) = []`, `typeof mod.default === "undefined"`. The
 * factory is module-scoped there and unreachable by `import()`.
 *
 * Adding an `export` to the artifact would fix the browser and break Node
 * (`export` is a syntax error in a `"type": "commonjs"` file), and the vendored
 * file's SHA-256 is meant to stay upstream's. So the browser loads it exactly
 * the way upstream's own browser example does: as a classic `<script>`, which
 * puts the top-level `var` on `window`.
 *
 * `?url` (rather than a plain import) keeps the 148 KB artifact out of the JS
 * module graph: Vite emits it as its own hashed file under `/assets/*` and only
 * the URL string lands in this chunk.
 *
 * This file deliberately lives *outside* `vendor/`: anything inside that folder
 * inherits its `"type": "commonjs"`, which would make `import.meta` a syntax
 * error for Node-based tooling (Playwright's test loader) reading the `.ts`.
 */

import codecUrl from "./vendor/ggwave.js?url";
import type { GgwaveFactory, GgwaveModule } from "./vendor/ggwave";

/** The global the UMD artifact's top-level `var` creates in a classic script. */
type FactoryGlobal = { ggwave_factory?: unknown };

let factory: Promise<GgwaveFactory> | undefined;

function isFactory(value: unknown): value is GgwaveFactory {
  return typeof value === "function";
}

/** Browser path: inject the artifact as a classic script, then take the global. */
function loadViaScriptTag(url: string): Promise<GgwaveFactory> {
  const existing = (globalThis as FactoryGlobal).ggwave_factory;
  if (isFactory(existing)) return Promise.resolve(existing);

  return new Promise<GgwaveFactory>((resolve, reject) => {
    const script = document.createElement("script");
    script.src = url;
    script.async = true;
    script.addEventListener("load", () => {
      const loaded = (globalThis as FactoryGlobal).ggwave_factory;
      if (isFactory(loaded)) resolve(loaded);
      else reject(new Error(`the sound codec at ${url} loaded but defined no factory`));
    });
    script.addEventListener("error", () =>
      reject(new Error(`the sound codec at ${url} failed to load`)),
    );
    document.head.append(script);
  });
}

/** Node path (Vitest, any server-side use): the artifact is CommonJS there. */
async function loadViaRequire(): Promise<GgwaveFactory> {
  const { createRequire } = await import("node:module");
  const nodeRequire = createRequire(import.meta.url);
  const loaded = nodeRequire("./vendor/ggwave.js") as GgwaveFactory | { default: GgwaveFactory };
  return isFactory(loaded) ? loaded : loaded.default;
}

/**
 * The resolved factory, cached for the page session: the module is instantiated
 * once and its instances are held for the whole session (master plan Section 3).
 */
export async function loadGgwaveModule(): Promise<GgwaveModule> {
  factory ??= typeof document === "undefined" ? loadViaRequire() : loadViaScriptTag(codecUrl);
  const create = await factory;
  return create();
}
