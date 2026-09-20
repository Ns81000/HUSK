import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { defineConfig } from "vite";

/**
 * Build config for the Phase 0 harness page only. It is deliberately separate
 * from the app's `vite.config.ts` (which is off limits): it uses the same Vite
 * install, so whatever it emits here about chunking and CommonJS interop is
 * what the app's own build will do with the vendored codec.
 */

const here = fileURLToPath(new URL(".", import.meta.url));
// harness -> sound-chat -> lib -> src -> repo root
const repoRoot = resolve(here, "../../../..");

export default defineConfig({
  root: here,
  base: "./",
  build: {
    outDir: resolve(repoRoot, "test-results/sound-chat-harness"),
    emptyOutDir: true,
    target: "es2022",
    sourcemap: false,
    minify: true,
  },
});
