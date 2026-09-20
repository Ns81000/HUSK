import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, devices } from "@playwright/test";

/**
 * Playwright config for the Sound Chat Phase 0 fake-microphone harness.
 * Deliberately separate from the repo's `playwright.config.ts` (which is off
 * limits): this one runs the matrix in `src/lib/sound-chat/harness/` against the
 * Vite dev server, with `channel: "chromium"` so the tests use the full
 * Chromium build rather than the headless shell — the fake audio capture device
 * lives in the full build.
 */

const here = fileURLToPath(new URL(".", import.meta.url));
const repoRoot = resolve(here, "../../../..");

export default defineConfig({
  timeout: 60_000,
  workers: 2,
  fullyParallel: false,
  reporter: [["list"]],
  outputDir: resolve(repoRoot, "test-results/sound-chat-harness/pw"),
  use: {
    viewport: { width: 1280, height: 720 },
  },
  webServer: {
    command: "pnpm dev",
    url: "http://localhost:3000/",
    reuseExistingServer: true,
    timeout: 120_000,
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"], channel: "chromium" } }],
});
